import { runRuntimeTests } from '../tests/runtime/runtime.mjs';

try {
    await runRuntimeTests({ onlyDst: process.argv.includes('--only=dst') });
} catch (error) {
    console.error('Runtime 实验失败：', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
