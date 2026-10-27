import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env.searxng', import.meta.url));
const action = process.argv[2];
const commands: Record<string, string[]> = {
    up: ['up', '-d', '--wait'],
    down: ['down'],
    status: ['ps'],
};
if (!action || !Object.hasOwn(commands, action)) throw new Error('Expected up, down or status');
if (!existsSync(envPath)) {
    if (action !== 'up') throw new Error('Run vp run search:up first');
    writeFileSync(
        envPath,
        `SEARXNG_SECRET=${randomBytes(32).toString('hex')}\nSCOVA_SEARXNG_PORT=8080\n`,
        { mode: 0o600, flag: 'wx' },
    );
}
const result = spawnSync(
    'docker',
    [
        'compose',
        '--env-file',
        envPath,
        '-f',
        'compose.search.yaml',
        '-p',
        'scova-search',
        ...commands[action],
    ],
    {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
    },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0 && action === 'up') {
    console.log('SearxNG is ready. Run vp run test:search:live to verify actual upstream results.');
}
