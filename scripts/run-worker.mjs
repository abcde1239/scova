import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { nodeScriptCommand } from './process-runtime.mjs';

const [runtime, mode] = process.argv.slice(2);
if (!['bun', 'node'].includes(runtime) || !['dev', 'start'].includes(mode)) {
    throw new Error('Expected runtime (bun|node) and mode (dev|start)');
}

function workerEnvFile(path) {
    const source = readFileSync(new URL(path, import.meta.url), { encoding: 'utf8', flag: 'r' });
    return Object.fromEntries(
        Object.entries(parseEnv(source)).filter(
            ([key]) =>
                /^(WORKER_|READER_|SEARCH_|PLAYWRIGHT_|SCOVA_READER_)/.test(key) ||
                ['REDIS_URL', 'MODEL_DNS_RESOLVER', 'RESEARCH_ANSWER_SUPPLEMENT_ENABLED'].includes(
                    key,
                ),
        ),
    );
}

const env = {};
const files = mode === 'dev' ? ['../.env.local', '../apps/worker/.env'] : ['../apps/worker/.env'];
for (const file of files) {
    try {
        Object.assign(env, workerEnvFile(file));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}
Object.assign(env, process.env);
for (const key of Object.keys(env)) {
    if (
        /^((?:SCOVA_TEST_|RUNTIME_)?DATABASE_|POSTGRES_|PG[A-Z]|AGENT_|STORAGE_|SCOVA_SQLITE_(?:STATE|DATABASE)_PATH$|MODEL_(?!DNS_RESOLVER$))/.test(
            key.toUpperCase(),
        )
    )
        delete env[key];
}

const watch = mode === 'dev' ? ['--dev'] : [];
const command =
    runtime === 'bun'
        ? {
              executable: process.execPath,
              args: [
                  fileURLToPath(new URL('./run-bun.mjs', import.meta.url)),
                  ...watch,
                  '--no-env-file',
                  'src/main.ts',
              ],
          }
        : mode === 'dev'
          ? nodeScriptCommand('--watch', ['src/node.ts'])
          : nodeScriptCommand('src/node.ts');
const result = spawnSync(command.executable, command.args, {
    env,
    stdio: 'inherit',
    windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
