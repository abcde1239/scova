import { createSearchApi, createSafeHttpClient, ConnectorError } from '@scova/connectors';
import { expect, it } from 'vite-plus/test';
import { scenarioConnectors } from '../support/acceptance-scenario-fixtures.ts';
import { setup, sessionFixture, takeover } from './fixture.ts';

export function registerApiPages() {
    it('API正文从持久搜索账本跨epoch恢复，不访问原站且只计一次读取', async () => {
        const seed = await setup({ mode: 'live' });
        const url = 'https://source.example/pricing';
        let searches = 0,
            reads = 0;
        const bundle = scenarioConnectors('research', 'A');
        bundle.search = createSearchApi({
            protocol: 'deepseek',
            apiKey: 'search-key',
            contentMode: 'prefer_api',
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: async () => {
                    searches++;
                    return {
                        status: 200,
                        headers: {},
                        body: JSON.stringify({
                            results: [
                                {
                                    url,
                                    title: 'Pricing',
                                    snippet: 'Pricing snippet',
                                    content: 'The plan costs $20 per month when billed annually.',
                                },
                            ],
                        }),
                    };
                },
            }),
        });
        bundle.reader = {
            async read(_url, options) {
                reads++;
                await options?.beforeAttempt?.('read');
                throw new ConnectorError('network', 'Origin temporarily unavailable');
            },
        };
        const first = sessionFixture(seed, bundle);
        try {
            await first.session.tools.search('body-search', 'pricing');
            const next = await takeover(seed.run.id);
            const resumed = sessionFixture({ ...seed, ...next }, bundle);
            try {
                const page = await resumed.session.tools.read('body-read', url);
                expect(page.text).toBe('The plan costs $20 per month when billed annually.');
                expect(page.extractionVersion).toBe('search-api/deepseek/v1');
                expect(await resumed.session.tools.read('body-read', url)).toEqual(page);
                expect(await next.repo.usage()).toMatchObject({ searches: 1, pages: 1 });
                expect(searches).toBe(1);
                expect(reads).toBe(0);
                expect(await next.repo.readPages()).toHaveLength(1);
                const isolated = await setup({ mode: 'live' });
                expect(await isolated.repo.searchPage!(url)).toBeNull();
            } finally {
                await resumed.close();
            }
        } finally {
            await first.close();
        }
    });

    it('非空API正文直接进入读取账本，跨epoch复用不访问原站', async () => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        const sample = await bundle.search.search('fixture');
        const url = sample.results[0].url;
        bundle.search = createSearchApi({
            protocol: 'deepseek',
            apiKey: 'fixture-only',
            contentMode: 'prefer_api',
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: async () => ({
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        results: [
                            {
                                url,
                                title: 'Source',
                                snippet: 'Summary',
                                content: 'Introduction. date._',
                            },
                        ],
                    }),
                }),
            }),
        });
        const origin = bundle.reader.read.bind(bundle.reader);
        let reads = 0;
        bundle.reader.read = async (target, options) => {
            reads++;
            return origin(target, options);
        };
        const first = sessionFixture(seed, bundle);
        try {
            await first.session.tools.search('body-search', 'fixture');
            const full = await first.session.tools.read('body-full', url);
            expect(full.extractionVersion).toBe('search-api/deepseek/v1');
            expect(full.text).toBe('Introduction. date._');
            const next = await takeover(seed.run.id);
            const resumed = sessionFixture({ ...seed, ...next }, bundle);
            try {
                expect(await resumed.session.tools.read('body-full', url)).toEqual(full);
                expect(reads).toBe(0);
                expect(await next.repo.usage()).toMatchObject({ searches: 1, pages: 1 });
                expect(await next.repo.readPages()).toHaveLength(1);
            } finally {
                await resumed.close();
            }
        } finally {
            await first.close();
        }
    });

    it.each(['', '   '])('API仅有摘要时由API远程读取（正文=%j）并保留页面预算', async (content) => {
        const seed = await setup({ mode: 'live' });
        const bundle = scenarioConnectors('research', 'A');
        const candidate = await bundle.search.search('fixture');
        const url = candidate.results[0].url;
        const provider = createSearchApi({
            protocol: 'deepseek',
            apiKey: 'search-key',
            contentMode: 'prefer_api',
            http: createSafeHttpClient({
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: async (target) => ({
                    status: 200,
                    headers: {},
                    body: JSON.stringify(
                        target.pathname.endsWith('/fetch')
                            ? { title: 'Source', content: 'Fetched remotely by API.' }
                            : {
                                  results: [
                                      {
                                          url,
                                          title: 'Source',
                                          snippet: 'Summary only',
                                          content,
                                          summary: 'Generated summary is not evidence',
                                      },
                                  ],
                              },
                    ),
                }),
            }),
        });
        bundle.search = provider;
        bundle.searchProvider = 'api';
        bundle.reader = provider;
        let reads = 0;
        const read = provider.read.bind(provider);
        bundle.reader.read = async (target, options) => {
            reads++;
            return read(target, options);
        };
        const active = sessionFixture(seed, bundle);
        try {
            await active.session.tools.search('snippet-search', 'fixture');
            const page = await active.session.tools.read('fallback-read', url);
            expect(reads).toBe(1);
            expect(page.extractionVersion).toBe('search-api/deepseek/fetch-v1');
            expect(page.text).toBe('Fetched remotely by API.');
            expect(page.text).not.toContain('Generated summary');
            expect(await seed.repo.usage()).toMatchObject({ searches: 1, pages: 1 });
        } finally {
            await active.close();
        }
    });
}
