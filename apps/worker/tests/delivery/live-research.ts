import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import { eq, taskVersions as dbTaskVersions, runs as dbRuns } from '@scova/db';
import {
    createConnectorBundle,
    ConnectorError,
    createHttpPageReader as createPageReader,
    type ConnectorBundle,
} from '@scova/connectors';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { createAgentSession } from '../../src/service/agent.ts';
import { seedRun } from '../support/run-database.ts';
import { fixture, runs, saver } from './fixture.ts';
import { deliveryRequirements, type LiveResearchOptions } from './live-options.ts';
import { createDeliveryModel } from './model.ts';

export async function liveResearch(options: LiveResearchOptions = {}) {
    const initial = options.previous ?? (await seedRun(fixture.db, { mode: 'live' }));
    if (
        options.notificationPreference ||
        options.officialOnly ||
        options.outputFormats ||
        options.researchMode
    ) {
        if (options.researchMode) initial.config.researchMode = options.researchMode;
        if (options.outputFormats) {
            initial.config.outputFormats = options.outputFormats;
            initial.config.outputFormat = options.outputFormats[0]!;
        }
        if (options.notificationPreference)
            initial.config.notificationPreference = options.notificationPreference;
        if (options.officialOnly)
            initial.config.sourcePreferences = {
                preferredUrls: [options.pageUrl ?? 'https://example.com/publication'],
                excludedUrls: [],
                officialOnly: true,
            };
        await fixture.db
            .update(dbTaskVersions)
            .set({ configJson: initial.config })
            .where(eq(dbTaskVersions.id, initial.version.id))
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
    }
    const run = options.previous
        ? await fixture.db
              .insert(dbRuns)
              .values({
                  userId: initial.user.id,
                  taskId: initial.task.id,
                  taskVersionId: initial.version.id,
                  mode: 'live',
                  trigger: 'manual',
                  comparisonScopeHash: initial.run.comparisonScopeHash,
                  budgetJson: initial.config.budget,
                  usageJson: {
                      searches: 0,
                      pages: 0,
                      inputTokens: 0,
                      outputTokens: 0,
                      estimated: false,
                  },
              })
              .returning()
              .then((rows) => requiredDatabaseValue(rows[0]))
        : initial.run;
    const claimed = await runs.claim(run.id, 'delivery-live', 60_000);
    if (claimed.kind !== 'claimed') throw new Error('Expected claimed live Run');
    const url = options.pageUrl ?? 'https://example.com/publication';
    const publication =
        options.publication === undefined
            ? new Date(Date.now() - 60_000).toISOString()
            : options.publication;
    let readRequests = 0;
    let searchRequests = 0;
    const plan = deliveryRequirements(initial.config, options);
    const reader = createPageReader({
        maxTextChars: options.maxTextChars,
        http: {
            async request(requestedUrl) {
                if (options.retryRead && readRequests++ === 0)
                    return {
                        url: requestedUrl,
                        status: 503,
                        headers: { 'content-type': 'text/html' },
                        body: '',
                    };
                if (options.failUrls?.includes(requestedUrl))
                    throw new ConnectorError('network', 'Injected missing source');
                return {
                    url: requestedUrl,
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                    body: `<html><head><title>采集公告</title>${publication === null ? '' : `<meta property="article:published_time" content="${publication}">`}${options.modified ? `<meta property="article:modified_time" content="${options.modified}">` : ''}</head><body><article><p>${options.bodyByUrl?.[requestedUrl] ?? options.body ?? (requestedUrl.endsWith('alternate') ? '第二来源称申请截止日期为十一月十六日。' : '这是已发布的公共公告，申请截止日期为十一月十五日。')}</p></article></body></html>`,
                };
            },
        },
    });
    const base = createConnectorBundle();
    const bundle: ConnectorBundle = {
        mode: 'live',
        reader: {
            async read(url, context) {
                const page = await reader.read(url, context);
                return {
                    ...page,
                    ...(options.extractionVersion
                        ? { extractionVersion: options.extractionVersion }
                        : {}),
                    ...(options.collection
                        ? { collection: structuredClone(options.collection) }
                        : {}),
                };
            },
        },
        search: {
            async search(query, context) {
                const result = await base.search.search(query, context);
                return {
                    ...result,
                    mode: 'live',
                    provider: options.providerPage ? 'deepseek' : 'searxng',
                    results:
                        options.evidenceLinks && searchRequests++ > 0
                            ? []
                            : await Promise.all(
                                  [
                                      url,
                                      ...Array.from(
                                          { length: (options.pageCount ?? 1) - 1 },
                                          (_, i) => `${url}/source-${i}`,
                                      ),
                                      ...(options.claimKind === 'conflict'
                                          ? [url + '/alternate']
                                          : []),
                                  ].map(async (pageUrl) => ({
                                      kind: 'search_snippet' as const,
                                      originalUrl: pageUrl,
                                      url: pageUrl,
                                      title: '采集公告',
                                      snippet: '未经正文验证的搜索摘要',
                                      engines: ['fixture'],
                                      ...(options.providerPage
                                          ? { page: await reader.read(pageUrl) }
                                          : {}),
                                  })),
                              ),
                };
            },
        },
        model: createDeliveryModel(options, plan),
    };
    const context = {
        runId: run.id,
        userId: initial.user.id,
        taskId: initial.task.id,
        taskVersionId: initial.version.id,
        mode: run.mode,
        config: claimed.config,
        budget: claimed.budget,
        usage: claimed.usage,
        startedAt: claimed.run.startedAt!,
        deadlineAt: claimed.run.deadlineAt!,
        signal: new AbortController().signal,
        assertActive: () => runs.assertActive(claimed.token),
        emit: (event: Parameters<typeof runs.emit>[1]) => runs.emit(claimed.token, event),
    };
    const session = createAgentSession({
        repository: createAgentRepository(fixture.db, claimed.token),
        saver,
        token: claimed.token,
        context,
        bundle,
    });
    const candidate = options.skipExecute ? undefined : await session.execute();
    return {
        user: initial.user,
        task: initial.task,
        version: initial.version,
        config: initial.config,
        run,
        claimed,
        context,
        session,
        bundle,
        candidate: candidate!,
    };
}
