import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
export type Images = { backend: string; web: string };
export type Scenario = 'english' | 'admissions' | 'research';
export type Phase = 'A' | 'B' | 'C';

async function docker(args: string[], timeout = 180_000, env?: NodeJS.ProcessEnv) {
    try {
        return (
            await exec('docker', args, {
                cwd: root,
                env,
                timeout,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            })
        ).stdout.trim();
    } catch (error) {
        // Generated credentials and connection URLs must not appear in test diagnostics.
        const failure = error as { stderr?: string; code?: string | number };
        const diagnostic = (failure.stderr ?? '').replace(
            /postgres(?:ql)?:\/\/[^\s]+/g,
            '[database URL]',
        );
        throw new Error(
            `Docker ${args[0]} failed (${failure.code ?? 'timeout'}): ${diagnostic.slice(-6000)}`,
        );
    }
}

export class ComposeEnvironment {
    readonly id = randomUUID().replaceAll('-', '');
    readonly project = `scova-e2e-${this.id.slice(0, 12)}`;
    readonly schema = `scova_acceptance_${this.id}`;
    readonly checkpointSchema = `scova_e2e_agent_${this.id}`;
    readonly queue = `scova-e2e-${this.id}`;
    readonly images: Images;
    origin = '';
    private directory = '';
    private override = '';
    private env: NodeJS.ProcessEnv = {};
    private cleanup: Promise<void> | undefined;
    private scenario: { name: Scenario; phase: Phase; partial?: boolean } | undefined = {
        name: 'english',
        phase: 'A',
        partial: true,
    };
    private questionModel = false;

    constructor(images?: Images) {
        this.images = images ?? {
            backend: `${this.project}-backend:test`,
            web: `${this.project}-web:test`,
        };
    }

    async configure() {
        if (this.override) return;
        this.directory = await mkdtemp(join(tmpdir(), 'scova-e2e-'));
        this.override = join(this.directory, 'compose.json');
        const socket = createServer().listen(0, '127.0.0.1');
        await once(socket, 'listening');
        const address = socket.address();
        if (!address || typeof address === 'string') throw new Error('Cannot reserve E2E port');
        this.origin = `http://localhost:${address.port}`;
        await new Promise<void>((resolve, reject) =>
            socket.close((error) => (error ? reject(error) : resolve())),
        );
        this.env = {
            ...process.env,
            POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
            APP_ORIGIN: this.origin,
            SCOVA_BIND: '127.0.0.1',
            SCOVA_PORT: String(address.port),
            REGISTRATION_ENABLED: 'true',
            SEARCH_PROVIDER: 'searxng',
            MODEL_API_KEY: '',
            MODEL_NAME: '',
            MODEL_BASE_URL: '',
            TAVILY_API_KEY: '',
            SEARXNG_SECRET: '',
            COMPOSE_PROFILES: '',
        };
        await this.writeOverride();
    }

    private async writeOverride() {
        const url = `postgresql://scova:${this.env.POSTGRES_PASSWORD}@postgres:5432/scova?schema=${this.schema}`;
        const services = Object.fromEntries(
            ['api', 'worker', 'migrate', 'operations', 'proxy'].map((service) => [
                service,
                {
                    image: service === 'proxy' ? this.images.web : this.images.backend,
                    ...(service === 'proxy'
                        ? {}
                        : {
                              environment: {
                                  DATABASE_URL:
                                      url +
                                      (service === 'api' || service === 'worker'
                                          ? `&application_name=scova-${service}`
                                          : ''),
                                  AGENT_CHECKPOINT_SCHEMA: this.checkpointSchema,
                                  WORKER_QUEUE_NAME: this.queue,
                                  WORKER_POLL_INTERVAL_MS: '50',
                                  WORKER_FAILURE_DELAY_MS: '50',
                                  ...(service === 'worker' && this.scenario
                                      ? {
                                            SCOVA_ACCEPTANCE_SCENARIO: this.scenario.name,
                                            SCOVA_ACCEPTANCE_PHASE: this.scenario.phase,
                                            SCOVA_ACCEPTANCE_TRUNCATED: this.scenario.partial
                                                ? '1'
                                                : '0',
                                        }
                                      : {}),
                              },
                          }),
                    ...(service === 'worker' && this.scenario
                        ? {
                              command: ['bun', 'run', '/app/tests/e2e/support/worker.ts'],
                          }
                        : {}),
                    ...(service === 'api' && this.questionModel
                        ? { command: ['bun', 'run', '/app/tests/e2e/support/api.ts'] }
                        : {}),
                },
            ]),
        );
        await writeFile(this.override, JSON.stringify({ services }));
    }

