import { spawn } from 'node:child_process';
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const argumentsSet = new Set(process.argv.slice(2));
const allowed = ['--browser-only', '--controlled-failure', '--plan'];
if ([...argumentsSet].some((argument) => !allowed.includes(argument))) {
    throw new Error(`Usage: vpx scripts/verify-web.mjs [${allowed.join('] [')}]`);
}
const controlledFailure = argumentsSet.has('--controlled-failure');
const browserOnly = argumentsSet.has('--browser-only') || controlledFailure;
const fullStackSpecs = [
    'environment.spec.ts',
    'two-rounds-english.spec.ts',
    'two-rounds-admission.spec.ts',
    'two-rounds-research.spec.ts',
    'browser-resilience.spec.ts',
    'base-pages-accessibility.spec.ts',
];
const dedicated = [
    ['task-center', 'task-center.config.ts', 'task-center.spec.ts'],
    ['run-history', 'run-history.config.ts', 'run-history.spec.ts'],
    ['execution', 'execution.config.ts', 'execution.spec.ts'],
    ['visual-foundation', 'visual-foundation.config.ts', 'visual-foundation.spec.ts'],
];
const separate = new Set([
    ...fullStackSpecs,
    ...dedicated.map((entry) => entry[2]),
    'supplementary-visual.spec.ts',
    'full-workbench.spec.ts',
]);
const sampleSpecs = readdirSync(join(root, 'tests/e2e'))
    .filter((name) => name.endsWith('.spec.ts') && !separate.has(name))
    .sort()
    .map((name) => `tests/e2e/${name}`);
const stages = [
    ...(!browserOnly
        ? [
              { id: 'static', args: ['check'] },
              { id: 'unit', args: ['test'] },
              { id: 'build', args: ['run', '-r', 'build'] },
          ]
        : []),
    ...(!controlledFailure
        ? [
              { id: 'samples', args: ['run', 'test:e2e', ...sampleSpecs], browser: true },
              ...dedicated.map(([id, config]) => ({
                  id,
                  args: ['exec', 'playwright', 'test', '--config', `tests/e2e/${config}`],
                  browser: true,
              })),
          ]
        : []),
    {
        id: 'full-stack',
        args: [
            'run',
            'test:e2e',
            ...(controlledFailure ? ['environment.spec.ts'] : fullStackSpecs).map(
                (name) => `tests/e2e/${name}`,
            ),
        ],
        browser: true,
        fullStack: true,
    },
];
if (argumentsSet.has('--plan')) {
    process.stdout.write(
        `${JSON.stringify({ browserOnly, controlledFailure, stages }, null, 2)}\n`,
    );
} else {
    await verify();
}

