import { PrismaClient } from '@scova/models';
import {
    createConnectorBundle,
    createPageReader,
    type ConnectorBundle,
    type StructuredInput,
    type CallContext,
} from '@scova/connectors';
import { createRunRepository } from '../../src/repo/runs.ts';
import { createAgentRuntime } from '../../src/service/agent.ts';
import { RunService, type RunExecutionContext } from '../../src/service/runs.ts';

// Test-only deterministic providers; the production claim, graph, checkpoints and delivery all run.
const [runId, phase = 'complete'] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(runId ?? '') || !['complete', 'fail'].includes(phase))
    throw new Error('Invalid question probe arguments');
const databaseUrl = process.env.DATABASE_URL!;
const schema = new URL(databaseUrl).searchParams.get('schema');
if (!schema || !/^scova_questions_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid question probe schema');
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
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
                throw new Error('Injected unavailable evidence');
            }
            return reader.read(requestedUrl, context);
        },
    },
    model: {
        async generateStructured<T>(input: StructuredInput, context?: CallContext) {
            await context?.beforeAttempt?.('model');
            prompts.push(input.prompt);
            const properties = input.schema.properties ?? {};
            const pages = input.untrustedSources as { pageId: string; text: string }[] | undefined;
            const data = Object.hasOwn(properties, 'queries')
                ? { queries: [{ query: observed!.config.goal, questionIds: ['q0'] }] }
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
                                text: pages![0]!.text,
                                questionIds: ['q0'],
                                citations: [{ pageId: pages![0]!.pageId, quote: pages![0]!.text }],
                            },
                        ],
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
});
try {
    await db.$connect();
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
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    const report = await db.report.findFirst({ where: { runId } });
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
                baselineRunId: run.baselineRunId,
                comparisonScopeHash: run.comparisonScopeHash,
            },
            reportId: report?.id ?? null,
        }),
    );
} finally {
    await runtime.close();
    await db.$disconnect();
}