    async compose(args: string[], timeout = 180_000) {
        if (!this.override) throw new Error('E2E environment is not configured');
        return docker(
            [
                'compose',
                '--env-file',
                join(root, '.env.example'),
                '-p',
                this.project,
                '-f',
                join(root, 'compose.yaml'),
                '-f',
                this.override,
                ...args,
            ],
            timeout,
            this.env,
        );
    }

    async build() {
        await this.configure();
        await this.compose(['build', 'api', 'proxy'], 900_000);
    }

    async start(options: { failAt?: 'dependencies' } = {}) {
        try {
            await this.configure();
            await this.compose([
                'up',
                '-d',
                '--no-build',
                '--wait',
                '--wait-timeout',
                '90',
                'postgres',
                'redis',
            ]);
            if (options.failAt === 'dependencies') throw new Error('Injected E2E startup failure');
            await this.sql(`CREATE SCHEMA "${this.schema}"`);
            await this.compose([
                'up',
                '-d',
                '--no-build',
                '--wait',
                '--wait-timeout',
                '120',
                'api',
                'worker',
                'proxy',
            ]);
        } catch (error) {
            let logs = '';
            try {
                logs = await this.compose(
                    ['logs', '--no-color', '--tail', '60', 'migrate', 'api', 'worker'],
                    30_000,
                );
            } catch {
                // Cleanup must still run if Docker cannot provide startup diagnostics.
            }
            await this.stop();
            throw new Error(
                `${error instanceof Error ? error.message : String(error)}\n${logs.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL]')}`,
            );
        }
    }

    async useScenario(name: Scenario, phase: Phase) {
        await this.compose(['stop', '-t', '30', 'worker']);
        this.scenario = { name, phase };
        await this.writeOverride();
        await this.compose([
            'up',
            '-d',
            '--no-build',
            '--no-deps',
            '--force-recreate',
            '--wait',
            '--wait-timeout',
            '90',
            'worker',
        ]);
    }

    async sql(statement: string) {
        return this.compose([
            'exec',
            '-T',
            'postgres',
            'psql',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'scova',
            '-d',
            'scova',
            '-At',
            '-c',
            statement,
        ]);
    }

    /** Switch only this test project's API to an explicit, local evidence supplier. */
    async useQuestionModel(enabled: boolean) {
        await this.compose(['stop', '-t', '30', 'api']);
        this.questionModel = enabled;
        await this.writeOverride();
        await this.compose([
            'up',
            '-d',
            '--no-build',
            '--no-deps',
            '--force-recreate',
            '--wait',
            '--wait-timeout',
            '90',
            'api',
        ]);
    }

    async resources() {
        const entries = await Promise.all(
            ['container', 'volume', 'network'].map(async (kind) => {
                const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
                const ids = await docker(
                    [...args, '--filter', `label=com.docker.compose.project=${this.project}`],
                    30_000,
                );
                return [kind, ids.split(/\r?\n/).filter(Boolean)] as const;
            }),
        );
        return Object.fromEntries(entries) as Record<'container' | 'volume' | 'network', string[]>;
    }

    async stop() {
        this.cleanup ??= (async () => {
            try {
                if (this.override)
                    await this.compose(
                        [
                            '--profile',
                            'maintenance',
                            'down',
                            '-v',
                            '--remove-orphans',
                            '--timeout',
                            '30',
                        ],
                        120_000,
                    );
                const resources = await this.resources();
                if (Object.values(resources).some((ids) => ids.length))
                    throw new Error(`E2E cleanup leaked resources for ${this.project}`);
            } finally {
                if (this.directory) await rm(this.directory, { recursive: true, force: true });
            }
        })();
        await this.cleanup;
    }

    async removeImages() {
        for (const image of [this.images.backend, this.images.web]) {
            const found = await docker(['image', 'ls', '-q', image], 30_000);
            if (found) await docker(['image', 'rm', image], 60_000);
        }
    }
}

export async function usingEnvironment<T>(
    images: Images,
    operation: (environment: ComposeEnvironment) => Promise<T>,
) {
    const environment = new ComposeEnvironment(images);
    try {
        await environment.start();
        return await operation(environment);
    } finally {
        await environment.stop();
    }
}