async function verify() {
    const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`;
    const directory = join(root, 'artifacts/verify-web', runId);
    mkdirSync(directory, { recursive: true });
    const summary = {
        runId,
        controlledFailure,
        browserOnly,
        remoteResearch: false,
        browserVersion: null,
        stages: [],
        error: null,
        passed: false,
    };
    let vp;
    let interrupted;
    let activeChild;
    let browserStarted = false;
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
        if (stage.fullStack) env.SCOVA_E2E_FULL_STACK = '1';
        const args = [...stage.args];
        const reportPath = join(directory, `${stage.id}.json`);
        if (stage.browser) {
            browserStarted = true;
            env.PLAYWRIGHT_JSON_OUTPUT_FILE = reportPath;
            args.push('--reporter=list,json', '--output', join(directory, stage.id, 'results'));
        }
        const startedAt = Date.now();
        const output = createWriteStream(join(directory, `${stage.id}.log`));
        process.stdout.write(`\n[verify:web] ${stage.id}: vp ${args.join(' ')}\n`);
        let exitCode;
        try {
            exitCode = await new Promise((accept, reject) => {
                const child = spawn(vp, args, {
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
                child.once('close', (code, signal) => {
                    activeChild = undefined;
                    if (signal) reject(new Error(`${stage.id} terminated by ${signal}`));
                    else accept(code ?? 2);
                });
            });
        } finally {
            output.end();
        }
        const result = { id: stage.id, exitCode, elapsedMs: Date.now() - startedAt };
        summary.stages.push(result);
        if (interrupted) throw new Error(`Verification interrupted: ${interrupted}`);
        if (exitCode !== 0) throw new Error(`${stage.id} exited ${exitCode}`);
        if (stage.browser) validateReport(reportPath, !!stage.fullStack);
    }
    try {
        vp = findVp();
        for (const stage of stages) {
            if (stage.browser && !summary.browserVersion) {
                const require = createRequire(import.meta.url);
                const { chromium } = require('@playwright/test');
                const browser = await chromium.launch();
                try {
                    summary.browserVersion = browser.version();
                    process.stdout.write(`[verify:web] Chromium ${summary.browserVersion}\n`);
                } finally {
                    await browser.close();
                }
            }
            await run(stage);
        }
        if (controlledFailure) throw new Error('SCOVA_CONTROLLED_WEB_GATE_FAILURE_AFTER_CLEANUP');
        summary.passed = true;
    } catch (error) {
        summary.error = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        process.stderr.write(`${summary.error}\n`);
    } finally {
        // Every Playwright invocation has completed its own preview/fixture teardown before
        // this rebuild. Never rebuild dist while a preceding invocation still consumes it.
        if (browserStarted && !interrupted) {
            try {
                await run({ id: 'restore-production', args: ['run', 'web#build'] });
            } catch (error) {
                summary.passed = false;
                summary.error = [
                    summary.error,
                    error instanceof Error ? error.message : String(error),
                ]
                    .filter(Boolean)
                    .join('; ');
                process.exitCode = 1;
            }
        }
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        process.stdout.write(`[verify:web] ${join(directory, 'summary.json')}\n`);
    }
}

function findVp() {
    if (process.platform !== 'win32') return 'vp';
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
    const candidate = (process.env[pathKey] ?? '')
        .split(delimiter)
        .map((directory) => join(directory, 'vp.exe'))
        .find(existsSync);
    if (!candidate) throw new Error('Global native vp.exe is required on PATH.');
    return candidate;
}

function validateReport(reportPath, fullStack) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const stats = report.stats;
    if (
        !stats ||
        stats.expected < 1 ||
        stats.unexpected !== 0 ||
        stats.flaky !== 0 ||
        stats.skipped !== 0 ||
        report.errors?.length
    )
        throw new Error(`Incomplete or failed browser gate: ${reportPath}`);
    if (!fullStack) return;
    let verifiedTests = 0;
    function visit(suite) {
        for (const spec of suite.specs ?? [])
            for (const test of spec.tests ?? []) {
                const results = test.results ?? [];
                if (
                    test.status !== 'expected' ||
                    results.length !== 1 ||
                    results[0].status !== 'passed'
                )
                    throw new Error(`Full-stack test did not pass once: ${spec.title}`);
                for (const result of results) {
                    let recordedCleanup = false;
                    for (const attachment of result.attachments ?? []) {
                        if (!attachment.name.endsWith('cleanup')) continue;
                        const content = attachment.body
                            ? Buffer.from(attachment.body, 'base64').toString('utf8')
                            : readFileSync(resolve(attachment.path), 'utf8');
                        const record = JSON.parse(content);
                        if (
                            typeof record.project !== 'string' ||
                            !record.project.trim() ||
                            !record.resources ||
                            typeof record.resources !== 'object' ||
                            Array.isArray(record.resources) ||
                            Object.keys(record.resources).length === 0 ||
                            Object.values(record.resources).some(
                                (entries) => !Array.isArray(entries) || entries.length,
                            )
                        )
                            throw new Error(
                                `Resource cleanup did not complete: ${attachment.name}`,
                            );
                        recordedCleanup = true;
                    }
                    if (!recordedCleanup)
                        throw new Error(`Full-stack test has no cleanup record: ${spec.title}`);
                }
                verifiedTests += 1;
            }
        for (const nested of suite.suites ?? []) visit(nested);
    }
    for (const suite of report.suites ?? []) visit(suite);
    if (verifiedTests !== stats.expected)
        throw new Error('Full-stack browser gate did not record cleanup for every passing test.');
}
