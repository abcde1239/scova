import { runStructuredFixture as runResearchAgent } from './structured-fixtures.ts';
import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_TASK_BUDGET } from '@scova/models';
import {
    ConnectorError,
    estimateModelInputTokens,
    type ReadPage,
    type SearchResponse,
} from '@scova/connectors';
import { deterministicPartial } from '../src/index.ts';
import { researchWindow, scopedQuery } from '../src/research-context.ts';
import type { AgentContext, AgentDependencies, AgentTools } from '../src/index.ts';

const text = 'The application deadline is 15 November 2026. Other claims require more evidence.';
const url = 'https://official.example/notice';
const page: ReadPage = {
    kind: 'read_page',
    mode: 'live',
    originalUrl: url,
    fetchedUrl: url,
    url,
    title: 'Application notice',
    text,
    contentHash: createHash('sha256').update(text).digest('hex'),
    extractionVersion: 'test-fixture-v1',
    collectedAt: '2026-10-26T00:00:00Z',
    truncated: false,
    untrusted: true,
};
function fixture() {
    const controller = new AbortController();
    const budget = {
        maxSearches: 10,
        maxPages: 20,
        maxDurationSeconds: 300,
        maxInputTokens: 40_000,
        maxOutputTokens: 8000,
    };
    const context: AgentContext = {
        runId: 'run-1',
        userId: 'owner-1',
        taskVersionId: 'version-1',
        mode: 'live',
        budget,
        usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        deadlineAt: new Date(Date.now() + 300_000),
        signal: controller.signal,
        assertActive: vi.fn(async () => {}),
        config: {
            title: 'Applications',
            topic: 'Application deadline',
            goal: 'When is the deadline?',
            focusPoints: [],
            exclusions: [],
            sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
            timeRange: { kind: 'rolling', days: 30 },
            timezone: 'UTC',
            schedule: { frequency: 'manual' },
            outputFormat: 'brief',
            budget,
            notificationPreference: { mode: 'off', runIssues: false },
        },
    };
    const searchResponse: SearchResponse = {
        kind: 'search_results',
        mode: 'live',
        provider: 'searxng',
        query: 'deadline',
        searchedAt: new Date().toISOString(),
        results: [
            {
                kind: 'search_snippet',
                originalUrl: url,
                url,
                title: 'notice',
                snippet: 'Unverified search snippet',
            },
        ],
        coverage: {
            complete: true,
            gaps: [],
            unresponsiveEngines: [],
            receivedResults: 1,
            returnedResults: 1,
            discardedResults: 0,
            totalResults: 1,
            truncated: false,
        },
    };
    const tools: AgentTools = {
        search: vi.fn(async () => structuredClone(searchResponse)),
        read: vi.fn(async () => structuredClone(page)),
        model: vi.fn<AgentTools['model']>(async (key) => ({
            mode: 'live',
            usage: { inputTokens: 100, outputTokens: 100, estimated: false },
            data: key.startsWith('plan')
                ? { queries: [{ query: 'Application deadline', questionIds: ['q0'] }] }
                : {
                      claims: [
                          {
                              kind: 'fact',
                              assessment: {
                                  relevance: 'direct',
                                  support: 'direct',
                                  role: 'answer',
                                  sourceRelation: 'unknown',
                                  reason: '日期来自原文',
                                  conditions: '',
                                  gap: '',
                              },
                              text: 'The application deadline is 15 November 2026.',
                              questionIds: ['q0'],
                              citations: [
                                  {
                                      pageId: 'read-0',
                                      quote: 'The application deadline is 15 November 2026.',
                                  },
                              ],
                          },
                      ],
                  },
        })),
    };
    const saver = new MemorySaver();
    const promote = vi.fn(async (_config: RunnableConfig) => {});
    const deps: AgentDependencies = {
        tools,
        checkpointer: saver,
        config: { configurable: { thread_id: crypto.randomUUID() } },
        promote,
    };
    return { context, deps, tools, saver, promote, controller, searchResponse };
}

