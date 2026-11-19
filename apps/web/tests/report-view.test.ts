import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';
import { ReportSchema, parseContract, type Report, type SessionResponse } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { reportEndpoint } from '@/api/reports';
import { reportError, useReport, validReportId } from '@/composable/useReport';
import { claimEvidence, reportIntegrity, reportSections } from '@/utils/report/summary';
import { sourceLink } from '@/utils/source/link';
import { createWorkbenchRouter } from '@/router';
import reportRoutes from '@/router/pages/reports';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(): Report {
    return {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '研究简报',
        summary: '已保存的研究概述',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: ['样本查询'],
            gaps: ['一项来源未能查阅'],
            exhausted: ['pages'],
        },
        limitations: ['仅覆盖已保存来源'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '已引用事实',
                confidenceLabel: '来自逐字原文',
                evidenceIds: [id(20)],
            },
            {
                id: id(11),
                kind: 'inference',
                text: '待核实推断',
                confidenceLabel: '推断有限',
                evidenceIds: [id(20)],
            },
            {
                id: id(12),
                kind: 'conflict',
                text: '来源冲突',
                confidenceLabel: '尚未解释差异',
                evidenceIds: [id(20)],
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
                sourceId: id(21),
                snapshotId: id(22),
                title: '来源样本',
                url: 'https://example.test/source',
                quote: '<script>alert(1)</script> 保存的原文',
                location: '第 2 段',
                observedAt: '2026-10-31T01:00:00Z',
                snapshot: {
                    originalUrl: 'https://example.test/original',
                    fetchedUrl: 'https://example.test/source',
                    canonicalUrl: 'https://example.test/source',
                    contentHash: 'a'.repeat(64),
                    extractorVersion: 'reader-v1',
                    publishedAt: null,
                    truncated: true,
                    selector: {
                        type: 'text_offset',
                        start: 10,
                        end: 28,
                        extractorVersion: 'reader-v1',
                    },
                },
            },
        ],
        changes: [],
        publishedAt: '2026-10-31T02:00:00Z',
    };
}
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test-only',
};
const disposals: (() => void)[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    disposals.push(lifecycle.dispose);
    return lifecycle;
}
function failure(status: number, code = 'TEST_FAILURE') {
    return Response.json({ code, message: 'sample', requestId: 'sample' }, { status });
}
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('report detail', () => {
    it('validates exact UUID input before requesting the same-origin report endpoint', async () => {
        expect(validReportId(id(1))).toBe(true);
        for (const input of ['', `../${id(1)}`, `${id(1)}suffix`, [id(1)], 'https://example.test'])
            expect(validReportId(input)).toBe(false);
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture()));
        const lifecycle = setup(fetcher);
        await expect(
            lifecycle.capture().request(reportEndpoint, { params: { reportId: '../not-id' } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        await lifecycle.queryClient.fetchQuery(
            lifecycle.queryOptions(reportEndpoint, { params: { reportId: id(1) } }, [
                'reports',
                id(1),
            ]),
        );
        expect(fetcher.mock.calls[0]?.[0]).toContain(`/api/v1/reports/${id(1)}`);
    });
    it('registers the report route without adding a navigation item', () => {
        const router = createWorkbenchRouter(createMemoryHistory(), reportRoutes);
        expect(router.resolve(`/reports/${id(1)}`).name).toBe('report-detail');
        expect('navigation' in reportRoutes[0]!.meta).toBe(false);
    });
    it('resolves saved evidence in claim order and preserves distinct fact types', () => {
        const report = parseContract(ReportSchema, fixture());
        expect(reportSections(report).map((section) => section.kind)).toEqual([
            'fact',
            'inference',
            'conflict',
            'insufficient',
        ]);
        expect(claimEvidence(report, report.claims[0]!)[0]?.location).toBe('第 2 段');
        expect(claimEvidence(report, report.claims[3]!)).toEqual([]);
        expect(() =>
            parseContract(ReportSchema, {
                ...report,
                claims: [{ ...report.claims[0], evidenceIds: [id(90)] }],
            }),
        ).toThrow();
        expect(() =>
            parseContract(ReportSchema, {
                ...report,
                claims: [{ ...report.claims[0], evidenceIds: [] }],
            }),
        ).toThrow();
    });
    it('preserves partial restrictions, demo provenance and evidence without full source bodies', () => {
        const report = parseContract(ReportSchema, fixture());
        expect(reportIntegrity(report)).toEqual({
            partial: true,
            demo: true,
            limitations: ['仅覆盖已保存来源', '一项来源未能查阅'],
        });
        expect(() =>
            parseContract(ReportSchema, { ...report, outcome: 'no_important_change' }),
        ).toThrow();
        expect(() =>
            parseContract(ReportSchema, {
                ...report,
                limitations: [],
                coverage: { ...report.coverage, gaps: [] },
            }),
        ).toThrow();
        delete report.evidence[0]!.snapshot;
        const saved = parseContract(ReportSchema, report);
        expect(claimEvidence(saved, saved.claims[0]!)[0]?.quote).toContain('保存的原文');
        expect(claimEvidence(saved, saved.claims[0]!)[0]?.location).toBe('第 2 段');
    });
    it('only permits http/https links without credentials', () => {
        expect(sourceLink('https://example.test/source')).toBe('https://example.test/source');
        expect(sourceLink('http://example.test/source')).toBe('http://example.test/source');
        for (const url of [
            'javascript:alert(1)',
            'data:text/html,test',
            '//evil.test',
            'https://user:pass@example.test',
            '/local',
        ])
            expect(sourceLink(url)).toBeUndefined();
    });
    it.each([403, 404, 409])(
        'shows HTTP %i without retaining inaccessible report data',
        async (status) => {
            const lifecycle = setup(async () =>
                failure(status, status === 409 ? 'INVALID_REPORT_EVIDENCE' : 'TEST_FAILURE'),
            );
            const options = lifecycle.queryOptions(
                reportEndpoint,
                { params: { reportId: id(1) } },
                ['reports', id(1)],
            );
            try {
                await lifecycle.queryClient.fetchQuery(options);
            } catch (error) {
                const display = reportError(error);
                expect(display.retryable).toBe(status === 409);
                expect(display.message).toContain(
                    status === 409 ? '证据校验未通过' : status === 404 ? '不存在' : '无权',
                );
            }
            expect(lifecycle.queryClient.getQueryData(options.queryKey)).toBeUndefined();
        },
    );
    it('tracks report ids, disables invalid input and isolates account epochs', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture()));
        const lifecycle = setup(fetcher);
        const idRef = ref<unknown>('invalid');
        const scope = effectScope();
        const detail = scope.run(() => useReport(idRef, lifecycle))!;
        disposals.push(() => scope.stop());
        expect(detail.valid.value).toBe(false);
        expect(detail.report.value).toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();
        idRef.value = id(1);
        await vi.waitFor(() => expect(detail.report.value?.id).toBe(id(1)));
        const oldKeys = lifecycle.queryClient
            .getQueryCache()
            .getAll()
            .map((entry) => entry.queryKey);
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        for (const key of oldKeys) expect(lifecycle.queryClient.getQueryData(key)).toBeUndefined();
    });
    it('rejects a mismatched report and hides old content when a reports invalidation fails', async () => {
        let status = 200;
        const lifecycle = setup(async () =>
            status === 200 ? Response.json(fixture()) : failure(409, 'INVALID_REPORT_EVIDENCE'),
        );
        const scope = effectScope();
        const detail = scope.run(() => useReport(id(1), lifecycle))!;
        const mismatch = scope.run(() => useReport(id(2), lifecycle))!;
        disposals.push(() => scope.stop());
        await vi.waitFor(() => expect(detail.report.value?.id).toBe(id(1)));
        await vi.waitFor(() => expect(mismatch.query.isError.value).toBe(true));
        expect(mismatch.report.value).toBeUndefined();
        expect(mismatch.error.value.message).toContain('结构或引用不完整');
        status = 409;
        await lifecycle.queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[3] === 'reports',
        });
        await vi.waitFor(() => expect(detail.query.isError.value).toBe(true));
        expect(detail.report.value).toBeUndefined();
        expect(detail.error.value.message).toContain('证据校验未通过');
    });
    it.each([200, 401, 403])('cancels and ignores late old-account HTTP %i', async (status) => {
        let release!: (response: Response) => void;
        let signal: AbortSignal | undefined;
        const lifecycle = setup(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        });
        const scope = lifecycle.capture();
        const request = scope.request(reportEndpoint, { params: { reportId: id(1) } });
        await vi.waitFor(() => expect(release).toBeDefined());
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
        release(status === 200 ? Response.json(fixture()) : failure(status));
        await expect(request).rejects.toThrow();
        expect(signal?.aborted).toBe(true);
        expect(lifecycle.session.user?.id).toBe(id(101));
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
    it('rejects an invalid report response and supports query unmount cancellation', async () => {
        const lifecycle = setup(async () => Response.json({ ...fixture(), claims: [] }));
        await expect(
            lifecycle.capture().request(reportEndpoint, { params: { reportId: id(1) } }),
        ).rejects.toThrow();
        let signal: AbortSignal | undefined;
        const pending = setup(async (_url, init) => {
            signal = init?.signal ?? undefined;
            return new Promise<Response>(() => {});
        });
        const scope = effectScope();
        scope.run(() => useReport(id(1), pending));
        await vi.waitFor(() => expect(signal).toBeDefined());
        scope.stop();
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    });
});
