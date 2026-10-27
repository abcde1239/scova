import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, expect, it } from 'vite-plus/test';
import { nodeScriptCommand } from '../../../scripts/process-runtime.mjs';
import { outboxDatabase } from '../../worker/tests/support/outbox-database.ts';
import { seedRun } from '../../worker/tests/support/run-database.ts';
import { csrfForSession, tokenHash } from '../src/utils/security.ts';

const fixture = outboxDatabase();
const db = fixture.db;
beforeAll(() => fixture.setup(), 120_000);
afterAll(() => fixture.cleanup());
const bun =
    process.env.BUN_BIN ??
    join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
async function port() {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const value = server.address();
    if (!value || typeof value === 'string') throw new Error('无可用测试端口');
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return value.port;
}
async function seed() {
    const s = await seedRun(db);
    const token = randomBytes(32).toString('base64url');
    await db.session.create({
        data: {
            userId: s.user.id,
            tokenHash: tokenHash(token),
            csrfTokenHash: tokenHash(csrfForSession(token)),
            expiresAt: new Date(Date.now() + 120_000),
        },
    });
    return { ...s, cookie: `scova_session=${token}` };
}
type Stats = { reads: number; opened: number; closed: number };
async function launch(runtime: 'bun' | 'node') {
    if (runtime === 'bun' && !existsSync(bun)) throw new Error('设置BUN_BIN为独立Bun路径');
    const number = await port();
    const command =
        runtime === 'bun'
            ? { executable: bun, args: ['run', 'tests/support/sse-process.ts'] }
            : nodeScriptCommand('tests/support/sse-process.ts');
    const child = spawn(command.executable, command.args, {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
            ...process.env,
            DATABASE_URL: fixture.databaseUrl,
            PORT: String(number),
            SCOVA_SSE_TEST_RUNTIME: runtime,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    let output = '';
    child.stdout!.on('data', (chunk) => {
        output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
        output += String(chunk);
    });
    const ended = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
    });
    void ended.catch(() => undefined);
    const base = `http://127.0.0.1:${number}`;
    async function stats(): Promise<Stats> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.off('message', receive);
                reject(new Error(`进程遥测超时: ${output}`));
            }, 3000);
            function receive(message: unknown) {
                if (
                    typeof message === 'object' &&
                    message !== null &&
                    'type' in message &&
                    message.type === 'sse:stats'
                ) {
                    clearTimeout(timer);
                    child.off('message', receive);
                    const stats = message as unknown as Stats;
                    resolve({ reads: stats.reads, opened: stats.opened, closed: stats.closed });
                }
            }
            child.on('message', receive);
            child.send({ type: 'sse:stats' });
        });
    }
    async function until(check: () => Promise<boolean>) {
        const deadline = Date.now() + 10_000;
        while (!(await check())) {
            if (child.exitCode !== null || Date.now() > deadline)
                throw new Error(`SSE进程等待失败: ${output}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    try {
        await until(async () => {
            try {
                return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).ok;
            } catch {
                return false;
            }
        });
    } catch (error) {
        child.kill();
        throw error;
    }
    return {
        child,
        base,
        stats,
        until,
        async stop() {
            if (child.connected) child.send('scova:shutdown');
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const code = await Promise.race([
                    ended,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`进程未退出: ${output}`)), 5000);
                    }),
                ]);
                expect(code, output).toBe(0);
                await expect(
                    fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }),
                ).rejects.toThrow();
            } finally {
                clearTimeout(timer);
                if (child.exitCode === null) child.kill();
            }
        },
    };
}
function frames(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let buffer = '';
    const decoder = new TextDecoder();
    return async () => {
        while (!buffer.includes('\n\n')) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('事件流提前结束');
            buffer += decoder.decode(chunk.value, { stream: true });
        }
        const end = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return frame;
    };
}

describe('Bun 与 Node 真实 SSE socket', () => {
    it.each(['bun', 'node'] as const)(
        '%s持续续传、取消清理与带活跃SSE优雅关闭',
        async (runtime) => {
            const s = await seed();
            const server = await launch(runtime);
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            try {
                const response = await fetch(`${server.base}/api/v1/runs/${s.run.id}/events`, {
                    headers: { cookie: s.cookie },
                });
                expect(response.headers.get('content-type')).toContain('text/event-stream');
                reader = response.body!.getReader();
                const frame = frames(reader);
                expect(await frame()).toContain('"seq":1');
                await db.runEvent.create({
                    data: {
                        userId: s.user.id,
                        runId: s.run.id,
                        seq: 2,
                        type: 'step.started',
                        payload: { step: 'search' },
                    },
                });
                let next = await frame();
                while (next.startsWith(':')) next = await frame();
                expect(next).toContain('"seq":2');
                await reader.cancel();
                reader = undefined;
                await server.until(async () => (await server.stats()).closed === 1);
                const before = (await server.stats()).reads;
                await new Promise((resolve) => setTimeout(resolve, 70));
                expect((await server.stats()).reads).toBe(before);
                const active = await fetch(
                    `${server.base}/api/v1/runs/${s.run.id}/events?after=2`,
                    {
                        headers: { cookie: s.cookie },
                    },
                );
                reader = active.body!.getReader();
                const heartbeat = await frames(reader)();
                expect(heartbeat).toBe(': heartbeat');
                await server.stop();
            } finally {
                await reader?.cancel().catch(() => undefined);
                if (server.child.exitCode === null) await server.stop();
            }
        },
    );

    it.each(['bun', 'node'] as const)('%s慢socket背压断开且不继续拉数据库页', async (runtime) => {
        const s = await seed();
        await db.runEvent.createMany({
            data: Array.from({ length: 300 }, (_, index) => ({
                userId: s.user.id,
                runId: s.run.id,
                seq: index + 2,
                type: 'tool.started',
                payload: { toolCallId: s.run.id, tool: 'search', summary: 'x'.repeat(60_000) },
            })),
        });
        const server = await launch(runtime);
        const request = httpRequest(`${server.base}/api/v1/runs/${s.run.id}/events`, {
            headers: { cookie: s.cookie },
        });
        request.on('error', () => undefined);
        let response: import('node:http').IncomingMessage | undefined;
        try {
            response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
                request.once('response', resolve);
                request.once('error', reject);
                request.end();
            });
            response.pause();
            response.on('error', () => undefined);
            await server.until(async () => (await server.stats()).closed === 1);
            const stats = await server.stats();
            expect(stats.opened).toBe(1);
            expect(stats.reads).toBeLessThanOrEqual(4);
            await new Promise((resolve) => setTimeout(resolve, 70));
            expect((await server.stats()).reads).toBe(stats.reads);
        } finally {
            response?.destroy();
            request.destroy();
            await server.stop();
        }
    });
});
