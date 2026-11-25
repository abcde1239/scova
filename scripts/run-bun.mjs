import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { watchBun } from './watch-bun.mjs';

const candidate = join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
const executable = process.env.BUN_BIN ?? (existsSync(candidate) ? candidate : 'bun');
const args = process.argv.slice(2);
const options = {
    stdio: 'inherit',
    env: {
        ...process.env,
        READER_NODE_EXECUTABLE: process.env.READER_NODE_EXECUTABLE ?? process.execPath,
    },
    windowsHide: true,
};
if (args[0] === '--dev') watchBun(executable, args.slice(1), options);
else {
    const result = spawnSync(executable, args, options);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
