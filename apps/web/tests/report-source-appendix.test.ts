// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import type { Evidence, Report } from '@scova/models';
import {
    distinctEvidenceQuotes,
    evidencePageUrl,
    groupEvidence,
    groupEvidenceVersions,
} from '@/utils/evidence-groups';

const evidence = (number: number, overrides: Partial<Evidence> = {}): Evidence => ({
    id: `evidence-${number}`,
    sourceId: 'source-a',
    snapshotId: 'snapshot-a',
    title: '开放安排',
    url: 'https://example.test/library',
    quote: '工作日开放。',
    location: '第1段',
    observedAt: '2026-11-11T03:00:00Z',
    ...overrides,
});

describe('one webpage, immutable saved versions', () => {
    it('normalizes tracking and fragments, retaining meaningful queries and stable order', () => {
        const original = evidence(1, {
            url: 'https://EXAMPLE.test:443/library?b=2&utm_source=mail&a=1#open',
        });
        const second = evidence(2, {
            sourceId: 'other-source',
            snapshotId: 'snapshot-b',
            url: 'https://example.test/library?a=1&fbclid=tracking&b=2',
            quote: '周末开放。',
        });
        const differentPage = evidence(3, { url: 'https://example.test/library?a=2&b=2' });
        const input = [original, second, differentPage];
        const before = structuredClone(input);
        expect(evidencePageUrl(original)).toBe('https://example.test/library?a=1&b=2');
        const pages = groupEvidence(input);
        expect(pages).toHaveLength(2);
        expect(pages[0]!.evidence.map((entry) => entry.id)).toEqual(['evidence-1', 'evidence-2']);
        const versions = groupEvidenceVersions(pages[0]!.evidence);
        expect(versions).toHaveLength(2);
        expect(
            versions.map((version) => distinctEvidenceQuotes(version.evidence)[0]!.evidence.quote),
        ).toEqual(['工作日开放。', '周末开放。']);
        expect(input).toEqual(before);
    });

    it('prefers a saved canonical page and never merges equal quotes from different snapshots', () => {
        const original = evidence(1);
        const canonical = evidence(2, {
            url: 'https://mirror.test/redirect',
            snapshotId: 'snapshot-b',
            snapshot: { canonicalUrl: original.url } as Evidence['snapshot'],
        });
        const pages = groupEvidence([original, canonical, evidence(3)]);
        expect(pages).toHaveLength(1);
        expect(groupEvidenceVersions(pages[0]!.evidence)).toHaveLength(2);
        const quotes = distinctEvidenceQuotes(pages[0]!.evidence);
        expect(quotes).toHaveLength(2);
        expect(quotes[0]!.ids).toEqual(['evidence-1', 'evidence-3']);
        expect(quotes[1]!.ids).toEqual(['evidence-2']);
    });
});

