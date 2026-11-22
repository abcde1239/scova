import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
const commands: Record<string, string[]> = {
    up: ['up', '-d', '--wait', '--wait-timeout', '180'],
    down: ['down'],
    status: ['ps'],
};
const [action, ...flags] = process.argv.slice(2);
const withSearch = action === 'up' && flags.length === 1 && flags[0] === '--search';
if (
    !action ||
    (action !== 'init' && !Object.hasOwn(commands, action)) ||
    (flags.length && !withSearch)
)
    throw new Error('Expected init, up [--search], down or status');

if (!existsSync(envPath)) {
    if (action !== 'init' && action !== 'up') throw new Error('Run vp run local:init first');
    const template = readFileSync(new URL('../.env.local.example', import.meta.url), 'utf8');
    const contents = template
        .replaceAll('replace_with_a_random_database_password', randomBytes(24).toString('hex'))
        .replaceAll('replace_with_a_random_search_secret', randomBytes(32).toString('hex'));
    writeFileSync(envPath, contents, { mode: 0o600, flag: 'wx' });
    console.log('Created .env.local with random local credentials.');
}

// Initialize local service secrets once without rotating existing credentials.
if (action === 'init' || action === 'up') {
    const existing = readFileSync(envPath, 'utf8');
    let updated = existing;
    for (const name of ['AGENT_CREDENTIAL_KEY', 'WORKER_EXECUTION_TOKEN']) {
        const setting = new RegExp(`^${name}=([^\r\n]*)\r?$`, 'gm');
        const value = [...updated.matchAll(setting)].at(-1)?.[1]?.trim();
        if (!value || value === '""' || value === "''") {
            updated = `${updated.replace(setting, '').trimEnd()}\n${name}=${randomBytes(32).toString('hex')}\n`;
        }
    }
    if (updated !== existing) writeFileSync(envPath, updated, { mode: 0o600 });
}

if (action === 'init') {
    console.log('Local configuration ready; existing .env.local is preserved.');
} else {
    if (action === 'up' && process.platform === 'win32') {
        const startup = spawnSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-File',
                fileURLToPath(new URL('./start-docker.ps1', import.meta.url)),
            ],
            { cwd: root, stdio: 'inherit', windowsHide: true },
        );
        if (startup.error) throw startup.error;
        if (startup.status !== 0) process.exit(startup.status ?? 1);
    }
    const result = spawnSync(
        'docker',
        [
            'compose',
            '--env-file',
            envPath,
            '-f',
            'compose.local.yaml',
            '-p',
            'scova-local',
            // Status/down also see a previously enabled search service.
            ...(withSearch || action !== 'up' ? ['--profile', 'live-search'] : []),
            ...commands[action],
        ],
        { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (result.status === 0 && action === 'up')
        console.log(
            `Local dependencies ready (${withSearch ? 'with' : 'without starting'} SearXNG). Next: vp run db:migrate, then vp run dev.`,
        );
}
