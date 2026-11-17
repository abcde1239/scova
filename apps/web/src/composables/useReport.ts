import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
    ContractValidationError,
    HttpUrlSchema,
    UuidSchema,
    parseContract,
    type Claim,
    type Report,
} from '@scova/models';
import { reportEndpoint } from '@/api/reports';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import type { SessionLifecycle } from '@/api/session';
import { uniqueCoverageNotes } from '@/utils/report-coverage';

export function validReportId(value: unknown): value is string {
    try {
        parseContract(UuidSchema, value);
        return true;
    } catch {
        return false;
    }
}

export function sourceLink(value: string): string | undefined {
    try {
        return parseContract(HttpUrlSchema, value);
    } catch {
        return undefined;
    }
}

export const claimLabels: Record<Claim['kind'], string> = {
    fact: '来源事实',
    inference: 'Agent 推断',
    conflict: '冲突证据',
    insufficient: '证据不足',
    model_answer: '模型自回答',
};

export function reportSections(report: Report) {
    if (report.coverage.reportValue) return [];
    return (Object.entries(claimLabels) as [Claim['kind'], string][])
        .map(([kind, title]) => ({
            kind,
            title,
            claims: report.claims.filter((claim) => claim.kind === kind),
        }))
        .filter((section) => section.claims.length);
}

export function claimEvidence(report: Report, claim: Claim) {
    return claim.evidenceIds
        .map((id) => report.evidence.find((entry) => entry.id === id))
        .filter((entry) => entry !== undefined);
}

export function reportIntegrity(report: Report) {
    return {
        partial: report.coverage.completeness === 'partial',
        limitations: uniqueCoverageNotes([...report.limitations, ...report.coverage.gaps]),
        demo: report.mode === 'demo',
    };
}

export function reportError(cause: unknown) {
    const error = toApiError(cause);
    if (error.status === 403) return { message: '当前账号无权查看这份报告。', retryable: false };
    if (error.status === 404)
        return { message: '报告不存在或当前账号无法访问。', retryable: false };
    if (error.status === 409 && error.code === 'INVALID_REPORT_EVIDENCE')
        return { message: '报告证据校验未通过，暂时无法展示内容。', retryable: true };
    if (error.kind === 'validation')
        return { message: '报告结构或引用不完整，暂时无法展示内容。', retryable: true };
    return { message: '报告暂时无法读取，请检查连接后重试。', retryable: true };
}

export function useReport(
    reportId: MaybeRefOrGetter<unknown>,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const valid = computed(() => validReportId(toValue(reportId)));
    const query = useQuery(
        computed(() => {
            const id = toValue(reportId);
            const options = lifecycle.queryOptions(
                reportEndpoint,
                { params: { reportId: validReportId(id) ? id : '' } },
                ['reports', id],
            );
            return {
                ...options,
                enabled: options.enabled && valid.value,
                async queryFn(context: { signal: AbortSignal }) {
                    const response = await options.queryFn(context);
                    if (response.data.id !== id)
                        throw new ContractValidationError([
                            { path: '/id', message: '报告响应与请求标识不一致' },
                        ]);
                    return response;
                },
            };
        }),
        lifecycle.queryClient,
    );
    // Never leave stale report content visible while a replacement query fails or changes owner.
    const report = computed(() =>
        valid.value && query.isSuccess.value ? query.data.value?.data : undefined,
    );
    const error = computed(() =>
        valid.value
            ? reportError(query.error.value)
            : { message: '报告地址无效。', retryable: false },
    );
    return { query, report, valid, error };
}
