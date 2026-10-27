import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
export function installedCheckpointVersion(): string {
    const entry = require.resolve('@langchain/langgraph-checkpoint-postgres');
    return JSON.parse(readFileSync(resolve(dirname(entry), '../package.json'), 'utf8')).version;
}
