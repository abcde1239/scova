import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function installedCheckpointVersion(from: string): string {
    const require = createRequire(from);
    const entry = require.resolve('@langchain/langgraph-checkpoint-postgres');
    return JSON.parse(readFileSync(resolve(dirname(entry), '../package.json'), 'utf8')).version;
}
