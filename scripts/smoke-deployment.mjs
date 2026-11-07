import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Opt-in acceptance owns fresh Compose projects and removes only their containers/volumes.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'scova-deployment-'));
const project = `scova-accept-${randomUUID().slice(0, 8)}`;
const restoreProject = `${project}-restore`;
const server = createServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const env = {
    ...process.env,
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    SCOVA_PORT: String(port),
    SCOVA_BIND: '127.0.0.1',
    APP_ORIGIN: origin,
    REGISTRATION_ENABLED: 'true',
    MODEL_API_KEY: '',
    MODEL_NAME: '',
    MODEL_BASE_URL: '',
    TAVILY_API_KEY: '',
};
const overrides = new Map();
for (const name of [project, restoreProject]) {
    const path = join(directory, `${name}.json`);
    await writeFile(
        path,
        JSON.stringify({
            services: Object.fromEntries(
                ['api', 'worker', 'migrate', 'operations', 'proxy'].map((service) => [
                    service,
                    { image: `${project}-${service === 'proxy' ? 'web' : 'backend'}:test` },
                ]),
            ),
            volumes: {
                backups: {
                    name: `${project}-backups`,
                    ...(name === restoreProject ? { external: true } : {}),
                },
            },
        }),
    );
    overrides.set(name, path);
}
async function compose(name, args) {
    console.log(`[${name}] ${args.join(' ')}`);
    await exec(
        'docker',
        [
            'compose',
            '--env-file',
            join(root, '.env.example'),
            '-p',
            name,
            '-f',
            join(root, 'compose.yaml'),
            '-f',
            overrides.get(name),
            ...args,
        ],
        { cwd: root, env, timeout: 900_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
}
let session;
async function request(path, method = 'GET', body, headers = {}, auth = session) {
    const response = await fetch(origin + path, {
        method,
        headers: {
            origin,
            'content-type': 'application/json',
            ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}),
            ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response;
}
async function account() {
    const credentials = {
        email: `${randomUUID()}@example.test`,
        password: randomBytes(24).toString('hex'),
    };
    await request(
        '/api/v1/auth/register',
        'POST',
        { ...credentials, defaultTimezone: 'UTC' },
        {},
        null,
    );
    const login = await request('/api/v1/auth/login', 'POST', credentials, {}, null);
    const cookie = login.headers.get('set-cookie');
    assert(cookie?.includes('HttpOnly') && cookie.includes('Secure'));
    return { cookie: cookie.split(';')[0], csrf: (await login.json()).csrfToken };
}
async function webRouting() {
    let index;
    for (const path of ['/', '/tasks', '/reports/00000000-0000-4000-8000-000000000001']) {
        const response = await request(path);
        assert(response.headers.get('content-type')?.includes('text/html'));
        assert.equal(response.headers.get('cache-control'), 'no-cache');
        const html = await response.text();
        assert(html.includes('<div id="app"></div>'));
        if (index === undefined) index = html;
        else assert.equal(html, index, `${path} must return the same SPA entry`);
    }
    const assets = [...index.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
        (match) => match[1],
    );
    assert(assets.some((path) => path.endsWith('.js')));
    assert(assets.some((path) => path.endsWith('.css')));
    for (const path of assets) {
        const response = await request(path);
        assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        assert(!response.headers.get('content-type')?.includes('text/html'));
        assert((await response.arrayBuffer()).byteLength > 0);
    }
    for (const path of ['/assets/missing-file.js', '/assets/missing-file', '/missing-file.css']) {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 404, path);
        assert(!(await response.text()).includes('<div id="app"></div>'), path);
    }
    for (const path of ['/api', '/api/v1/unknown', '/api/v1/missing.json']) {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 404, path);
        assert(response.headers.get('content-type')?.includes('application/json'), path);
        assert(!response.headers.get('cache-control')?.includes('immutable'));
        assert.equal((await response.json()).code, 'NOT_FOUND');
    }
    assert((await (await request('/health')).json()).status === 'ok');
    assert((await (await request('/swagger')).text()).includes('html'));
    assert((await (await request('/swagger/json')).json()).openapi);
    console.log(
        JSON.stringify({
            check: 'web-routing',
            spaRoutes: 3,
            staticAssets: assets.length,
            missingAssets: 3,
            unknownApi: 3,
            metadata: ['health', 'swagger', 'swagger/json'],
        }),
    );
}
const streams = new Set();
async function openEvents(runId, auth, lastEventId, controller = new AbortController()) {
    streams.add(controller);
    const response = await fetch(`${origin}/api/v1/runs/${runId}/events`, {
        headers: {
            origin,
            cookie: auth.cookie,
            accept: 'text/event-stream',
            ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
    });
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type')?.includes('text/event-stream'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    return {
        async next(milliseconds = 120_000) {
            const timer = setTimeout(
                () => controller.abort(new Error('Proxy SSE frame deadline exceeded')),
                milliseconds,
            );
            try {
                for (;;) {
                    const end = buffered.indexOf('\n\n');
                    if (end >= 0) {
                        const block = buffered.slice(0, end);
                        buffered = buffered.slice(end + 2);
                        if (block.startsWith(':')) continue;
                        const fields = block.split('\n');
                        const value = (name) =>
                            fields
                                .filter((line) => line.startsWith(name + ':'))
                                .map((line) => line.slice(name.length + 1).trimStart())
                                .join('\n');
                        const data = value('data');
                        if (!data) continue;
                        const event = {
                            id: value('id'),
                            event: value('event'),
                            data: JSON.parse(data),
                        };
                        assert.equal(event.data.runId, runId);
                        assert.equal(event.id, event.data.eventId);
                        assert.equal(event.event, event.data.type);
                        assert(Number.isSafeInteger(event.data.seq) && event.data.seq > 0);
                        return event;
                    }
                    const chunk = await reader.read();
                    if (chunk.done) {
                        assert.equal(
                            buffered.trim(),
                            '',
                            'Proxy SSE ended with an incomplete frame',
                        );
                        return undefined;
                    }
                    buffered += decoder
                        .decode(chunk.value, { stream: true })
                        .replaceAll('\r\n', '\n');
                    assert(buffered.length < 262_144, 'Proxy SSE frame buffer exceeded its bound');
                }
            } finally {
                clearTimeout(timer);
            }
        },
        async close() {
            controller.abort();
            streams.delete(controller);
            await reader.cancel().catch(() => undefined);
        },
    };
}
async function firstEvent(runId, auth) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error('Proxy SSE first event exceeded 2s')),
        2000,
    );
    let stream;
    try {
        stream = await openEvents(runId, auth, undefined, controller);
        const first = await stream.next(Math.max(1, 2000 - (performance.now() - started)));
        const latencyMs = performance.now() - started;
        assert.equal(first?.event, 'run.queued');
        assert.equal(first.data.seq, 1);
        assert(latencyMs < 2000, `Proxy SSE first event took ${latencyMs.toFixed(1)} ms`);
        console.log(
            JSON.stringify({
                check: 'proxy-sse-first-event',
                mode: 'queued',
                latencyMs: Number(latencyMs.toFixed(1)),
                limitMs: 2000,
            }),
        );
        return { stream, first };
    } catch (error) {
        controller.abort();
        streams.delete(controller);
        await stream?.close();
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
async function drainEvents(stream, previous) {
    const events = [];
    try {
        for (;;) {
            const ended = ['run.completed', 'run.failed', 'run.canceled'].includes(previous.event);
            const event = await stream.next(ended ? 3000 : 120_000);
            if (!event) {
                assert(ended, 'Proxy SSE closed before a terminal event');
                return events;
            }
            assert(!ended, 'Proxy SSE emitted an event after termination');
            assert.equal(event.data.seq, previous.data.seq + 1);
            assert.notEqual(event.id, previous.id);
            events.push(event);
            previous = event;
            assert(events.length < 500, 'Unexpectedly unbounded event history');
        }
    } finally {
        await stream.close();
    }
}
const config = {
    title: '容器验收',
    topic: '公开信息研究',
    goal: '寻找可追溯资料',
    focusPoints: ['来源'],
    exclusions: [],
    sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
    timeRange: { kind: 'rolling', days: 7 },
    timezone: 'UTC',
    schedule: { frequency: 'manual' },
    outputFormat: 'brief',
    budget: {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40000,
        maxOutputTokens: 8000,
    },
    notificationPreference: { mode: 'summary', runIssues: true },
};
try {
    console.log('构建隔离项目并等待迁移、API、Worker、代理健康。');
    await compose(project, ['build', 'api', 'proxy']);
    await compose(project, [
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '180',
        'api',
        'worker',
        'proxy',
    ]);
    await request('/health');
    await webRouting();
    session = await account();
    const other = await account();
    const task = (await (await request('/api/v1/tasks', 'POST', { config })).json()).task;
    const key = randomUUID();
    const start = async () =>
        (
            await request(
                `/api/v1/tasks/${task.id}/runs`,
                'POST',
                { mode: 'live' },
                { 'idempotency-key': key },
            )
        ).json();
    // Hold the real consumer so the proxy must flush an event before the Run can finish.
    await compose(project, ['stop', 'worker']);
    const run = (await start()).run;
    assert.equal(run.mode, 'live');
    const firstStream = await firstEvent(run.id, session);
    const liveTask = (
        await (
            await request('/api/v1/tasks', 'POST', {
                config: { ...config, title: '缺凭据live边界' },
            })
        ).json()
    ).task;
    const live = (
        await (
            await request(
                `/api/v1/tasks/${liveTask.id}/runs`,
                'POST',
                { mode: 'live' },
                { 'idempotency-key': randomUUID() },
            )
        ).json()
    ).run;
    assert.equal(live.mode, 'live');
    const liveStream = await firstEvent(live.id, session);
    const nextFirst = firstStream.stream.next();
    void nextFirst.catch(() => undefined);
    // Observe the already-open socket while independently draining the explicit live failure.
    const liveHistory = drainEvents(liveStream.stream, liveStream.first);
    void liveHistory.catch(() => undefined);
    await compose(project, ['start', 'worker']);
    const changed = await nextFirst;
    assert(changed, 'Proxy SSE ended after queued replay instead of streaming new events');
    assert.equal(changed.data.seq, firstStream.first.data.seq + 1);
    await firstStream.stream.close();
    const resumed = await openEvents(run.id, session, changed.id);
    const firstTail = await drainEvents(resumed, changed);
    const firstEvents = [firstStream.first, changed, ...firstTail];
    assert.equal(firstEvents.at(-1).event, 'run.failed');
    const liveEvents = [liveStream.first, ...(await liveHistory)];
    assert.equal(liveEvents.at(-1).event, 'run.failed');
    const liveState = await (await request(`/api/v1/runs/${live.id}`)).json();
    assert.equal(liveState.mode, 'live');
    assert.equal(liveState.status, 'failed');
    assert.equal(liveState.failureCode, 'AGENT_CONFIGURATION_INVALID');
    assert.equal(
        (await (await request(`/api/v1/reports?taskId=${liveTask.id}`)).json()).items.length,
        0,
    );
    const replay = await openEvents(run.id, session, firstStream.first.id);
    assert.deepEqual(
        (await drainEvents(replay, firstStream.first)).map((event) => event.id),
        firstEvents.slice(1).map((event) => event.id),
    );
    const completed = await openEvents(run.id, session, firstEvents.at(-1).id);
    assert.deepEqual(await drainEvents(completed, firstEvents.at(-1)), []);
    const denied = await fetch(`${origin}/api/v1/runs/${run.id}/events`, {
        headers: { origin, cookie: other.cookie, 'last-event-id': firstStream.first.id },
        signal: AbortSignal.timeout(5000),
    });
    assert.equal(denied.status, 404);
    assert(!denied.headers.get('content-type')?.includes('text/event-stream'));
    const deniedBody = await denied.text();
    assert(!deniedBody.includes(run.id) && !deniedBody.includes(firstStream.first.id));
    console.log(
        JSON.stringify({
            check: 'proxy-sse',
            firstEvents: firstEvents.length,
            liveEvents: liveEvents.length,
            liveOutcome: 'configuration rejected; no external calls or demo fallback',
            reconnect: 'Last-Event-ID exact ordered replay',
            terminal: 'EOF within 3s',
            otherOwner: 404,
        }),
    );
    const failed = await (await request(`/api/v1/runs/${run.id}`)).json();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'AGENT_CONFIGURATION_INVALID');
    assert.equal(
        (await (await request(`/api/v1/reports?taskId=${task.id}`)).json()).items.length,
        0,
    );
    console.log('同源登录、真实研究缺配置失败和零伪造报告通过；验证重启幂等。');
    await compose(project, ['restart', 'postgres', 'redis', 'api', 'worker', 'proxy']);
    await compose(project, [
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '180',
        'api',
        'worker',
        'proxy',
    ]);
    assert.equal((await start()).run.id, run.id);
    assert.equal(
        (await (await request(`/api/v1/reports?taskId=${task.id}`)).json()).items.length,
        0,
    );
    await compose(project, ['stop', 'proxy', 'api', 'worker']);
    await compose(project, [
        '--profile',
        'maintenance',
        'run',
        '--rm',
        'operations',
        'backup',
        '--name=acceptance.dump',
    ]);
    await compose(restoreProject, ['up', '-d', '--wait', 'postgres', 'redis']);
    await compose(restoreProject, [
        '--profile',
        'maintenance',
        'run',
        '--rm',
        'operations',
        'restore',
        '--name=acceptance.dump',
        '--apply',
    ]);
    await compose(restoreProject, [
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '180',
        'api',
        'worker',
        'proxy',
    ]);
    assert.deepEqual(await (await request(`/api/v1/runs/${run.id}`)).json(), failed);
    assert.equal((await start()).run.id, run.id);
    assert.equal(
        (await (await request(`/api/v1/reports?taskId=${task.id}`)).json()).items.length,
        0,
    );
    console.log(
        '通过：容器启动、代理持续SSE/续传/owner隔离、缺配置失败且无伪造报告、持久重启及空库恢复。',
    );
} finally {
    for (const controller of streams) controller.abort();
    streams.clear();
    // Names are generated above; neither command targets an existing user deployment.
    const results = await Promise.allSettled(
        [restoreProject, project].map((name) =>
            compose(name, ['--profile', 'maintenance', 'down', '-v', '--remove-orphans']),
        ),
    );
    await rm(directory, { recursive: true, force: true });
    if (results.some((result) => result.status === 'rejected'))
        console.error(`验收清理未完成，请检查 ${project} 和 ${restoreProject}。`);
}
