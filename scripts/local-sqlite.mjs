import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { nodeScriptCommand } from './process-runtime.mjs';

const flags = process.argv.slice(2);
if (flags.some((flag) => !['--node', '--backend-only'].includes(flag)))
    throw new Error('Usage: vp run local:sqlite [--node] [--backend-only]');
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(root, process.env.SCOVA_LOCAL_DATA_DIR ?? '.scova-local');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configPath = join(dataDir, '.env');
if (!existsSync(configPath)) {
    writeFileSync(
        configPath,
        [
            `AGENT_CREDENTIAL_KEY=${randomBytes(32).toString('hex')}`,
            `WORKER_EXECUTION_TOKEN=${randomBytes(32).toString('hex')}`,
            'MODEL_API_KEY=',
            'MODEL_NAME=',
            'MODEL_BASE_URL=',
            '',
        ].join('\n'),
        { mode: 0o600, flag: 'wx' },
    );
}
const settings = { ...process.env, ...parseEnv(readFileSync(configPath, 'utf8')) };
function port(key, fallback) {
    const value = Number(settings[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
        throw new Error(`Invalid ${key}`);
    return value;
}
const apiPort = port('SCOVA_LOCAL_API_PORT', 3000);
const workerPort = port('SCOVA_LOCAL_EXECUTION_PORT', 3001);
const webPort = port('SCOVA_LOCAL_WEB_PORT', 5173);
if (new Set([apiPort, workerPort, webPort]).size !== 3)
    throw new Error('Local ports must be distinct');
const api = `http://127.0.0.1:${apiPort}`;
const origin = `http://127.0.0.1:${webPort}`;
const env = {
    ...settings,
    NODE_ENV: 'development',
    APP_ORIGIN: origin,
    PORT: String(apiPort),
    VITE_API_BASE_URL: `${api}/api/v1`,
    WORKER_EXECUTION_HOST: '127.0.0.1',
    WORKER_EXECUTION_PORT: String(workerPort),
    WORKER_EXECUTION_URL: `http://127.0.0.1:${workerPort}`,
    READER_NODE_EXECUTABLE: settings.READER_NODE_EXECUTABLE ?? process.execPath,
};
for (const key of Object.keys(env)) {
    if (/^(DATABASE_|REDIS_|POSTGRES_|PG[A-Z]|SCOVA_SQLITE_)/i.test(key)) delete env[key];
}
const node = flags.includes('--node');
const bunPath = join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
const bun = env.BUN_BIN ?? (existsSync(bunPath) ? bunPath : 'bun');
const backend = () =>
    node
        ? nodeScriptCommand('src/node.ts')
        : {
              executable: bun,
              args: ['--no-env-file', 'src/main.ts'],
          };
const children = new Map();
const controller = new AbortController();
let stopping;
let webStartup;
function stop() {
    if (stopping) return stopping;
    controller.abort();
    stopping = (async () => {
        const webShutdown = webStartup?.then(
            (web) => web.close(),
            () => undefined,
        );
        const stopChild = async (name) => {
            const running = children.get(name);
            if (!running) return;
            const { child, ended } = running;
            const deadline = setTimeout(() => child.kill(), 10_000).unref();
            try {
                if (child.connected)
                    child.send('scova:shutdown', (error) => {
                        if (error) child.kill();
                    });
                else child.kill();
                const code = await ended;
                if (code !== 0) process.exitCode = 1;
            } finally {
                clearTimeout(deadline);
            }
        };
        // Let the Worker finish its execution protocol calls while Server is still reachable.
        await stopChild('worker');
        await stopChild('server');
        await webShutdown;
    })()
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(() => process.disconnect?.());
    return stopping;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
if (process.connected)
    process.on('message', (message) => {
        if (message === 'scova:shutdown') void stop();
    });
function launch(name, command, childEnv) {
    const child = spawn(command.executable, command.args, {
        cwd: join(root, 'apps', name),
        env: childEnv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
    });
    const ended = new Promise((resolve) => child.once('close', resolve));
    children.set(name, { child, ended });
    child.once('error', (error) => {
        console.error(`Scova ${name}: ${error.message}`);
        process.exitCode = 1;
        void stop();
    });
    void ended.then((code) => {
        children.delete(name);
        if (!stopping) {
            console.error(`Scova ${name} exited (${code ?? 'signal'})`);
            process.exitCode = 1;
            void stop();
        }
    });
}

async function startWeb() {
    process.env.NODE_ENV = 'development';
    process.env.APP_ORIGIN = origin;
    process.env.VITE_API_BASE_URL = env.VITE_API_BASE_URL;
    const { createServer } = await import('vite-plus');
    const web = await createServer({
        root: join(root, 'apps', 'web'),
        server: { host: '127.0.0.1', port: webPort, strictPort: true },
    });
    try {
        controller.signal.throwIfAborted();
        await web.listen();
        return web;
    } catch (error) {
        await web.close();
        throw error;
    }
}

launch('server', backend(), {
    ...env,
    SCOVA_SQLITE_DATABASE_PATH: join(dataDir, 'business.sqlite'),
    SCOVA_SQLITE_STATE_PATH: join(dataDir, 'state.sqlite'),
});
try {
    const deadline = Date.now() + 30_000;
    while (true) {
        const response = await fetch(`${api}/health`, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
        }).catch(() => undefined);
        if (response?.ok) break;
        if (Date.now() >= deadline) throw new Error('Scova API did not become ready');
        await wait(250, undefined, { signal: controller.signal });
    }
    controller.signal.throwIfAborted();
    const workerEnv = Object.fromEntries(
        Object.entries(env).filter(
            ([key]) =>
                !/^(AGENT_|STORAGE_|MODEL_(?!DNS_RESOLVER$)|WORKER_HEARTBEAT_PATH$)/i.test(key),
        ),
    );
    launch('worker', backend(), workerEnv);
    if (!flags.includes('--backend-only')) {
        webStartup = startWeb();
        await webStartup;
        console.log(`Scova Web: ${origin}`);
    }
    console.log(`Scova SQLite data: ${dataDir}`);
} catch (error) {
    if (!stopping) {
        console.error(error);
        process.exitCode = 1;
        stop();
    }
}
