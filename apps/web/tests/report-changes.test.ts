import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope } from 'vue';
import {
    ReportSchema,
    parseContract,
    type Evidence,
    type Report,
    type SessionResponse,
} from '@scova/models';
import { changeKinds, changeSummary, mapReportChanges } from '@/utils/report-changes';
import { createSessionLifecycle } from '@/api/session';
import { useReport } from '@/composables/useReport';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function evidence(n: number, quote: string): Evidence {
    return {
        id: id(n),
        sourceId: id(20),
        snapshotId: id(n + 100),
        title: n === 10 ? '上期招生说明' : '本期招生说明',
        url: 'https://example.test/admissions',
        quote,
        location: '已保存正文第2段',
        observedAt: '2026-10-31T01:00:00Z',
    };
}
function fixture(): Report {
    return {
        id: id(1),
        runId: id(2),
        taskId: id(3),
        taskVersionId: id(4),
        baselineRunId: id(5),
        schemaVersion: 1,
        title: '招生截止日期与费用变化',
        summary: '截止日期与费用已有新公告，保留双方逐字引用。',
        format: 'brief',
        mode: 'demo',
        outcome: 'important_change',
        coverage: {
            completeness: 'complete',
            searchedQueries: ['招生公告'],
            gaps: [],
            exhausted: [],
        },
        limitations: [],
        claims: [
            {
                id: id(6),
                kind: 'fact',
                text: '本次公告的申请截止日期为12月1日。',
                confidenceLabel: '来自原文',
                evidenceIds: [id(11)],
            },
        ],
        evidence: [
            evidence(10, '截止日期为11月1日，申请费为100元。'),
            evidence(11, '截止日期为12月1日，申请费为150元。'),
        ],
        changes: [
            {
                id: id(30),
                sourceId: id(20),
                kind: 'changed',
                factKey: '招生申请截止日期',
                oldValue: '11月1日',
                newValue: '12月1日',
                oldEvidenceIds: [id(10)],
                newEvidenceIds: [id(11)],
                important: true,
                reason: '同一来源的申请截止日期发生变化。',
            },
            {
                id: id(31),
                sourceId: id(20),
                kind: 'changed',
                factKey: '申请费用',
                oldValue: '100元',
                newValue: '150元',
                oldEvidenceIds: [id(10)],
                newEvidenceIds: [id(11)],
                important: true,
                reason: '申请费用发生变化，请查阅双方原文。',
            },
        ],
        publishedAt: '2026-10-31T02:00:00Z',
    };
}
type Change = Report['changes'][number];
function change(kind: Change['kind']): Change {
    const original = fixture().changes[0]!;
    return {
        ...original,
        kind,
        id: id(40 + changeKinds.findIndex((entry) => entry.kind === kind)),
        oldValue: kind === 'new' || kind === 'baseline' ? null : original.oldValue,
        oldEvidenceIds: kind === 'new' || kind === 'baseline' ? [] : original.oldEvidenceIds,
        important: kind === 'changed',
    };
}
const account: SessionResponse = {
    user: {
        id: id(900),
        email: 'changes@example.test',
        createdAt: '2026-10-31T00:00:00Z',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'changes-csrf',
};
const disposals: (() => void)[] = [];
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('report changes presentation', () => {
    it('fails closed for an unresolved new-side citation rather than borrowing old evidence', () => {
        const report = fixture();
        report.evidence = report.evidence.filter((entry) => entry.id !== id(11));
        report.claims = [{ ...report.claims[0]!, kind: 'insufficient', evidenceIds: [] }];
        expect(() => parseContract(ReportSchema, report)).toThrow();
        expect(() => mapReportChanges(report)).toThrow();
    });
    it('keeps each side citation ID order and original reason text without mutating evidence', () => {
        const report = fixture();
        report.evidence.push(evidence(12, '另一段授权旧侧引用'));
        report.changes[0]!.oldEvidenceIds = [id(12), id(10)];
        report.changes[0]!.reason = '保留原始原因\n第二行与 <b>普通文字</b>';
        const before = JSON.stringify(report);
        const entry = mapReportChanges(parseContract(ReportSchema, report))[0]!.entries[0]!;
        expect(entry.oldEvidence.map((value) => value.id)).toEqual([id(12), id(10)]);
        expect(entry.newEvidence.map((value) => value.id)).toEqual([id(11)]);
        expect(entry.record.reason).toBe(report.changes[0]!.reason);
        expect(JSON.stringify(report)).toBe(before);
        // This verifies public DTO projection order, not hidden database-side run ownership.
    });
    it('projects admissions deadline and fee values with their exact authorized evidence sides', () => {
        const report = parseContract(ReportSchema, fixture());
        const entries = mapReportChanges(report).find((group) => group.kind === 'changed')!.entries;
        expect(entries.map((entry) => [entry.record.oldValue, entry.record.newValue])).toEqual([
            ['11月1日', '12月1日'],
            ['100元', '150元'],
        ]);
        expect(entries[0]?.oldEvidence[0]?.id).toBe(id(10));
        expect(entries[0]?.newEvidence[0]?.id).toBe(id(11));
        expect(entries[0]?.oldEvidence[0]?.quote).toContain('11月1日');
        expect(entries[0]?.newEvidence[0]?.quote).toContain('12月1日');
        expect(changeSummary(report).state).toBe('important_change');
    });
    it('preserves all seven backend kinds, nonzero counts, reason and importance without rewriting', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            changes: changeKinds.map((entry) => change(entry.kind)),
        });
        const before = JSON.stringify(report);
        const groups = mapReportChanges(report);
        expect(groups.map((group) => group.kind)).toEqual(changeKinds.map((entry) => entry.kind));
        expect(groups.every((group) => group.entries.length === 1)).toBe(true);
        for (const group of groups) {
            expect(group.entries[0]?.record).toBe(
                report.changes.find((entry) => entry.kind === group.kind),
            );
            expect(group.entries[0]?.record.reason).toBe('同一来源的申请截止日期发生变化。');
        }
        expect(JSON.stringify(report)).toBe(before);
    });
    it('only presents no-important-change for the explicit complete zero-important server result', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            outcome: 'no_important_change',
            changes: [change('duplicate'), change('non_material')],
        });
        expect(changeSummary(report)).toMatchObject({
            state: 'no_important_change',
            title: '本次范围内未发现重要变化',
        });
        expect(changeSummary({ ...report, outcome: 'new_findings' }).state).toBe('new_findings');
        expect(changeSummary({ ...report, changes: [] }).state).toBe('no_important_change');
    });
    it('does not promote a complete report to no-important-change just because no row is important', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            outcome: 'inconclusive',
            changes: [change('duplicate')],
        });
        expect(changeSummary(report).state).toBe('inconclusive');
        expect(changeSummary(report).title).toBe('变化结论仍不确定');
    });
    it('keeps partial comparison uncertain and does not claim null-baseline partial established a baseline', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            baselineRunId: null,
            outcome: 'inconclusive',
            changes: [change('baseline')],
            coverage: {
                completeness: 'partial',
                searchedQueries: [],
                gaps: ['旧范围未完成比较'],
                exhausted: [],
            },
        });
        expect(changeSummary(report).state).toBe('inconclusive');
        expect(changeSummary(report).title).not.toContain('建立');
        expect(mapReportChanges(report)[0]?.kind).toBe('baseline');
    });
    it('uses the server baseline outcome rather than guessing a reset reason from a missing baseline ID', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            baselineRunId: null,
            outcome: 'baseline',
            changes: [change('baseline')],
        });
        expect(changeSummary(report).state).toBe('baseline');
        expect(changeSummary(report).message).not.toMatch(/首次|模式改变|范围改变/);
        expect(changeSummary({ ...report, outcome: 'inconclusive' }).state).toBe('inconclusive');
    });
    it('keeps uncertain rows and missing old evidence inconclusive without changing their classification', () => {
        for (const record of [
            change('uncertain'),
            { ...change('non_material'), oldEvidenceIds: [] },
        ]) {
            const report = parseContract(ReportSchema, {
                ...fixture(),
                outcome: 'no_important_change',
                changes: [record],
            });
            expect(changeSummary(report).state).toBe('inconclusive');
            expect(mapReportChanges(report)[0]?.entries[0]?.record.kind).toBe(record.kind);
        }
    });
    it('does not reinterpret an important server flag to make a no-important-change banner fit', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            outcome: 'no_important_change',
        });
        expect(changeSummary(report).state).toBe('inconclusive');
        expect(mapReportChanges(report)[0]?.entries[0]?.record.important).toBe(true);
    });
    it('retains null observations as absent values, without generating deletion or withdrawal claims', () => {
        const record = { ...change('uncertain'), newValue: null, newEvidenceIds: [] };
        const report = parseContract(ReportSchema, {
            ...fixture(),
            outcome: 'inconclusive',
            changes: [record],
        });
        expect(mapReportChanges(report)[0]?.entries[0]?.record.newValue).toBeNull();
        expect(changeSummary(report).message).not.toMatch(/已经删除|已经撤回/);
    });
    it('does not infer importance from different snapshot hashes or non-material changes', () => {
        const report = parseContract(ReportSchema, {
            ...fixture(),
            outcome: 'no_important_change',
            changes: [change('non_material')],
        });
        expect(changeSummary(report).state).toBe('no_important_change');
        expect(mapReportChanges(report)[0]?.entries[0]?.record.important).toBe(false);
    });
    it('never silently filters unresolved evidence and calls the remaining comparison complete', () => {
        const broken = { ...fixture(), evidence: [fixture().evidence[1]!] };
        expect(() => parseContract(ReportSchema, broken)).toThrow();
        expect(() => mapReportChanges(broken)).toThrow();
    });
    it('rejects unknown contract kinds before rendering instead of guessing a category', () => {
        expect(() =>
            parseContract(ReportSchema, {
                ...fixture(),
                changes: [{ ...change('uncertain'), kind: 'withdrawn' }],
            }),
        ).toThrow();
    });
    it('keeps source quotes as strings, preserves their side order and does not inject internal manifests', () => {
        const report = fixture();
        report.evidence[0]!.quote = '<script>alert(1)</script> 旧原文';
        const mapped = mapReportChanges(parseContract(ReportSchema, report));
        expect(mapped[0]?.entries[0]?.oldEvidence[0]?.quote).toBe(report.evidence[0]!.quote);
        expect(mapped[0]?.entries[0]?.newEvidence[0]?.quote).toBe(report.evidence[1]!.quote);
        expect(mapped[0]?.entries[0]).not.toHaveProperty('manifest');
    });
    it('hides the entire cached report when the API rejects old/new evidence authorization with 409', async () => {
        let rejected = false;
        const fetcher = vi.fn<typeof fetch>(async () =>
            rejected
                ? Response.json(
                      {
                          code: 'INVALID_REPORT_EVIDENCE',
                          message: '引用暂不可用',
                          requestId: 'side-rejection',
                      },
                      { status: 409 },
                  )
                : Response.json(fixture()),
        );
        const lifecycle = createSessionLifecycle({ fetcher });
        lifecycle.replaceSession(account);
        const scope = effectScope();
        const detail = scope.run(() => useReport(id(1), lifecycle))!;
        disposals.push(() => {
            scope.stop();
            lifecycle.dispose();
        });
        await vi.waitFor(() => expect(detail.report.value?.id).toBe(id(1)));
        rejected = true;
        await detail.query.refetch();
        expect(detail.report.value).toBeUndefined();
        expect(detail.error.value).toMatchObject({
            retryable: true,
            message: '报告证据校验未通过，暂时无法展示内容。',
        });
        // The API, not the public evidence DTO, verifies hidden run/owner/mode/scope associations.
        rejected = false;
        await detail.query.refetch();
        expect(detail.report.value?.changes[0]?.oldEvidenceIds).toEqual([id(10)]);
    });
    it('preserves mode and baseline identity without grouping reports from different modes together', () => {
        const report = fixture();
        const snapshot = {
            mode: report.mode,
            baseline: report.baselineRunId,
            version: report.taskVersionId,
        };
        mapReportChanges(report);
        changeSummary(report);
        expect({
            mode: report.mode,
            baseline: report.baselineRunId,
            version: report.taskVersionId,
        }).toEqual(snapshot);
    });
});