describe('actual report source appendix', () => {
    let server: ViteDevServer;
    let sources: Component;
    let claim: Component;
    let field: Component;
    let panel: Component;
    beforeAll(async () => {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        server = await createServer({
            configFile: false,
            root,
            plugins: [vue()],
            optimizeDeps: { noDiscovery: true, include: [] },
            resolve: { alias: { '@': resolve(root, 'src') } },
            server: { middlewareMode: true, watch: null, hmr: false },
            appType: 'custom',
        });
        sources = (await server.ssrLoadModule('/src/components/reports/ReportSources.vue')).default;
        claim = (await server.ssrLoadModule('/src/components/reports/ReportClaim.vue')).default;
        field = (await server.ssrLoadModule('/src/components/reports/ReportStructuredValue.vue'))
            .default;
        panel = (await server.ssrLoadModule('/src/components/reports/ReportArtifactPanel.vue'))
            .default;
    });
    afterAll(async () => server?.close());

    it('places one projected appendix after history, retaining change-only evidence and excluding other artifact claims', async () => {
        const report = {
            id: 'report-a',
            title: '保存报告',
            summary: '概述',
            format: 'brief',
            mode: 'demo',
            publishedAt: '2026-11-11T03:00:00Z',
            limitations: [],
            taskVersionId: 'version-a',
            baselineRunId: null,
            coverage: {
                completeness: 'complete',
                searchedQueries: [],
                gaps: [],
                exhausted: [],
                artifacts: [
                    { format: 'brief', claimIndexes: [0], summary: '简报概述' },
                    { format: 'list', claimIndexes: [1], summary: '清单概述' },
                ],
            },
            claims: [
                {
                    id: 'owned',
                    text: '当前成果',
                    kind: 'fact',
                    confidenceLabel: '直接支持',
                    evidenceIds: ['evidence-1'],
                },
                {
                    id: 'other',
                    text: '另一成果',
                    kind: 'fact',
                    confidenceLabel: '另一依据',
                    evidenceIds: ['evidence-2'],
                },
            ],
            evidence: [
                evidence(1),
                evidence(2, { url: 'https://example.test/other' }),
                evidence(3, { url: 'https://example.test/history', snapshotId: 'old-snapshot' }),
            ],
            changes: [
                {
                    id: 'change-a',
                    kind: 'new',
                    factKey: '新增资料',
                    important: false,
                    reason: '新增保存资料',
                    oldValue: null,
                    newValue: '新值',
                    oldEvidenceIds: [],
                    newEvidenceIds: ['evidence-3'],
                },
            ],
        } as unknown as Report;
        const before = structuredClone(report);
        const output = await renderToString(
            createSSRApp({
                render: () =>
                    h(panel, {
                        report,
                        reading: true,
                        loading: false,
                        retryable: false,
                        errorMessage: '',
                    }),
            }).use(createPinia()),
        );
        const document = new DOMParser().parseFromString(output, 'text/html');
        expect(document.querySelectorAll('.evidence-appendix')).toHaveLength(1);
        const appendix = document.querySelector('.evidence-appendix')!;
        expect(
            appendix.compareDocumentPosition(document.querySelector('.report-changes')!) &
                Node.DOCUMENT_POSITION_PRECEDING,
        ).toBeTruthy();
        expect(appendix.querySelector('#evidence-evidence-1')).not.toBeNull();
        expect(appendix.querySelector('#evidence-evidence-3')).not.toBeNull();
        expect(appendix.querySelector('#evidence-evidence-2, #claim-support-other')).toBeNull();
        expect(
            document.querySelector('#comparison-change-a-new-evidence-3')?.getAttribute('href'),
        ).toBe('#evidence-evidence-3');
        expect(appendix.querySelector('.change-provenance')).toBeNull();
        expect(report).toEqual(before);
    });

    it('keeps omitted material provenance without a broken body anchor', async () => {
        const report = {
            claims: [
                {
                    id: 'omitted',
                    kind: 'fact',
                    confidenceLabel: '未选用',
                    evidenceIds: ['evidence-1'],
                },
            ],
            evidence: [evidence(1)],
            changes: [],
            coverage: { reportValue: { selections: [{ claimIndex: 0, placement: 'omitted' }] } },
        } as unknown as Report;
        const output = await renderToString(createSSRApp({ render: () => h(sources, { report }) }));
        const document = new DOMParser().parseFromString(output, 'text/html');
        expect(document.querySelector('#claim-support-omitted')?.textContent).toContain('材料 1');
        expect(document.querySelector('a[href="#claim-omitted"]')).toBeNull();
    });

    it('suppresses only conditions and gaps already in visible field text, retaining unknown-field conditions', async () => {
        const report = {
            claims: [{ id: 'a', kind: 'fact' }],
            coverage: {
                reportValue: {
                    selections: [
                        {
                            claimIndex: 0,
                            assessment: { conditions: '工作日适用', gap: '费用待核实' },
                        },
                    ],
                },
            },
        } as unknown as Report;
        const renderField = async (status: string, text: string, gap: string) =>
            new DOMParser().parseFromString(
                await renderToString(
                    createSSRApp({
                        render: () =>
                            h(field, { report, value: { text, status, claimIndexes: [0], gap } }),
                    }),
                ),
                'text/html',
            );
        const complete = await renderField('supported', '工作日适用，费用待核实。', '');
        expect(complete.querySelector('.structured-condition, .structured-gap')).toBeNull();
        const unknown = await renderField('unknown', '工作日适用，费用待核实。', '未读取到本项');
        expect(unknown.querySelector('.structured-condition')?.textContent).toContain('工作日适用');
        expect(unknown.querySelector('.structured-gap')?.textContent).toContain('费用待核实');
    });

    it('lists one external page link with all version quotes and legacy citation anchors at the end', async () => {
        const report = {
            claims: [
                {
                    id: 'claim-a',
                    text: '使用安排',
                    kind: 'fact',
                    confidenceLabel: '来源直接支持',
                    evidenceIds: ['evidence-1', 'evidence-2', 'evidence-3'],
                },
            ],
            evidence: [
                evidence(1),
                evidence(2),
                evidence(3, { snapshotId: 'snapshot-b', quote: '周末开放。' }),
            ],
            coverage: {},
            changes: [],
        } as unknown as Report;
        const output = await renderToString(createSSRApp({ render: () => h(sources, { report }) }));
        const document = new DOMParser().parseFromString(output, 'text/html');
        expect(document.querySelectorAll('.evidence-source-group')).toHaveLength(1);
        expect(document.querySelectorAll('.source-page-link')).toHaveLength(1);
        expect(document.querySelectorAll('a[target="_blank"]')).toHaveLength(1);
        expect(document.querySelectorAll('.source-version')).toHaveLength(2);
        expect(
            [...document.querySelectorAll('blockquote')].map((node) => node.textContent),
        ).toEqual(['工作日开放。', '周末开放。']);
        for (const entry of report.evidence) {
            expect(document.getElementById(`evidence-${entry.id}`)).not.toBeNull();
            expect(document.getElementById(`claim-claim-a-evidence-${entry.id}`)).not.toBeNull();
        }
        expect(document.querySelector('.claim-provenance')?.textContent).toContain('来源直接支持');
        expect(document.querySelector('.citation-history')).toBeNull();
    });

    it('keeps main claim anchors and conditions while removing body and table source controls', async () => {
        const report = {
            claims: [
                {
                    id: 'a',
                    text: '事实正文',
                    kind: 'fact',
                    confidenceLabel: '直接支持',
                    evidenceIds: ['evidence-1'],
                },
            ],
            evidence: [evidence(1)],
            coverage: {
                reportValue: {
                    selections: [
                        {
                            claimIndex: 0,
                            placement: 'main',
                            assessment: { conditions: '工作日适用', gap: '' },
                        },
                    ],
                },
            },
        } as unknown as Report;
        const output = await renderToString(
            createSSRApp({
                render: () =>
                    h('main', [
                        h(claim, { report, claim: report.claims[0], compact: true }),
                        h(field, {
                            report,
                            value: {
                                text: '事实正文',
                                status: 'supported',
                                claimIndexes: [0],
                                gap: '',
                            },
                        }),
                    ]),
            }),
        );
        const document = new DOMParser().parseFromString(output, 'text/html');
        expect(document.getElementById('claim-a')).not.toBeNull();
        expect(document.body.textContent).toContain('工作日适用');
        expect(
            document.querySelector('a, .citations, .structured-links, .confidence-details'),
        ).toBeNull();
    });
});
