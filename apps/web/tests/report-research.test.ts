import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import { ReportSchema, parseContract, type Report } from '@scova/models';
import { claimEvidence, reportIntegrity, reportSections } from '@/composables/useReport';
import { changeSummary, mapReportChanges } from '@/utils/report-changes';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(changes: Report['changes'] = []): Report {
    return parseContract(ReportSchema, {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '研究报告标题：保留换行与 <script> 字面文本',
        summary: '摘要中的 <b>标签</b> 仍是字面文本，不生成新的章节事实。',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['受控查询'],
            gaps: ['一项资料未完成查阅'],
            exhausted: ['pages'],
        },
        limitations: ['仅展示已保存证据'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '来源事实',
                confidenceLabel: '逐字引用',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'inference',
                text: '相同文字',
                confidenceLabel: '推断',
                evidenceIds: [id(21)],
            },
            {
                id: id(12),
                kind: 'conflict',
                text: '相同文字',
                confidenceLabel: '冲突未解释',
                evidenceIds: [id(20), id(21)],
            },
            {
                id: id(13),
                kind: 'insufficient',
                text: '资料不足',
                confidenceLabel: '不能下结论',
                evidenceIds: [],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(30),
                snapshotId: id(40),
                title: '来源一',
                url: 'https://example.test/one',
                quote: '<script>字面原文</script>\n换行',
                location: '第1段',
                observedAt: '2026-10-31T00:00:00Z',
            },
            {
                id: id(21),
                sourceId: id(31),
                snapshotId: id(41),
                title: '来源二',
                url: 'https://example.test/two',
                quote: '第二条保存片段',
                location: '第2段',
                observedAt: '2026-10-31T00:00:00Z',
            },
            {
                id: id(22),
                sourceId: id(32),
                snapshotId: id(42),
                title: '孤立来源',
                url: 'https://example.test/orphan',
                quote: '没有被claim或change引用的证据',
                location: '第3段',
                observedAt: '2026-10-31T00:00:00Z',
            },
        ],
        changes,
        publishedAt: '2026-10-31T01:00:00Z',
    });
}
const change = {
    id: id(50),
    sourceId: id(30),
    kind: 'changed' as const,
    factKey: '事实维度',
    oldValue: '旧值',
    newValue: '新值',
    oldEvidenceIds: [id(20)],
    newEvidenceIds: [id(21)],
    important: true,
    reason: '保存的变化理由',
};

describe('ResearchReport source projection', () => {
    it('keeps four claim kinds, source order, duplicate text and all report evidence', () => {
        const report = fixture();
        expect(reportSections(report).map((section) => section.kind)).toEqual([
            'fact',
            'inference',
            'conflict',
            'insufficient',
        ]);
        expect(
            reportSections(report)
                .flatMap((section) => section.claims)
                .map((claim) => claim.id),
        ).toEqual([id(10), id(11), id(12), id(13)]);
        expect(report.claims[1]!.text).toBe(report.claims[2]!.text);
        expect(report.evidence).toHaveLength(3);
        expect(claimEvidence(report, report.claims[0]!)).toHaveLength(1);
        expect(claimEvidence(report, report.claims[3]!)).toEqual([]);
    });
    it('preserves partial/demo/outcome/coverage/limitations metadata without inferring completeness', () => {
        const report = fixture();
        expect(reportIntegrity(report)).toEqual({
            partial: true,
            demo: true,
            limitations: ['仅展示已保存证据', '一项资料未完成查阅'],
        });
        expect(report.outcome).toBe('inconclusive');
        expect(report.coverage.searchedQueries).toEqual(['受控查询']);
        expect(report.coverage.exhausted).toEqual(['pages']);
    });
    it('keeps changes independent and does not invent a no-change conclusion for an empty array', () => {
        const empty = fixture();
        expect(mapReportChanges(empty)).toEqual([]);
        expect(changeSummary(empty).state).toBe('inconclusive');
        const populated = fixture([change]);
        expect(
            mapReportChanges(populated)
                .flatMap((group) => group.entries)
                .map((entry) => entry.record.id),
        ).toEqual([id(50)]);
        expect(
            mapReportChanges(populated)[0]!.entries[0]!.oldEvidence.map((item) => item.id),
        ).toEqual([id(20)]);
    });
    it('retains hostile text as plain strings for Vue interpolation and does not add a model body', () => {
        const report = fixture();
        expect(report.title).toContain('<script>');
        expect(report.summary).toContain('<b>');
        expect(report.evidence[0]!.quote).toContain('<script>');
        expect('body' in report).toBe(false);
        expect('sections' in report).toBe(false);
    });
    it('keeps report DTO immutable during the read projection', () => {
        const report = fixture([change]);
        const before = structuredClone(report);
        void reportSections(report);
        void claimEvidence(report, report.claims[0]!);
        void mapReportChanges(report);
        expect(report).toEqual(before);
    });
});

describe('ResearchReport empty changes outcome rendering', () => {
    let server: ViteDevServer;
    let research: Component;
    let brief: Component;
    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: fileURLToPath(new URL('..', import.meta.url)),
            plugins: [vue()],
            optimizeDeps: { noDiscovery: true, include: [] },
            resolve: {
                alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
            },
            server: { middlewareMode: true, watch: null, hmr: false },
            appType: 'custom',
        });
        research = (await server.ssrLoadModule('/src/components/reports/ResearchReport.vue'))
            .default as Component;
        brief = (await server.ssrLoadModule('/src/components/reports/ReportBrief.vue'))
            .default as Component;
    });
    afterAll(async () => server?.close());
    async function render(component: Component, report: Report) {
        return renderToString(
            createSSRApp({ render: () => h(component, { report }) }).use(createPinia()),
        );
    }
    it.each([
        ['baseline', '本次建立比较基线', '建立基线本身不代表已经比较出重要变化。'],
        ['no_important_change', '本次范围内未发现重要变化', '不表示所有内容完全相同。'],
        ['inconclusive', '变化结论仍不确定', '不能据此认定没有重要变化。'],
    ] as const)(
        'retains %s with no changes or baseline ID in the actual SFC',
        async (outcome, title, caveat) => {
            const value = fixture();
            value.coverage = {
                completeness: 'complete',
                searchedQueries: ['已保存查询'],
                gaps: [],
                exhausted: [],
            };
            value.limitations = [];
            value.outcome = outcome;
            const report = parseContract(ReportSchema, value);
            const before = structuredClone(report);
            const output = await render(research, report);
            const briefOutput = await render(brief, report);
            expect(output).toContain('href="#report-changes-title"');
            expect(output).toContain('id="report-changes-title"');
            for (const text of [
                title,
                caveat,
                '本报告没有提供逐项变化记录。',
                '报告未提供关联的基线执行。',
            ]) {
                expect(output).toContain(text);
                expect(briefOutput).toContain(text);
            }
            expect(output).not.toContain('class="change-record"');
            expect(report).toEqual(before);
            expect(report.changes).toEqual([]);
            expect(report.baselineRunId).toBeNull();
        },
    );
});
