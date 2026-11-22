import { prepareTestCheckpointSchema } from './checkpoint-schema.ts';
import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import { selectedOutputFormats } from '@scova/models';
import {
    createDatabaseClient,
    connectDatabase,
    runs as dbRuns,
    eq,
    reports as dbReports,
    closeDatabase,
} from '@scova/db';

import {
    createConnectorBundle,
    ConnectorError,
    createHttpPageReader as createPageReader,
    type ConnectorBundle,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import { createRunRepository } from '../../../server/src/repo/execution/runs.ts';
import { createLocalAgentRuntime as createAgentRuntime } from './local-agent-runtime.ts';
import { RunService, type RunExecutionContext } from '../../src/service/runs.ts';

// Test-only deterministic providers; the production claim, graph, checkpoints and delivery all run.
const [runId, phase = 'complete'] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(runId ?? '') || !['complete', 'fail'].includes(phase))
    throw new Error('Invalid question probe arguments');
const databaseUrl = process.env.DATABASE_URL!;
const schema = new URL(databaseUrl).searchParams.get('schema');
if (!schema || !/^scova_questions_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid question probe schema');
const db = createDatabaseClient({ connectionString: databaseUrl });
const base = createConnectorBundle();
const queries: string[] = [],
    prompts: string[] = [];
let observed: Pick<RunExecutionContext, 'config' | 'budget' | 'taskVersionId'> | undefined;
const url = 'https://example.com/question-followup';
const reader = createPageReader({
    http: {
        async request(requestedUrl) {
            return {
                url: requestedUrl,
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: `<html><head><title>原文公告</title><meta property="article:published_time" content="${new Date(Date.now() - 60_000).toISOString()}"></head><body><article><p>申请截止日期为十一月十五日。</p></article></body></html>`,
            };
        },
    },
});
const bundle: ConnectorBundle = {
    mode: 'live',
    search: {
        async search(query, context) {
            queries.push(query);
            const result = await base.search.search(query, context);
            return {
                ...result,
                mode: 'live',
                provider: 'searxng',
                searchedAt: new Date().toISOString(),
                results: [
                    {
                        kind: 'search_snippet',
                        originalUrl: url,
                        url,
                        title: '原文公告',
                        snippet: '摘要不能替代原文',
                        engines: ['fixture'],
                    },
                ],
            };
        },
    },
    reader: {
        async read(requestedUrl, context) {
            if (phase === 'fail') {
                await context?.beforeAttempt?.('read');
                throw new ConnectorError('extraction_failed', 'Injected unavailable evidence');
            }
            return reader.read(requestedUrl, context);
        },
    },
    model: {
        async generateStructured<T>(input: StructuredInput, context?: CallContext) {
            await context?.beforeAttempt?.('model');
            prompts.push(input.prompt);
            const properties = (input.schema.properties ?? {}) as Record<string, any>;
            const pages = input.untrustedSources as { pageId: string; text: string }[] | undefined;
            const data = Object.hasOwn(properties, 'queries')
                ? {
                      queries: [{ query: observed!.config.goal, questionIds: ['q0'] }],
                      requirements: selectedOutputFormats(observed!.config).map((format) => ({
                          id: `${format}-date`,
                          format,
                          object: '',
                          field: '申请截止日期',
                          required: true,
                          questionIds: ['q0'],
                      })),
                  }
                : Object.hasOwn(properties, 'pages')
                  ? {
                        pages: pages!.map((page) => ({
                            pageId: page.pageId,
                            facts: [
                                {
                                    subject: '公开公告',
                                    predicate: '截止日期',
                                    value: page.text,
                                    quote: page.text,
                                    relevance: 'relevant',
                                    importance: 'important',
                                },
                            ],
                        })),
                    }
                  : {
                        claims: [
                            {
                                kind: 'fact',
                                outputFormat: selectedOutputFormats(observed!.config)[0],
                                assessment: {
                                    ...((properties.claims as any)?.items.properties.assessment
                                        ?.properties.gapKind
                                        ? { gapKind: 'none' }
                                        : {}),
                                    relevance: 'direct',
                                    support: 'direct',
                                    role: 'answer',
                                    sourceRelation: 'unknown',
                                    reason: '测试公告直接回答申请截止日期',
                                    conditions: '',
                                    gap: '',
                                },
                                text: pages![0]!.text,
                                questionIds: ['q0'],
                                citations: [{ pageId: pages![0]!.pageId, quote: pages![0]!.text }],
                            },
                        ],
                        artifacts: selectedOutputFormats(observed!.config).map((format) => ({
                            format,
                            requirements: [
                                { id: `${format}-date`, text: pages![0]!.text, claimIndexes: [0] },
                            ],
                        })),
                    };
            return {
                data: data as T,
                mode: 'live',
                usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            };
        },
    },
};
const runtime = createAgentRuntime({
    database: db,
    databaseUrl,
    checkpointSchema: schema,
    bundle,
    enableDelivery: true,
    env: { ...process.env, SEARCH_ADAPTIVE_ENABLED: 'false' },
});
try {
    await connectDatabase(db);
    await prepareTestCheckpointSchema(databaseUrl, schema);
    await runtime.connect();
    const repository = createRunRepository(db);
    const service = new RunService({
        repository,
        workerId: `question-probe-${process.pid}`,
        leaseMs: 60_000,
        executorFactory(token) {
            const executor = runtime.executorFactory(token);
            return {
                ...executor,
                async execute(context) {
                    observed = {
                        config: context.config,
                        budget: context.budget,
                        taskVersionId: context.taskVersionId,
                    };
                    await executor.execute(context);
                },
            };
        },
    });
    const result = await service.execute(runId!);
    const run = await db.query.runs
        .findFirst({ where: eq(dbRuns.id, runId) })
        .then((row) => requiredDatabaseValue(row));
    const report = await db.query.reports.findFirst({ where: eq(dbReports.runId, runId) });
    console.log(
        JSON.stringify({
            result,
            pid: process.pid,
            observed,
            queries,
            prompts,
            run: {
                id: run.id,
                status: run.status,
                failureCode: run.failureCode,
                coverage: run.coverageJson,
                baselineRunId: run.baselineRunId,
                comparisonScopeHash: run.comparisonScopeHash,
            },
            reportId: report?.id ?? null,
        }),
    );
} finally {
    await runtime.close();
    await closeDatabase(db);
}
