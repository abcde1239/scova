import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeScriptCommand } from '../../../../scripts/process-runtime.mjs';
import type { testWorkerExecution } from '../support/worker-execution.ts';

type Runtime = 'node' | 'bun';

export function launchAgent(
    runtime: Runtime,
    phase: 'crash' | 'resume',
    runId: string,
    boundary: 'search' | 'read',
    execution: Awaited<ReturnType<typeof testWorkerExecution>>,
    options: { deliver?: boolean } = {},
) {
    const bun =
        process.env.BUN_BIN ??
        join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (runtime === 'bun' && !existsSync(bun))
        throw new Error('Recovery tests require the standalone Bun runtime');
    const script = 'tests/support/agent-process.ts';
    const args = [phase, runId, boundary, ...(options.deliver ? ['--deliver'] : [])];
    const command =
        runtime === 'bun'
            ? { executable: bun, args: ['--no-env-file', script, ...args] }
            : nodeScriptCommand(script, args);
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        WORKER_EXECUTION_URL: execution.url,
        WORKER_EXECUTION_TOKEN: execution.token,
    };
    delete env.DATABASE_URL;
    delete env.SCOVA_TEST_DATABASE_URL;
    delete env.RUNTIME_DATABASE_URL;
    delete env.AGENT_CREDENTIAL_KEY;
    delete env.SCOVA_SQLITE_STATE_PATH;
    const child = spawn(command.executable, command.args, {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    });
    const messages: {
        type: string;
        kind?: string;
        reportId?: string;
        candidate?: { runId: string; pages: unknown[]; mode: string };
    }[] = [];
    let output = '';
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('message', (value) => {
        if (
            typeof value === 'object' &&
            value !== null &&
            'type' in value &&
            typeof value.type === 'string'
        )
            messages.push(value as (typeof messages)[number]);
    });
    child.stdout!.on('data', (chunk) => {
        output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
        output += String(chunk);
    });
    const ended = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            exit = { code, signal };
            resolve();
        });
    });
    void ended.catch(() => undefined);
    return {
        child,
        messages,
        ended,
        get output() {
            return output;
        },
        get exit() {
            return exit;
        },
    };
}

export async function waitAgentMessage(process: ReturnType<typeof launchAgent>, type: string) {
    const deadline = Date.now() + 20_000;
    while (!process.messages.some((message) => message.type === type)) {
        if (process.exit || process.messages.some((message) => message.type === 'error'))
            throw new Error(`Agent exited before ${type}: ${process.output}`);
        if (Date.now() >= deadline)
            throw new Error(`Timed out waiting for ${type}: ${process.output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

export async function endAgent(process: ReturnType<typeof launchAgent>, force = false) {
    if (force && !process.exit) process.child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            process.ended,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    process.child.kill('SIGKILL');
                    reject(new Error(`Agent did not exit: ${process.output}`));
                }, 8_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
