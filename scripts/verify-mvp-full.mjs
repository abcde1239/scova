import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = new Set(process.argv.slice(2));
if ([...options].some((option) => !['--plan', '--supplementary-only'].includes(option)))
    throw new Error('Usage: vpx scripts/verify-mvp-full.mjs [--plan] [--supplementary-only]');
const plan = [
    ...(!options.has('--supplementary-only')
        ? [{ id: 'base-web', argv: ['run', 'verify:web'] }]
        : []),
    {
        id: 'supplementary',
        argv: [
            'run',
            'test:e2e',
            'tests/e2e/supplementary-visual.spec.ts',
            'tests/e2e/full-workbench.spec.ts',
        ],
        browser: true,
    },
];
if (process.argv.includes('--plan')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else {
    await verify();
}

async function verify() {
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
    const vp =
        process.platform === 'win32'
            ? (process.env[pathKey] ?? '')
                  .split(delimiter)
                  .map((directory) => join(directory, 'vp.exe'))
                  .find(existsSync)
            : 'vp';
    if (!vp) throw new Error('Global native vp executable is required');
    const directory = join(
        root,
        'artifacts/verify-mvp-full',
        `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`,
    );
    mkdirSync(directory, { recursive: true });
    const summary = { passed: false, remoteResearch: false, stages: [], error: null };
    let interrupted;
    let activeChild;
    const onSignal = (signal) => {
        interrupted = signal;
        activeChild?.kill('SIGTERM');
    };
    const interrupt = () => onSignal('SIGINT');
    const terminate = () => onSignal('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    async function run(stage) {
        if (interrupted) throw new Error(`Verification interrupted: ${interrupted}`);
        const env = { ...process.env };
        delete env.SCOVA_E2E_FULL_STACK;
        delete env.MODEL_API_KEY;
        delete env.TAVILY_API_KEY;
        const argv = [...stage.argv];
        if (stage.browser) {
            env.SCOVA_E2E_FULL_STACK = '1';
            env.PLAYWRIGHT_JSON_OUTPUT_FILE = join(directory, 'supplementary.json');
            argv.push('--reporter=list,json', '--output', join(directory, 'results'));
        }
        const output = createWriteStream(join(directory, `${stage.id}.log`));
        let code;
        const started = Date.now();
        try {
            code = await new Promise((resolve, reject) => {
                const child = spawn(vp, argv, {
                    cwd: root,
                    env,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                activeChild = child;
                child.stdout.on('data', (data) => {
                    process.stdout.write(data);
                    output.write(data);
                });
                child.stderr.on('data', (data) => {
                    process.stderr.write(data);
                    output.write(data);
                });
                child.once('error', reject);
                child.once('close', (exitCode, signal) => {
                    activeChild = undefined;
                    if (signal) reject(new Error(`${stage.id}: ${signal}`));
                    else resolve(exitCode ?? 2);
                });
            });
        } finally {
            await new Promise((resolve) => output.end(resolve));
        }
        summary.stages.push({ id: stage.id, code, elapsedMs: Date.now() - started });
        if (interrupted) throw new Error(`Verification interrupted: ${interrupted}`);
        if (code !== 0) throw new Error(`${stage.id} exited ${code}`);
        if (stage.browser) {
            const report = JSON.parse(readFileSync(env.PLAYWRIGHT_JSON_OUTPUT_FILE, 'utf8'));
            if (
                !report.stats?.expected ||
                report.stats.unexpected ||
                report.stats.flaky ||
                report.stats.skipped ||
                report.errors?.length
            )
                throw new Error('Supplementary browser report is incomplete or unsuccessful');
            let count = 0;
            function visit(suite) {
                for (const spec of suite.specs ?? []) {
                    for (const test of spec.tests ?? []) {
                        if (
                            test.status !== 'expected' ||
                            test.results?.length !== 1 ||
                            test.results[0].status !== 'passed'
                        )
                            throw new Error(`Incomplete supplementary result: ${spec.title}`);
                        const cleanups = test.results[0].attachments.filter(
                            (attachment) => attachment.name === 'isolated-environment-cleanup',
                        );
                        if (cleanups.length !== 1)
                            throw new Error(`Missing cleanup: ${spec.title}`);
                        const attachment = cleanups[0];
                        const cleanup = JSON.parse(
                            attachment.body
                                ? Buffer.from(attachment.body, 'base64').toString('utf8')
                                : readFileSync(resolve(attachment.path), 'utf8'),
                        );
                        if (
                            !cleanup.project?.trim() ||
                            !cleanup.resources ||
                            !['container', 'volume', 'network'].every(
                                (key) =>
                                    Array.isArray(cleanup.resources[key]) &&
                                    cleanup.resources[key].length === 0,
                            )
                        )
                            throw new Error(`Incomplete resource cleanup: ${spec.title}`);
                        count++;
                    }
                }
                for (const child of suite.suites ?? []) visit(child);
            }
            for (const suite of report.suites ?? []) visit(suite);
            if (count !== report.stats.expected)
                throw new Error('Not every supplementary test completed cleanup');
        }
    }
    let supplementaryStarted = false;
    try {
        for (const stage of plan) {
            if (stage.browser) supplementaryStarted = true;
            await run(stage);
        }
        summary.passed = true;
    } catch (error) {
        summary.error = String(error);
        process.exitCode = 1;
    } finally {
        if (supplementaryStarted && !interrupted) {
            try {
                await run({ id: 'restore-production', argv: ['run', 'web#build'] });
            } catch (error) {
                summary.passed = false;
                summary.error = [summary.error, String(error)].filter(Boolean).join('; ');
                process.exitCode = 1;
            }
        }
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        process.stdout.write(`[verify:mvp-full] ${join(directory, 'summary.json')}\n`);
        if (summary.error) process.stderr.write(String(summary.error) + '\n');
    }
}
