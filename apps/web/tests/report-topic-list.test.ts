import { describe, expect, it } from 'vite-plus/test';
import { ReportSchema, parseContract, type Report } from '@scova/models';
import { claimEvidence, reportIntegrity, reportSections } from '@/composables/useReport';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(): Report {
    const evidence = (n: number) => ({
        id: id(n),
        sourceId: id(n + 100),
        snapshotId: id(n + 200),
        title: `来源 ${n}`,
        url: `https://example.test/source/${n}`,
        quote: `逐字引用 ${n} <script>保留原文</script>`,
        location: '第 2 段',
        observedAt: '2026-10-31T01:00:00Z',
    });
    return parseContract(ReportSchema, {
        id: id(1),
        runId: id(2),
        taskId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '申请资料清单',
        summary: '保留全部原始结论与引用',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['原始查询'],
            gaps: ['尚有查阅缺口'],
            exhausted: ['pages'],
        },
        limitations: ['原始限制', '尚有查阅缺口'],
        claims: [
            {
                id: id(10),
                kind: 'inference',
                text: '同文结论',
                confidenceLabel: '推断',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'fact',
                text: '来源事实',
                confidenceLabel: '来源原文',
                evidenceIds: [id(21), id(20)],
            },
            {
                id: id(12),
                kind: 'insufficient',
                text: '证据尚不足',
                confidenceLabel: '不能下结论',
                evidenceIds: [],
            },
            {
                id: id(13),
                kind: 'conflict',
                text: '来源存在冲突',
                confidenceLabel: '冲突待解',
                evidenceIds: [id(21)],
            },
            {
                id: id(14),
                kind: 'inference',
                text: '同文结论',
                confidenceLabel: '同文不同ID',
                evidenceIds: [id(21)],
            },
        ],
        evidence: [evidence(20), evidence(21), evidence(22)],
        changes: [
            {
                id: id(30),
                sourceId: id(122),
                kind: 'new',
                factKey: '只在变化中的线索',
                oldValue: null,
                newValue: '线索',
                oldEvidenceIds: [],
                newEvidenceIds: [id(22)],
                important: false,
                reason: '不改比较结论',
            },
        ],
        publishedAt: '2026-10-31T02:00:00Z',
    });
}

describe('shared report projection for topic list and brief', () => {
    it('keeps all four real kinds, original within-kind order and all claim ids', () => {
        const report = fixture();
        const groups = reportSections(report);
        expect(groups.map((group) => group.title)).toEqual([
            '来源事实',
            'Agent 推断',
            '冲突证据',
            '证据不足',
        ]);
        expect(groups.map((group) => group.claims.map((claim) => claim.id))).toEqual([
            [id(11)],
            [id(10), id(14)],
            [id(13)],
            [id(12)],
        ]);
        expect(new Set(groups.flatMap((group) => group.claims.map((claim) => claim.id)))).toEqual(
            new Set(report.claims.map((claim) => claim.id)),
        );
        for (const group of groups)
            for (const claim of group.claims) expect(report.claims).toContain(claim);
    });
    it('retains ordered mapping, shared citations, equal text with distinct ids, and no-citation items', () => {
        const report = fixture();
        const claims = reportSections(report).flatMap((group) => group.claims);
        const mapping = Object.fromEntries(
            claims.map((claim) => [claim.id, claimEvidence(report, claim).map((item) => item.id)]),
        );
        expect(mapping).toEqual({
            [id(11)]: [id(21), id(20)],
            [id(10)]: [id(20)],
            [id(14)]: [id(21)],
            [id(13)]: [id(21)],
            [id(12)]: [],
        });
        expect(
            claims.filter((claim) => claim.text === '同文结论').map((claim) => claim.id),
        ).toEqual([id(10), id(14)]);
        expect(claimEvidence(report, report.claims[1]!)[0]).toBe(report.evidence[1]);
    });
    it('preserves changes-only evidence in the DTO without pretending it was a direct claim citation', () => {
        const report = fixture(),
            before = structuredClone(report);
        const direct = new Set(
            reportSections(report).flatMap((group) =>
                group.claims.flatMap((claim) =>
                    claimEvidence(report, claim).map((item) => item.id),
                ),
            ),
        );
        expect(direct).toEqual(new Set([id(20), id(21)]));
        expect(report.evidence.map((item) => item.id)).toEqual([id(20), id(21), id(22)]);
        expect(report.changes[0]?.newEvidenceIds).toEqual([id(22)]);
        expect(report).toEqual(before);
    });
    it('keeps partial coverage, demo mode, version and raw limits without rewriting the report', () => {
        const report = fixture(),
            before = structuredClone(report);
        expect(reportIntegrity(report)).toEqual({
            partial: true,
            demo: true,
            limitations: ['原始限制', '尚有查阅缺口'],
        });
        expect(report.taskVersionId).toBe(id(4));
        expect(report.coverage.searchedQueries).toEqual(['原始查询']);
        expect(report.coverage.exhausted).toEqual(['pages']);
        expect(
            reportSections(report)
                .flatMap((group) => group.claims)
                .find((claim) => claim.kind === 'insufficient')?.confidenceLabel,
        ).toBe('不能下结论');
        expect(report).toEqual(before);
    });
    it('has no invented empty groups and does not require saved topic_list format to project claims', () => {
        const report = fixture();
        report.claims = report.claims.filter((claim) => claim.kind === 'fact');
        expect(
            reportSections(parseContract(ReportSchema, report)).map((group) => group.kind),
        ).toEqual(['fact']);
        expect(report.format).toBe('brief');
        expect('topics' in report).toBe(false);
    });
    it('retains complete/live provenance and safe string quotes', () => {
        const report = fixture();
        report.mode = 'live';
        report.coverage = {
            completeness: 'complete',
            searchedQueries: [],
            gaps: [],
            exhausted: [],
        };
        report.limitations = [];
        const authorized = parseContract(ReportSchema, report);
        expect(reportIntegrity(authorized)).toEqual({
            partial: false,
            demo: false,
            limitations: [],
        });
        expect(claimEvidence(authorized, authorized.claims[1]!)[1]?.quote).toBe(
            '逐字引用 20 <script>保留原文</script>',
        );
    });
    it('rejects missing references and illegal partial claims at the shared DTO boundary', () => {
        const report = fixture();
        expect(() =>
            parseContract(ReportSchema, {
                ...report,
                claims: [{ ...report.claims[1], evidenceIds: [id(99)] }],
            }),
        ).toThrow();
        expect(() =>
            parseContract(ReportSchema, { ...report, outcome: 'no_important_change' }),
        ).toThrow();
        expect(() =>
            parseContract(ReportSchema, { ...report, evidence: report.evidence.slice(0, 2) }),
        ).toThrow();
    });
});