describe('persistent bounded research Agent', () => {
    it('uses the actual synthesis schema claim limit in the generated model prompt', async () => {
        const { context, deps, tools } = fixture();
        await runResearchAgent(context, deps);
        const request = vi
            .mocked(tools.model)
            .mock.calls.find(([key]) => key === 'synthesize-0')![1];
        const schema = request.schema as { properties: { claims: { maxItems: number } } };
        expect(schema.properties.claims.maxItems).toBe(24);
        expect(request.prompt).toContain(
            `schema maximum of ${schema.properties.claims.maxItems} claims total`,
        );
        expect(request.prompt).not.toContain('schema maximum of 30 claims');
    });
    it('recovers an empty precise site query within the original search budget', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.config.researchMode = 'collection';
        context.budget.maxSearches = 3;
        const recoveredUrl = 'https://official.example/docs/v1/deadline.html';
        const model = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) =>
            key.startsWith('plan')
                ? {
                      mode: 'live',
                      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                      data: {
                          queries: [
                              {
                                  query: 'Application deadline site:official.example/docs/v1/deadline.html',
                                  questionIds: ['q0'],
                              },
                          ],
                      },
                  }
                : model(key, input),
        );
        tools.search = vi.fn(async (_key, query) => ({
            ...structuredClone(searchResponse),
            query,
            results: query.includes('site:official.example/docs/')
                ? []
                : [{ ...searchResponse.results[0]!, originalUrl: recoveredUrl, url: recoveredUrl }],
        }));
        tools.read = vi.fn(async (_key, requested) => ({
            ...page,
            originalUrl: requested,
            fetchedUrl: requested,
            url: requested,
        }));
        const output = await runResearchAgent(context, deps);
        expect(vi.mocked(tools.search).mock.calls.map(([, query]) => query)).toEqual([
            'Application deadline site:official.example/docs/v1/deadline.html',
            'Application deadline site:official.example "v1" "deadline"',
        ]);
        expect(tools.read).toHaveBeenCalledExactlyOnceWith('read-0', recoveredUrl);
        expect(output.coverage.research?.supplementalSearches).toBe(1);
    });
    it('does not read a conflicting version returned for a precise query', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.config.researchMode = 'collection';
        context.config.topic = 'Application deadline Node.js v22.12.0';
        context.budget.maxSearches = 3;
        const model = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) =>
            key.startsWith('plan')
                ? {
                      mode: 'live',
                      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                      data: {
                          queries: [
                              {
                                  query: 'Application deadline site:nodejs.org/docs/v22.12.0/api/http.html',
                                  questionIds: ['q0'],
                              },
                          ],
                      },
                  }
                : model(key, input),
        );
        tools.search = vi.fn(async (_key, query) => {
            const candidateUrl = `https://nodejs.org/docs/${query.includes('site:nodejs.org/docs/') ? 'v24.1.0' : 'v22.12.0'}/api/http.html`;
            return {
                ...structuredClone(searchResponse),
                query,
                results: [
                    {
                        ...searchResponse.results[0]!,
                        title: 'Application deadline HTTP',
                        url: candidateUrl,
                        originalUrl: candidateUrl,
                    },
                ],
            };
        });
        tools.read = vi.fn(async (_key, requested) => ({
            ...page,
            originalUrl: requested,
            fetchedUrl: requested,
            url: requested,
        }));
        const output = await runResearchAgent(context, deps);
        expect(tools.read).toHaveBeenCalledExactlyOnceWith(
            'read-0',
            'https://nodejs.org/docs/v22.12.0/api/http.html',
        );
        expect(output.coverage.notes?.join(' ')).toContain('其他版本');
        expect(tools.search).toHaveBeenCalledTimes(2);
    });
    it('retains the original module constraint after relaxing an exact site path', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.config.researchMode = 'collection';
        context.budget.maxSearches = 3;
        const model = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) =>
            key.startsWith('plan')
                ? {
                      mode: 'live',
                      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                      data: {
                          queries: [
                              {
                                  query: 'Application deadline site:nginx.org/en/docs/http/ngx_http_core_module.html',
                                  questionIds: ['q0'],
                              },
                          ],
                      },
                  }
                : model(key, input),
        );
        tools.search = vi.fn(async (_key, query) => {
            const correct = !query.includes('site:nginx.org/en/docs/');
            const candidateUrl = correct
                ? 'https://nginx.org/en/docs/http/ngx_http_core_module.html'
                : 'https://nginx.org/en/docs/stream/ngx_stream_core_module.html';
            const candidates = [
                candidateUrl,
                ...(!correct ? ['https://mailman.nginx.org/pipermail/nginx/thread.html'] : []),
            ];
            return {
                ...structuredClone(searchResponse),
                query,
                results: candidates.map((candidate) => ({
                    ...searchResponse.results[0]!,
                    title: 'Application deadline HTTP core module',
                    url: candidate,
                    originalUrl: candidate,
                })),
            };
        });
        tools.read = vi.fn(async (_key, requested) => ({
            ...page,
            originalUrl: requested,
            fetchedUrl: requested,
            url: requested,
        }));
        const output = await runResearchAgent(context, deps);
        expect(tools.read).toHaveBeenCalledExactlyOnceWith(
            'read-0',
            'https://nginx.org/en/docs/http/ngx_http_core_module.html',
        );
        expect(tools.search).toHaveBeenCalledTimes(2);
        expect(output.coverage.notes?.join(' ')).toContain('其他模块');
    });
    it('keeps a current-version request partial when the retrieved source does not confirm its version', async () => {
        const { context, deps } = fixture();
        context.config.researchMode = 'collection';
        context.config.topic = 'Application deadline PostgreSQL current';
        const output = await runResearchAgent(context, deps);
        expect(output.pages).toHaveLength(1);
        expect(output.coverage.completeness).toBe('partial');
        expect(output.coverage.gaps.join(' ')).toContain('来源版本范围尚未确认');
    });
    it('searches a missing planned object even when its shared question already has a page', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.config.researchMode = 'collection';
        context.config.topic = 'Python 3.13 pathlib json';
        context.config.goal = 'Compare public interfaces';
        context.budget.maxSearches = 3;
        const objects = ['pathlib', 'json'];
        const texts = [
            'Pathlib public interfaces include Path objects for filesystem paths. Navigation: json.',
            'The json public interfaces include dumps and loads for serialization.',
        ];
        const requirements = objects.map((object) => ({
            id: `brief-${object}`,
            format: 'brief',
            object,
            field: 'public interfaces',
            required: true,
            questionIds: ['q0'],
        }));
        tools.model = vi.fn<AgentTools['model']>(async (key) => ({
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: key.startsWith('plan')
                ? {
                      queries: [
                          { query: 'Python 3.13 pathlib public interfaces', questionIds: ['q0'] },
                      ],
                      requirements,
                  }
                : {
                      claims: texts.map((content, index) => ({
                          kind: 'fact',
                          text: content,
                          questionIds: ['q0'],
                          citations: [{ pageId: `read-${index}`, quote: content }],
                          assessment: {
                              relevance: 'direct',
                              support: 'direct',
                              role: 'answer',
                              sourceRelation: 'unknown',
                              reason: '原文接口',
                              conditions: '',
                              gap: '',
                          },
                      })),
                      artifacts: [
                          {
                              format: 'brief',
                              requirements: requirements.map((requirement, index) => ({
                                  id: requirement.id,
                                  text: texts[index],
                                  claimIndexes: [index],
                              })),
                          },
                      ],
                  },
        }));
        tools.search = vi.fn(async (_key, query) => {
            const object = query.includes('json') ? 'json' : 'pathlib';
            const candidateUrl = `https://docs.python.org/3.13/library/${object}.html`;
            return {
                ...structuredClone(searchResponse),
                query,
                results: [
                    {
                        ...searchResponse.results[0]!,
                        title: `${object} — Python 3.13 documentation`,
                        url: candidateUrl,
                        originalUrl: candidateUrl,
                    },
                ],
            };
        });
        tools.read = vi.fn(async (_key, requested) => {
            const index = requested.includes('json') ? 1 : 0;
            return {
                ...page,
                title: `${objects[index]} — Python 3.13 documentation`,
                originalUrl: requested,
                fetchedUrl: requested,
                url: requested,
                text: texts[index]!,
                contentHash: createHash('sha256').update(texts[index]!).digest('hex'),
            };
        });
        const output = await runResearchAgent(context, deps);
        expect(tools.search).toHaveBeenCalledTimes(2);
        const focused = vi.mocked(tools.search).mock.calls[1]![1];
        expect(focused).toContain('json');
        expect(focused).not.toContain('pathlib');
        expect(focused).toContain('Python 3.13');
        expect(tools.read).toHaveBeenCalledTimes(2);
        expect(output.pages.map((p) => p.title)).toEqual([
            'pathlib — Python 3.13 documentation',
            'json — Python 3.13 documentation',
        ]);
    });
    it('revises a frozen report with discussion roles and no search calls', async () => {
        const { context, deps, tools } = fixture();
        context.conversation = {
            version: 1,
            reportId: crypto.randomUUID(),
            questionId: crypto.randomUUID(),
            operation: 'revise',
            report: { title: '原报告', summary: '已保存发现', claims: ['第一点', '第二点'] },
            messages: [
                { role: 'user', content: '解释第二点' },
                { role: 'assistant', content: '日期有条件' },
                { role: 'user', content: '整理成新版报告' },
            ],
            sources: [
                {
                    id: crypto.randomUUID(),
                    url,
                    title: page.title,
                    text: page.text,
                    observedAt: page.collectedAt,
                },
            ],
            omittedTurns: 0,
        };
        const result = await runResearchAgent(context, deps);
        expect(tools.search).not.toHaveBeenCalled();
        expect(tools.read).toHaveBeenCalledWith('read-0', url);
        expect(result.claims.length).toBeGreaterThan(0);
        const requests = vi.mocked(tools.model).mock.calls;
        expect(requests.some(([key]) => key.startsWith('plan'))).toBe(false);
        const synthesis = requests.find(([key]) => key === 'synthesize-0')![1];
        expect(synthesis.messages).toEqual(context.conversation.messages);
        expect(synthesis.prompt).toContain('第二点');
        expect(result.coverage.gaps.join('')).toContain('未联网');
    });
    it('skips twenty unsupported candidates and uses the read budget for a later HTML source', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.config.researchMode = 'collection';
        context.budget.maxSearches = 3;
        context.budget.maxPages = 1;
        const original = searchResponse.results[0]!;
        const candidates = [
            ...Array.from({ length: 19 }, (_, i) => ({
                ...original,
                originalUrl: `https://files.example/${i}.pdf`,
                url: `https://files.example/${i}.pdf`,
            })),
            {
                ...original,
                originalUrl: 'https://att.newsmth.net/nForum/att/Emacs/81563/431607',
                url: 'https://att.newsmth.net/nForum/att/Emacs/81563/431607',
                title: 'Emacs 词表附件',
            },
            original,
        ];
        let searchIndex = 0;
        tools.search = vi.fn(async (_key, query) => ({
            ...structuredClone(searchResponse),
            query,
            results: candidates.slice(searchIndex * 10, ++searchIndex * 10),
        }));
        const model = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) =>
            key.startsWith('plan')
                ? {
                      mode: 'live',
                      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                      data: {
                          queries: [0, 1, 2].map((i) => ({
                              query: `Application deadline ${i}`,
                              questionIds: ['q0'],
                          })),
                      },
                  }
                : model(key, input),
        );
        const result = await runResearchAgent(context, deps);
        expect(tools.read).toHaveBeenCalledExactlyOnceWith('read-0', url);
        expect(result.pages).toHaveLength(1);
        expect(result.coverage.notes?.join(' ')).toContain('已跳过 20 个');
        expect(result.coverage.gaps.join(' ')).not.toMatch(/采集失败|读取预算/);
    });

    it('records unsupported explicit preferred sources as gaps without spending a read attempt', async () => {
        const { context, deps, tools } = fixture();
        const preferred = 'https://files.example/preferred.pdf';
        context.config.researchMode = 'collection';
        context.config.sourcePreferences.preferredUrls = [preferred];
        context.budget.maxSearches = 1;
        context.budget.maxPages = 1;
        const result = await runResearchAgent(context, deps);
        expect(tools.read).toHaveBeenCalledExactlyOnceWith('read-0', url);
        expect(result.coverage.completeness).toBe('partial');
        expect(result.coverage.gaps.join(' ')).toContain(
            '优先来源是当前网页读取器不支持的文档或附件',
        );
        expect(result.coverage.gaps.join(' ')).toContain(preferred);
    });

    it('retains normalized provider body capability without storing the body in search checkpoints', async () => {
        const { context, deps, tools, searchResponse, saver } = fixture();
        context.config.researchMode = 'collection';
        context.budget.maxSearches = 1;
        context.budget.maxPages = 1;
        const canonical = 'https://provider.example/report.pdf';
        const originalUrl = `${canonical}?utm_source=search#page=2`;
        context.config.sourcePreferences.preferredUrls = [canonical];
        searchResponse.results = [
            {
                ...searchResponse.results[0]!,
                originalUrl,
                url: canonical,
                page: { ...page, originalUrl, url: canonical, fetchedUrl: canonical },
            },
        ];
        tools.read = vi.fn(async (_key, target) => ({
            ...page,
            originalUrl: target,
            url: canonical,
            fetchedUrl: canonical,
        }));
        const result = await runResearchAgent(context, deps);
        expect(tools.read).toHaveBeenCalledExactlyOnceWith('read-0', canonical);
        expect(result.pages[0]!.url).toBe(canonical);
        expect(result.coverage.gaps.join(' ')).not.toContain('不支持的文档或附件');
        const state = (await saver.getTuple(deps.config))!.checkpoint.channel_values.research as {
            providerPageUrls: string[];
            searches: { response: SearchResponse }[];
        };
        expect(state.providerPageUrls).toEqual([canonical]);
        expect(state.searches[0]!.response.results[0]).not.toHaveProperty('page');
    });

    it('collection keeps source content useful without requiring publication metadata', async () => {
        const { context, deps, tools } = fixture();
        context.config.researchMode = 'collection';
        const result = await runResearchAgent(context, deps);
        expect(result.coverage.completeness).toBe('complete');
        expect(result.coverage.gaps).toEqual([]);
        expect(result.coverage.reportValue?.questions[0].status).toBe('supported');
        expect(result.coverage.notes?.join(' ')).toContain('不认定为查阅窗口内新发布');
        const prompts = vi
            .mocked(tools.model)
            .mock.calls.map(([, input]) => input.prompt)
            .join(' ');
        expect(prompts).toContain('Collection:');
    });
    it('keeps adaptive queries on the task topic instead of adding Agent architecture terms', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.config.topic = 'Vue computed watchers';
        context.config.focusPoints = ['响应式依赖与清理'];
        let searches = 0;
        tools.search = vi.fn(async (_key, query) => ({
            ...structuredClone(searchResponse),
            query,
            results: ++searches <= 2 ? [] : searchResponse.results,
        }));
        const output = await runResearchAgent(context, deps);
        const queries = vi.mocked(tools.search).mock.calls.map(([, query]) => query);
        expect(queries.some((q) => q.includes('原理 适用条件'))).toBe(true);
        expect(queries.join(' ')).not.toMatch(/architecture research|official research evidence/);
        expect(
            queries
                .filter((q) => /原理 适用条件|官方文档 原始资料/.test(q))
                .every((q) => q.includes(context.config.topic)),
        ).toBe(true);
        expect(output.coverage.research!.supplementalSearches).toBeLessThanOrEqual(2);
        expect(tools.search).toHaveBeenCalledTimes(4);
    });
    it.each([false, true])(
        'optional answer-gap round reuses the second synthesis slot and stops without new information (%s)',
        async (sameContent) => {
            const { context, deps, tools, searchResponse } = fixture();
            context.answerSupplementEnabled = true;
            context.budget.maxPages = 3;
            context.comparisonScopeHash = 'bounded-supplement';
            const extraUrl = 'https://extra.example/deadline';
            const extraText = sameContent ? text : 'The deadline is 15 November 2026 at 18:00 UTC.';
            const firstModel = tools.model;
            tools.search = vi.fn(async (_key, query) => ({
                ...structuredClone(searchResponse),
                query,
                results: [
                    {
                        ...searchResponse.results[0],
                        originalUrl: query.includes('原始资料') ? extraUrl : url,
                        url: query.includes('原始资料') ? extraUrl : url,
                    },
                ],
            }));
            tools.read = vi.fn(async (_key, requestedUrl) => ({
                ...page,
                originalUrl: requestedUrl,
                fetchedUrl: requestedUrl,
                url: requestedUrl,
                text: requestedUrl === extraUrl ? extraText : text,
                contentHash: createHash('sha256')
                    .update(requestedUrl === extraUrl ? extraText : text)
                    .digest('hex'),
            }));
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key.startsWith('compare-facts'))
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: { pages: [{ pageId: 'read-0', facts: [] }] },
                    };
                const result = await firstModel(key, input);
                if (key === 'synthesize-0') {
                    const data = result.data as {
                        claims: { assessment: { support: string; gap: string } }[];
                    };
                    data.claims[0].assessment.support = 'partial';
                    data.claims[0].assessment.gap = '具体时区未说明';
                }
                if (key === 'synthesize-1')
                    return {
                        ...result,
                        data: {
                            claims: [
                                {
                                    kind: 'fact',
                                    text: extraText,
                                    citations: [{ pageId: 'read-1', quote: extraText }],
                                    questionIds: ['q0'],
                                    assessment: {
                                        relevance: 'direct',
                                        support: 'direct',
                                        role: 'answer',
                                        sourceRelation: 'unknown',
                                        reason: '新增材料给出时间',
                                        conditions: '',
                                        gap: '',
                                    },
                                },
                            ],
                        },
                    };
                return result;
            });
            const output = await runResearchAgent(context, deps);
            expect(tools.search).toHaveBeenCalledTimes(2);
            expect(tools.read).toHaveBeenCalledTimes(2);
            expect(
                vi
                    .mocked(tools.model)
                    .mock.calls.filter(([key]) => key.startsWith('compare-facts')),
            ).toHaveLength(1);
            expect(
                vi.mocked(tools.model).mock.calls.filter(([key]) => key.startsWith('synthesize')),
            ).toHaveLength(sameContent ? 1 : 2);
            expect(output.coverage.research?.supplementalSearches).toBe(1);
            expect(output.manifest?.pages).toHaveLength(2);
            expect(output.coverage.gaps.join(' ')).toContain('补证新增正文未重复执行事实比较');
            if (sameContent) expect(output.coverage.notes?.join(' ')).toContain('停止追加模型调用');
            else expect(output.claims[0].text).toBe(extraText);
        },
    );
    it('counts cited inference as an answer and separates local candidate truncation from search failure', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.startedAt = new Date('2026-10-26T00:00:00Z');
        searchResponse.coverage = {
            ...searchResponse.coverage,
            complete: false,
            truncated: true,
            gaps: ['搜索结果已按调用上限截断'],
            receivedResults: 40,
        };
        vi.mocked(tools.read).mockResolvedValue({
            ...page,
            publication: {
                parserVersion: 'scova-publication-v1',
                status: 'known',
                instant: '2026-10-25T00:00:00Z',
                observations: [
                    {
                        field: 'article:published_time',
                        rawValue: '2026-10-25T00:00:00Z',
                        locator: 'meta[0]',
                    },
                ],
            },
        });
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            const response = await original(key, input);
            if (key.startsWith('synthesize'))
                return {
                    ...response,
                    data: {
                        claims: [
                            {
                                kind: 'inference',
                                text: 'Applications should be prepared before the November deadline.',
                                assessment: {
                                    relevance: 'direct',
                                    support: 'direct',
                                    role: 'answer',
                                    sourceRelation: 'unknown',
                                    reason: '明确回答截止时间',
                                    conditions: '',
                                    gap: '',
                                },
                                questionIds: ['q0'],
                                citations: [{ pageId: 'read-0', quote: text }],
                            },
                        ],
                    },
                };
            return response;
        });
        const result = await runResearchAgent(context, deps);
        expect(result.coverage.completeness).toBe('complete');
        expect(result.coverage.gaps).toEqual([]);
        expect(result.coverage.notes?.join(' ')).toContain('不代表搜索引擎故障');
        expect(result.coverage.notes?.join(' ')).toContain('仍属于推断');
    });
    it('uses remaining read attempts for alternative hosts after source failures', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.budget.maxSearches = 1;
        context.budget.maxPages = 5;
        searchResponse.results = ['bad', 'bad', 'bad', 'good', 'good', 'good'].map((host, i) => ({
            ...searchResponse.results[0],
            title: 'Application deadline',
            url: `https://${host}.example/${i}`,
            originalUrl: `https://${host}.example/${i}`,
        }));
        tools.read = vi.fn(async (_key, target) => {
            if (new URL(target).hostname === 'bad.example')
                throw new ConnectorError('http', 'fixture', false, 403);
            return { ...page, originalUrl: target, fetchedUrl: target, url: target };
        });
        const result = await runResearchAgent(context, deps);
        const attempts = vi.mocked(tools.read).mock.calls.map(([, target]) => target);
        expect(attempts).toHaveLength(5);
        expect(new Set(attempts).size).toBe(5);
        expect(attempts).toEqual([
            'https://bad.example/0',
            'https://good.example/3',
            'https://good.example/4',
            'https://good.example/5',
            'https://bad.example/1',
        ]);
        expect(result.pages).toHaveLength(3);
    });
    it.each(['plan-0', 'compare-facts-v1', 'synthesize-0'])(
        'stops remaining model stages after quota failure in %s, including checkpoint resume',
        async (stage) => {
            const { context, deps, tools, promote } = fixture();
            context.comparisonScopeHash = 'scope';
            const original = tools.model;
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key === stage)
                    throw new ConnectorError('model_quota_exceeded', 'DO_NOT_RENDER');
                if (key === 'compare-facts-v1')
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: { pages: [{ pageId: 'read-0', facts: [] }] },
                    };
                return original(key, input);
            });
            const result = await runResearchAgent(context, deps);
            const keys = vi.mocked(tools.model).mock.calls.map(([key]) => key);
            expect(keys.at(-1)).toBe(stage);
            expect(keys.filter((key) => key === stage)).toHaveLength(1);
            expect(result.coverage.completeness).toBe('partial');
            expect(result.coverage.gaps.join(' ')).toContain('额度不足');
            expect(result.pages.length).toBeGreaterThan(0);
            expect(result.claims.every((claim) => claim.kind === 'insufficient')).toBe(true);
            expect(JSON.stringify(result)).not.toContain('DO_NOT_RENDER');
            await runResearchAgent(context, {
                ...deps,
                resume: true,
                config: promote.mock.calls.at(-1)![0],
            });
            expect(vi.mocked(tools.model).mock.calls.map(([key]) => key)).toEqual(keys);
        },
    );

    it('retains intermediate historical years and freezes a cross-year rolling window', () => {
        const { context } = fixture();
        context.startedAt = new Date('2026-01-02T00:00:00Z');
        context.config.timeRange = { kind: 'rolling', days: 7 };
        expect(researchWindow(context).start).toBe('2025-12-26T00:00:00.000Z');
        expect(scopedQuery('2025 2026 2024 evidence', context)).toBe('2025 2026 evidence');
        context.config.timeRange = {
            kind: 'fixed',
            start: '2010-01-01T00:00:00Z',
            end: '2020-12-31T00:00:00Z',
        };
        expect(scopedQuery('2015 2025 evidence', context)).toBe('2015 evidence');
        context.config.focusPoints = ['1945 年的历史背景'];
        expect(scopedQuery('1945 evidence', context)).toBe('1945 evidence');
    });
    it('gives equal-score sources from different hosts a first-batch opportunity', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.budget.maxSearches = 1;
        context.budget.maxPages = 3;
        searchResponse.results = ['one', 'one', 'one', 'two', 'three'].map((host, i) => ({
            ...searchResponse.results[0],
            title: 'Application deadline',
            originalUrl: `https://${host}.example/notice-${i}`,
            url: `https://${host}.example/notice-${i}`,
        }));
        tools.read = vi.fn(async (_key, url) => ({
            ...page,
            originalUrl: url,
            fetchedUrl: url,
            url,
        }));
        await runResearchAgent(context, deps);
        expect(vi.mocked(tools.read).mock.calls.map(([, url]) => new URL(url).hostname)).toEqual([
            'one.example',
            'two.example',
            'three.example',
        ]);
    });
    it('preserves a valid short conclusion when another brief item is too long and its repair fails', async () => {
        const { context, deps, tools } = fixture();
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            if (key === 'synthesize-1') {
                expect(input.prompt).toContain('brief_too_long');
                throw new ConnectorError('network', 'failed repair');
            }
            const response = await original(key, input);
            if (key === 'synthesize-0')
                return {
                    ...response,
                    data: {
                        claims: [
                            ...(response.data as { claims: unknown[] }).claims,
                            {
                                kind: 'inference',
                                text: 'A long interpretation. '.repeat(25),
                                questionIds: ['q0'],
                                citations: [{ pageId: 'read-0', quote: text }],
                            },
                        ],
                    },
                };
            return response;
        });
        const output = await runResearchAgent(context, deps);
        expect(output.claims).toHaveLength(1);
        expect(output.claims[0].kind).toBe('fact');
        expect(output.coverage.completeness).toBe('partial');
        expect(
            vi.mocked(tools.model).mock.calls.filter(([key]) => key.startsWith('synthesize')),
        ).toHaveLength(2);
    });
    it('preserves paraphrased facts as cited inference without spending a repair call', async () => {
        const { context, deps, tools } = fixture();
        context.config.outputFormat = 'research_report';
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            if (key === 'synthesize-1') {
                expect(input.prompt).toContain('fact_text_not_in_quote');
                throw new ConnectorError('network', 'secret fixture');
            }
            const response = await original(key, input);
            if (key === 'synthesize-0')
                return {
                    ...response,
                    data: {
                        claims: [
                            ...(response.data as { claims: unknown[] }).claims,
                            {
                                kind: 'fact',
                                text: 'A paraphrased deadline',
                                questionIds: ['q0'],
                                citations: [{ pageId: 'read-0', quote: text }],
                            },
                        ],
                    },
                };
            return response;
        });
        const output = await runResearchAgent(context, deps);
        expect(output.claims).toHaveLength(2);
        expect(output.claims[0].text).toBe('The application deadline is 15 November 2026.');
        expect(output.claims[1]).toMatchObject({
            kind: 'inference',
            text: 'A paraphrased deadline',
        });
        expect(output.coverage.completeness).toBe('partial');
        expect(output.coverage.research?.acceptedClaims).toBe(2);
        expect(vi.mocked(tools.model).mock.calls.map(([key]) => key)).toEqual([
            'plan-0',
            'synthesize-0',
        ]);
    });

    it('freezes the absolute window in planning and removes an invented conflicting year', async () => {
        const { context, deps, tools } = fixture();
        context.startedAt = new Date('2026-11-05T00:00:00Z');
        context.config.timeRange = { kind: 'rolling', days: 7 };
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            if (key === 'plan-0') {
                expect(input.prompt).toContain('2026-10-29T00:00:00.000Z');
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: {
                        queries: [{ query: 'Application deadline 2025', questionIds: ['q0'] }],
                    },
                };
            }
            return original(key, input);
        });
        await runResearchAgent(context, deps);
        expect(vi.mocked(tools.search).mock.calls[0][1]).toBe('Application deadline');
    });

    it('reads in batches and bounds supplemental searches without rereading failed URLs', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.budget.maxSearches = 5;
        tools.search = vi.fn(async (_key, query) => ({
            ...structuredClone(searchResponse),
            query,
            results: Array.from({ length: 3 }, (_, i) => ({
                ...searchResponse.results[0],
                url: `https://official.example/notice-${i}`,
                originalUrl: `https://official.example/notice-${i}`,
            })),
        }));
        tools.read = vi.fn(async () => {
            throw new ConnectorError('http', 'forbidden', false, 403);
        });
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        expect(tools.search).toHaveBeenCalledTimes(3);
        expect(tools.read).toHaveBeenCalledTimes(3);
        expect(new Set(vi.mocked(tools.read).mock.calls.map((call) => call[1])).size).toBe(3);
    });
    it.each([8000, DEFAULT_TASK_BUDGET.maxOutputTokens])(
        'repairs comparison truncation once within total %i output',
        async (maxOutputTokens) => {
            const { context, deps, tools } = fixture();
            context.budget.maxOutputTokens = maxOutputTokens;
            context.comparisonScopeHash = 'scope';
            const original = tools.model;
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key === 'compare-facts-v1')
                    throw new ConnectorError('output_truncated', 'secret');
                if (key === 'compare-facts-repair-v1')
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: { pages: [{ pageId: 'read-0', facts: [] }] },
                    };
                return original(key, input);
            });
            const result = await runResearchAgent(context, deps);
            expect(result.comparison).toBe('completed');
            const calls = vi.mocked(tools.model).mock.calls;
            const comparison = calls.filter(([key]) => key.startsWith('compare'));
            expect(comparison.map(([key]) => key)).toEqual([
                'compare-facts-v1',
                'compare-facts-repair-v1',
            ]);
            expect(comparison[1][1].maxOutputTokens).toBe(comparison[0][1].maxOutputTokens * 2);
            for (const [, input] of comparison) {
                expect(input.prompt.match(/hard cap /g)).toHaveLength(1);
                expect(input.prompt).toContain(`hard cap ${input.maxOutputTokens} tokens`);
            }
            expect(
                calls.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0),
            ).toBeLessThanOrEqual(maxOutputTokens);
            expect(comparison[1][1].untrustedSources).toEqual(comparison[0][1].untrustedSources);
        },
    );
    it.each(['network', 'output_truncated'] as const)(
        'bounds comparison %s and reserves failed planning/comparison/synthesis within the old budget',
        async (code) => {
            const { context, deps, tools } = fixture();
            context.comparisonScopeHash = 'scope';
            const original = tools.model;
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key === 'plan-0' || key === 'synthesize-0')
                    throw new ConnectorError('output_truncated', 'secret');
                if (key.startsWith('compare')) throw new ConnectorError(code, 'secret');
                return original(key, input);
            });
            const result = await runResearchAgent(context, deps);
            const calls = vi.mocked(tools.model).mock.calls;
            expect(calls.filter(([key]) => key.startsWith('compare'))).toHaveLength(
                code === 'network' ? 1 : 2,
            );
            expect(
                calls.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0),
            ).toBeLessThanOrEqual(8000);
            expect(result.comparison).toBe('not_performed');
            expect(result.claims.some((claim) => claim.kind === 'fact')).toBe(true);
            expect(result.coverage.completeness).toBe('partial');
        },
    );
    it('refits comparison repair instructions inside a nearly full input reservation', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        Object.assign(context.budget, DEFAULT_TASK_BUDGET, { maxSearches: 1, maxPages: 4 });
        context.comparisonScopeHash = 'scope';
        searchResponse.results = Array.from({ length: 4 }, (_, i) => ({
            ...searchResponse.results[0],
            originalUrl: `${url}/${i}`,
            url: `${url}/${i}`,
        }));
        const body = text + ' source context'.repeat(4000);
        tools.read = vi.fn(async (_key, target) => ({
            ...page,
            url: target,
            fetchedUrl: target,
            originalUrl: target,
            text: body,
            contentHash: createHash('sha256').update(body).digest('hex'),
        }));
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            expect(estimateModelInputTokens(input)).toBeLessThanOrEqual(input.maxInputTokens);
            if (key === 'compare-facts-v1') throw new ConnectorError('output_truncated', 'fixture');
            if (key === 'compare-facts-repair-v1')
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: {
                        pages: (input.untrustedSources as { pageId: string }[]).map((p) => ({
                            pageId: p.pageId,
                            facts: [],
                        })),
                    },
                };
            return original(key, input);
        });
        const result = await runResearchAgent(context, deps);
        expect(result.comparison).toBe('completed');
        const comparison = vi
            .mocked(tools.model)
            .mock.calls.filter(([key]) => key.startsWith('compare'));
        expect(comparison).toHaveLength(4);
        expect(comparison.every(([, input]) => input.untrustedSources!.length <= 3)).toBe(true);
        expect(estimateModelInputTokens(comparison[0][1])).toBeGreaterThan(95_900);
        expect(estimateModelInputTokens(comparison[1][1])).toBeLessThanOrEqual(96_000);
        expect(
            comparison.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0),
        ).toBeLessThanOrEqual(63_999);
        expect(result.coverage.gaps.join(' ')).toContain('比较修复输入受预算限制');
    });
    it.each([8000, DEFAULT_TASK_BUDGET.maxOutputTokens])(
        'repairs a truncated plan once within the fixed %i output budget, including synthesis repair',
        async (maxOutputTokens) => {
            const { context, deps, tools } = fixture();
            context.budget.maxOutputTokens = maxOutputTokens;
            context.comparisonScopeHash = 'scope';
            const original = tools.model;
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key === 'plan-0' || key === 'synthesize-0')
                    throw new ConnectorError('output_truncated', 'fixture secret');
                if (key === 'compare-facts-v1')
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: { pages: [{ pageId: 'read-0', facts: [] }] },
                    };
                return original(key, input);
            });
            const result = await runResearchAgent(context, deps);
            const calls = vi.mocked(tools.model).mock.calls;
            expect(calls.map(([key]) => key)).toEqual([
                'plan-0',
                'plan-1',
                'compare-facts-v1',
                'synthesize-0',
                'synthesize-1',
            ]);
            expect(calls[0][1].maxOutputTokens).toBeGreaterThanOrEqual(1000);
            expect(calls[1][1].maxOutputTokens).toBe(calls[0][1].maxOutputTokens * 2);
            expect(
                calls.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0),
            ).toBeLessThanOrEqual(maxOutputTokens);
            expect(result.claims[0].kind).toBe('fact');
            expect(JSON.stringify(result)).not.toContain('fixture secret');
        },
    );

    it.each(['output_truncated', 'network'] as const)(
        'falls back to bounded task queries after plan %s and never retries indefinitely',
        async (code) => {
            const { context, deps, tools } = fixture();
            const original = tools.model;
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key.startsWith('plan')) throw new ConnectorError(code, 'fixture secret');
                return original(key, input);
            });
            const result = await runResearchAgent(context, deps);
            expect(
                vi.mocked(tools.model).mock.calls.filter(([key]) => key.startsWith('plan')),
            ).toHaveLength(code === 'output_truncated' ? 2 : 1);
            expect(result.coverage.gaps.join(' ')).toContain('任务原文');
            expect(result.claims[0].kind).toBe('fact');
        },
    );

    it.each([false, true])(
        'reserves weighted comparison attempts before synthesis (repair=%s)',
        async (repair) => {
            const { context, deps, tools, searchResponse } = fixture();
            Object.assign(context.budget, DEFAULT_TASK_BUDGET, { maxSearches: 1, maxPages: 10 });
            context.comparisonScopeHash = 'scope';
            searchResponse.results = Array.from({ length: 10 }, (_, i) => ({
                ...searchResponse.results[0],
                url: `${url}/${i}`,
                originalUrl: `${url}/${i}`,
            }));
            tools.read = vi.fn(async (_key, target) => ({
                ...page,
                url: target,
                originalUrl: target,
                fetchedUrl: target,
            }));
            const original = tools.model;
            tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
                if (key.startsWith('compare')) {
                    if (repair && !key.startsWith('compare-facts-repair'))
                        throw new ConnectorError('output_truncated', 'fixture');
                    const sources = input.untrustedSources as { pageId: string }[];
                    expect(input.maxOutputTokens).toBe(
                        sources.length === 3
                            ? 9599
                            : key.startsWith('compare-facts-repair')
                              ? 3200
                              : 3199,
                    );
                    return {
                        mode: 'live',
                        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                        data: { pages: sources.map((p) => ({ pageId: p.pageId, facts: [] })) },
                    };
                }
                if (key === 'synthesize-0') throw new ConnectorError('output_truncated', 'fixture');
                return original(key, input);
            });
            const result = await runResearchAgent(context, deps);
            expect(result.comparison).toBe('completed');
            const calls = vi.mocked(tools.model).mock.calls;
            const comparisons = calls.filter(([key]) => key.startsWith('compare'));
            expect(comparisons).toHaveLength(repair ? 8 : 4);
            expect(comparisons.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0)).toBe(
                repair ? 63993 : 31996,
            );
            expect(
                calls.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0),
            ).toBeLessThanOrEqual(context.budget.maxOutputTokens);
            expect(calls.filter(([key]) => key.startsWith('synthesize'))).toHaveLength(2);
        },
    );
    it('allocates larger stage limits and doubles synthesis output on repair without exceeding the total', async () => {
        const { context, deps, tools } = fixture();
        Object.assign(context.budget, DEFAULT_TASK_BUDGET);
        context.comparisonScopeHash = 'scope';
        const body = `${'Source context. '.repeat(9000)}The application deadline is 15 November 2026.`;
        vi.mocked(tools.read).mockResolvedValue({
            ...page,
            text: body,
            contentHash: createHash('sha256').update(body).digest('hex'),
        });
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            if (key === 'compare-facts-v1')
                return {
                    mode: 'live',
                    usage: { inputTokens: 1, outputTokens: 1, estimated: false },
                    data: { pages: [{ pageId: 'read-0', facts: [] }] },
                };
            if (key === 'synthesize-0') throw new ConnectorError('output_truncated', 'fixture');
            return original(key, input);
        });
        const result = await runResearchAgent(context, deps);
        const calls = vi.mocked(tools.model).mock.calls;
        expect(calls.map(([key, input]) => [key, input.maxOutputTokens])).toEqual([
            ['plan-0', 4000],
            ['compare-facts-v1', 21333],
            ['synthesize-0', 32000],
            ['synthesize-1', 64000],
        ]);
        expect(
            calls.reduce((sum, [, input]) => sum + input.maxOutputTokens, 0),
        ).toBeLessThanOrEqual(context.budget.maxOutputTokens);
        expect(calls.reduce((sum, [, input]) => sum + input.maxInputTokens, 0)).toBeLessThanOrEqual(
            context.budget.maxInputTokens,
        );
        for (const [, input] of calls.filter(([key]) => key.startsWith('synthesize'))) {
            expect(input.prompt).toContain(`hard cap ${input.maxOutputTokens} tokens`);
            expect(input.prompt.match(/hard cap /g)).toHaveLength(1);
            expect(input.maxInputTokens).toBe(256000);
            expect(estimateModelInputTokens(input)).toBeGreaterThan(96000);
            expect(JSON.stringify(input.untrustedSources)).toContain(body);
        }
        expect(result.claims[0].kind).toBe('fact');
    });
    it.each([
        ['2026-10-25T00:00:00Z', 'complete'],
        ['2026-09-01T00:00:00Z', 'partial'],
        ['2026-10-27T00:00:00Z', 'partial'],
        ['2026-10-25', 'partial'],
    ] as const)(
        'validates source-declared publication %s against the fixed Run window',
        async (rawValue, completeness) => {
            const { context, deps, tools } = fixture();
            context.startedAt = new Date('2026-10-26T00:00:00Z');
            tools.read = vi.fn(async (): Promise<ReadPage> => ({
                ...structuredClone(page),
                publication: {
                    parserVersion: 'scova-publication-v1',
                    status: 'known',
                    instant: '2026-10-25T00:00:00Z',
                    observations: [
                        { field: 'article:published_time', rawValue, locator: 'meta[0]' },
                    ],
                },
            }));
            const result = await runResearchAgent(context, deps);
            expect(result.coverage.completeness).toBe(completeness);
            if (completeness === 'complete') expect(result.coverage.gaps).toEqual([]);
            else expect(result.coverage.gaps.join(' ')).toMatch(/时间范围/);
        },
    );

    it('uses configured fixed time bounds and retains official-source uncertainty as a note', async () => {
        const { context, deps, tools } = fixture();
        context.config.timeRange = {
            kind: 'fixed',
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-26T00:00:00Z',
        };
        context.config.sourcePreferences = {
            preferredUrls: [url],
            excludedUrls: [],
            officialOnly: true,
        };
        tools.read = vi.fn(async (): Promise<ReadPage> => ({
            ...structuredClone(page),
            publication: {
                parserVersion: 'scova-publication-v1',
                status: 'known',
                instant: null,
                observations: [
                    {
                        field: 'datePublished',
                        rawValue: '2026-10-25T00:00:00Z',
                        locator: 'jsonld[0]$.datePublished',
                    },
                ],
            },
        }));
        const result = await runResearchAgent(context, deps);
        expect(result.coverage.completeness).toBe('complete');
        expect(result.coverage.notes?.join(' ')).toContain('官方身份');
        expect(result.coverage.gaps).toEqual([]);
        expect(result.coverage.gaps.join(' ')).not.toContain('时间范围未核验');
    });

    it('checkpoints every graph node and returns only quoted body evidence', async () => {
        const { context, deps, promote } = fixture();
        const output = await runResearchAgent(context, deps);
        expect(output.mode).toBe('live');
        expect(output.pages[0].text).toBe(text);
        expect(output.claims[0].citations[0]).toEqual({
            pageId: 'read-0',
            quote: 'The application deadline is 15 November 2026.',
        });
        expect(output.coverage.completeness).toBe('partial');
        expect(output.coverage.gaps.join(' ')).toContain('时间窗口尚未固定');
        expect(output.comparison).toBe('not_performed');
        expect(promote).toHaveBeenCalledTimes(10);
        expect(
            promote.mock.calls.every(([config]) => Boolean(config.configurable?.checkpoint_id)),
        ).toBe(true);
    });

    it('rejects search snippets as evidence when body retrieval fails', async () => {
        const { context, deps, tools } = fixture();
        vi.mocked(tools.read).mockRejectedValue(new Error('page not reachable'));
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        expect(tools.model).toHaveBeenCalledTimes(1);
    });

    it('retains a claim with fabricated citations as uncertain content without saving the fake quote', async () => {
        const { context, deps, tools } = fixture();
        vi.mocked(tools.model).mockImplementation(async (key) => ({
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data:
                key === 'plan-0'
                    ? { queries: [{ query: 'deadline', questionIds: ['q0'] }] }
                    : {
                          claims: [
                              {
                                  kind: 'fact',
                                  text: 'invented',
                                  questionIds: ['q0'],
                                  citations: [{ pageId: 'foreign-run', quote: 'invented' }],
                              },
                          ],
                      },
        }));
        const output = await runResearchAgent(context, deps);
        expect(tools.model).toHaveBeenCalledTimes(3);
        expect(output.coverage.completeness).toBe('partial');
        expect(output.coverage.reportValue?.questions[0].status).toBe('unresolved');
        expect(output.coverage.gaps.join(' ')).toContain('尚无直接回答');
        expect(output.claims[0].kind).toBe('insufficient');
        expect(output.claims[0].text).toBe('invented');
        expect(output.claims[0].text).not.toContain(text);
        expect(output.claims[0].citations).toEqual([]);
        expect(output.claims[0].uncertainty).toContain('quote_unmatched');
    });

    it('gives synthesis its own output allocation and includes the end of a long source', async () => {
        const { context, deps, tools } = fixture();
        context.budget.maxInputTokens = 60_000;
        const body = `${'这是背景资料。'.repeat(600)}最后结论：申请需提前准备。`;
        vi.mocked(tools.read).mockResolvedValue({
            ...page,
            text: body,
            contentHash: createHash('sha256').update(body).digest('hex'),
        });
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            if (key.startsWith('plan')) return original(key, input);
            expect(input.maxOutputTokens).toBeGreaterThan(1500);
            expect(input.prompt).toContain('in your own words');
            expect(JSON.stringify(input.untrustedSources)).toContain('最后结论');
            expect(estimateModelInputTokens(input)).toBeLessThanOrEqual(input.maxInputTokens);
            return {
                mode: 'live',
                usage: { inputTokens: 100, outputTokens: 100, estimated: false },
                data: {
                    claims: [
                        {
                            kind: 'inference',
                            text: '申请准备应前置，预留充足办理时间。',
                            questionIds: ['q0'],
                            citations: [{ pageId: 'read-0', quote: '申请需提前准备。' }],
                        },
                    ],
                },
            };
        });
        const result = await runResearchAgent(context, deps);
        expect(result.claims[0].text).toBe('申请准备应前置，预留充足办理时间。');
        expect(result.coverage.gaps.join(' ')).not.toContain('综合输入受预算限制');
    });

    it('discards length-limited output and does not publish source text as a summary', async () => {
        const { context, deps, tools } = fixture();
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) => {
            if (key.startsWith('plan')) return original(key, input);
            throw new ConnectorError('output_truncated', 'fixture secret content');
        });
        const result = await runResearchAgent(context, deps);
        expect(tools.model).toHaveBeenCalledTimes(3);
        expect(result.coverage.completeness).toBe('partial');
        expect(result.coverage.gaps.join(' ')).toContain('输出达到长度上限');
        expect(result.claims[0].kind).toBe('insufficient');
        expect(result.claims[0].text).not.toContain(text);
        expect(JSON.stringify(result)).not.toContain('fixture secret');
    });

    it('rejects a long copied brief even with a valid source quote', async () => {
        const { context, deps, tools } = fixture();
        const body = 'This is a sentence about application preparation. '.repeat(12);
        vi.mocked(tools.read).mockResolvedValue({
            ...page,
            text: body,
            contentHash: createHash('sha256').update(body).digest('hex'),
        });
        const original = tools.model;
        tools.model = vi.fn<AgentTools['model']>(async (key, input) =>
            key.startsWith('plan')
                ? original(key, input)
                : {
                      mode: 'live',
                      usage: { inputTokens: 10, outputTokens: 10, estimated: false },
                      data: {
                          claims: [
                              {
                                  kind: 'fact',
                                  text: body,
                                  questionIds: ['q0'],
                                  citations: [{ pageId: 'read-0', quote: body }],
                              },
                          ],
                      },
                  },
        );
        const result = await runResearchAgent(context, deps);
        expect(result.claims[0].kind).toBe('insufficient');
        expect(result.claims[0].citations[0].quote.endsWith('.')).toBe(true);
        expect(result.claims[0].text).not.toContain('This is a sentence');
    });

    it('requires paraphrased conclusions to be marked inference', async () => {
        const { context, deps, tools } = fixture();
        vi.mocked(tools.model).mockImplementation(async (key) => ({
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data:
                key === 'plan-0'
                    ? { queries: [{ query: 'deadline', questionIds: ['q0'] }] }
                    : {
                          claims: [
                              {
                                  kind: 'inference',
                                  text: 'Applying early may be prudent.',
                                  questionIds: ['q0'],
                                  citations: [
                                      {
                                          pageId: 'read-0',
                                          quote: 'The application deadline is 15 November 2026.',
                                      },
                                  ],
                              },
                          ],
                      },
        }));
        const output = await runResearchAgent(context, deps);
        expect(output.claims[0].kind).toBe('inference');
        expect(output.coverage.completeness).toBe('partial');
    });

    it('keeps provider failures and truncated body as coverage gaps', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        searchResponse.coverage.complete = false;
        searchResponse.coverage.gaps = ['bing timeout'];
        vi.mocked(tools.read).mockResolvedValue({ ...page, truncated: true });
        const output = await runResearchAgent(context, deps);
        expect(output.coverage.completeness).toBe('partial');
        expect(output.coverage.gaps.join(' ')).toContain('bing timeout');
        expect(output.coverage.gaps.join(' ')).toContain('截断');
    });

    it('never accepts a redirected source excluded by the owner', async () => {
        const { context, deps, tools } = fixture();
        context.config.sourcePreferences.excludedUrls = ['https://excluded.example/'];
        vi.mocked(tools.read).mockResolvedValue({
            ...page,
            url: 'https://excluded.example/story',
            fetchedUrl: 'https://excluded.example/story',
        });
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
    });

    it('does not let a model or ranking declare arbitrary sources official', async () => {
        const { context, deps, tools } = fixture();
        context.config.sourcePreferences.officialOnly = true;
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        expect(tools.read).not.toHaveBeenCalled();
    });

    it('reuses explicitly promoted graph state after a simulated restart', async () => {
        const { context, deps, tools, saver } = fixture();
        let authorized: RunnableConfig | undefined;
        let interrupted = false;
        deps.promote = async (config) => {
            authorized = config;
            const tuple = await saver.getTuple(config);
            const saved = tuple?.checkpoint.channel_values.research as
                | { pages?: unknown[] }
                | undefined;
            if (!interrupted && saved?.pages?.length) {
                interrupted = true;
                throw new Error('worker exit after persistence');
            }
        };
        await expect(runResearchAgent(context, deps)).rejects.toThrow('worker exit');
        const readCalls = vi.mocked(tools.read).mock.calls.length;
        const output = await runResearchAgent(context, {
            ...deps,
            config: authorized!,
            resume: true,
            promote: async () => {},
        });
        expect(output.pages).toHaveLength(1);
        expect(tools.read).toHaveBeenCalledTimes(readCalls);
        expect(tools.search).toHaveBeenCalledTimes(1);
    });

    it('deadline resume reads only explicit checkpoint body and makes no external calls', async () => {
        const { context, deps, tools, saver } = fixture();
        let authorized: RunnableConfig | undefined;
        deps.promote = async (config) => {
            authorized = config;
            const tuple = await saver.getTuple(config);
            if ((tuple?.checkpoint.channel_values.research as { pages?: unknown[] })?.pages?.length)
                throw new Error('restart');
        };
        await expect(runResearchAgent(context, deps)).rejects.toThrow('restart');
        vi.mocked(tools.search).mockClear();
        vi.mocked(tools.read).mockClear();
        vi.mocked(tools.model).mockClear();
        context.deadlineAt = new Date(0);
        const output = await runResearchAgent(context, {
            ...deps,
            config: authorized!,
            resume: true,
        });
        expect(output.coverage.exhausted).toContain('time');
        expect(output.coverage.completeness).toBe('partial');
        expect(tools.search).not.toHaveBeenCalled();
        expect(tools.read).not.toHaveBeenCalled();
        expect(tools.model).not.toHaveBeenCalled();
    });

    it('requires explicit checkpoint IDs and matching owner/run/version identity', async () => {
        const { context, deps } = fixture();
        await expect(runResearchAgent(context, { ...deps, resume: true })).rejects.toMatchObject({
            code: 'INVALID_STATE',
        });
        await runResearchAgent(context, deps);
        const config = vi.mocked(deps.promote).mock.calls.at(-1)![0];
        await expect(
            runResearchAgent({ ...context, userId: 'attacker' }, { ...deps, config, resume: true }),
        ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('rejects late promotion and does not advance to the next tool', async () => {
        const { context, deps, tools } = fixture();
        deps.promote = async () => {
            throw new Error('stale epoch');
        };
        await expect(runResearchAgent(context, deps)).rejects.toThrow('stale epoch');
        expect(tools.search).not.toHaveBeenCalled();
        expect(tools.model).not.toHaveBeenCalled();
    });

    it('cancellation or lost lease never yields a candidate', async () => {
        const { context, deps, controller, tools } = fixture();
        controller.abort();
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: 'ABORTED' });
        expect(tools.search).not.toHaveBeenCalled();
        const second = fixture();
        second.context.assertActive = async () => {
            throw new Error('lost epoch');
        };
        await expect(runResearchAgent(second.context, second.deps)).rejects.toThrow('lost epoch');
    });

    it('delegates exhausted or unknown reservation decisions to the durable ledger', async () => {
        const { context, deps, tools } = fixture();
        context.usage.searches = context.budget.maxSearches;
        context.usage.inputTokens = context.budget.maxInputTokens;
        vi.mocked(tools.model).mockRejectedValue(new Error('durable ledger budget exceeded'));
        vi.mocked(tools.search).mockRejectedValue(new Error('durable ledger budget exceeded'));
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        expect(tools.model).toHaveBeenCalledTimes(1);
        expect(tools.search).toHaveBeenCalledTimes(1);
    });

    it('uses fixed demo flow without sending the demo model a live plan schema', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        context.mode = 'demo';
        searchResponse.mode = 'demo';
        searchResponse.provider = 'demo';
        vi.mocked(tools.read).mockResolvedValue({ ...page, mode: 'demo' });
        const output = await runResearchAgent(context, deps);
        expect(output.mode).toBe('demo');
        expect(output.demoReason).toBeTruthy();
        expect(output.coverage.completeness).toBe('partial');
        expect(tools.model).not.toHaveBeenCalled();
    });

    it('deterministic deadline projection rejects fabricated hashes and mode mixing', () => {
        const { context } = fixture();
        expect(() =>
            deterministicPartial(context, [
                { ...page, id: 'read-0', questionIds: ['q0'], contentHash: 'forged' },
            ]),
        ).toThrow();
        expect(() =>
            deterministicPartial(context, [
                { ...page, id: 'read-0', questionIds: ['q0'], mode: 'demo' },
            ]),
        ).toThrow();
        expect(
            deterministicPartial(context, [{ ...page, id: 'read-0', questionIds: ['q0'] }]).coverage
                .completeness,
        ).toBe('partial');
    });

    it('caps hostile plans and never executes suggested tools, URLs or scripts', async () => {
        const { context, deps, tools } = fixture();
        vi.mocked(tools.model).mockImplementation(async () => ({
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: {
                queries: Array.from({ length: 11 }, () => ({
                    query: 'http://169.254.169.254/metadata',
                    questionIds: ['q0'],
                    tool: 'execute_script',
                })),
            },
        }));
        const output = await runResearchAgent(context, deps);
        expect(tools.search).toHaveBeenCalledTimes(1);
        expect(vi.mocked(tools.search).mock.calls[0][1]).toContain(context.config.topic);
        expect(output.coverage.gaps.join(' ')).toContain('模型规划失败');
        expect(tools.model).toHaveBeenCalledTimes(3);
        expect(output.coverage.completeness).toBe('partial');
    });

    it('cannot declare all subquestions covered when the fixed search budget omits one', async () => {
        const { context, deps, tools } = fixture();
        context.config.focusPoints = ['What are the requirements?', 'What documents are needed?'];
        context.budget.maxSearches = 1;
        const output = await runResearchAgent(context, deps);
        expect(tools.search).toHaveBeenCalledTimes(1);
        expect(output.coverage.gaps.join(' ')).toContain('子问题');
        expect(output.coverage.completeness).toBe('partial');
    });

    it('cancellation while a body result returns cannot promote it or create a candidate', async () => {
        const { context, deps, tools, controller } = fixture();
        vi.mocked(tools.read).mockImplementation(async () => {
            controller.abort();
            return page;
        });
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({ code: 'ABORTED' });
        expect(tools.model).toHaveBeenCalledTimes(1);
    });

    it('rejects mixed demo data during live execution', async () => {
        const { context, deps, tools, searchResponse } = fixture();
        vi.mocked(tools.search).mockResolvedValue({ ...searchResponse, mode: 'demo' });
        await expect(runResearchAgent(context, deps)).rejects.toMatchObject({
            code: 'NO_EVIDENCE',
        });
        expect(tools.read).not.toHaveBeenCalled();
    });

    it('revalidates saved claims rather than trusting a corrupt ready checkpoint', async () => {
        const { context, deps, saver, promote } = fixture();
        await runResearchAgent(context, deps);
        const config = promote.mock.calls.at(-1)![0];
        const tuple = (await saver.getTuple(config))!;
        const research = tuple.checkpoint.channel_values.research as {
            claims: { citations: { quote: string }[] }[];
        };
        research.claims[0].citations[0].quote = 'not present in source';
        const corrupted = await saver.put(
            config,
            { ...tuple.checkpoint, id: crypto.randomUUID() },
            tuple.metadata!,
        );
        await expect(
            runResearchAgent(context, { ...deps, config: corrupted, resume: true }),
        ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    });

    it('emits completed step events only after authorized checkpoint promotion', async () => {
        const { context, deps } = fixture();
        const calls: string[] = [];
        deps.promote = async () => {
            calls.push('promoted');
        };
        deps.onStep = async (step, phase) => {
            calls.push(`${step}:${phase}`);
        };
        await runResearchAgent(context, deps);
        expect(calls.slice(0, 3)).toEqual([
            'load_context:started',
            'promoted',
            'load_context:completed',
        ]);
        expect(calls.at(-1)).toBe('validate:completed');
    });

    it('allows the ledger to reuse last-budget search/read/model results after checkpoint loss', async () => {
        const { context, deps, tools, saver, promote } = fixture();
        context.budget.maxSearches = 1;
        context.budget.maxPages = 1;
        await runResearchAgent(context, deps);
        // Restore an earlier authorized graph checkpoint; ToolCall results may already be committed.
        const earlier = promote.mock.calls[0][0];
        context.usage = {
            searches: 1,
            pages: 1,
            inputTokens: 40_000,
            outputTokens: 8000,
            estimated: true,
        };
        const originalCaps = vi.mocked(tools.model).mock.calls[0][1];
        vi.mocked(tools.search).mockClear();
        vi.mocked(tools.read).mockClear();
        vi.mocked(tools.model).mockClear();
        const candidate = await runResearchAgent(context, {
            ...deps,
            checkpointer: saver,
            config: earlier,
            resume: true,
        });
        expect(candidate.pages).toHaveLength(1);
        expect(tools.search).toHaveBeenCalledTimes(1);
        expect(tools.read).toHaveBeenCalledTimes(1);
        expect(tools.model).toHaveBeenCalledTimes(2);
        expect(vi.mocked(tools.model).mock.calls[0][1]).toEqual(originalCaps);
    });
});
