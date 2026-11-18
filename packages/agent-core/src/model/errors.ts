import { ConnectorError } from '@scova/connectors';
import type { ResearchState } from '../research/state.ts';

/** Provider quota prevents new calls; it never invalidates successful receipts. */
export function blockQuotaFailure(state: ResearchState, error: unknown): boolean {
    if (!(error instanceof ConnectorError) || error.code !== 'model_quota_exceeded') return false;
    if (!state.modelBlocked)
        state.gaps.push('模型服务额度不足，本次执行停止后续模型调用；补充额度后请新建执行');
    state.modelBlocked = true;
    return true;
}

/** A local reservation limit stops this stage without blocking other model stages. */
export function modelStageLimited(state: ResearchState, error: unknown): boolean {
    return (
        blockQuotaFailure(state, error) ||
        (error instanceof ConnectorError &&
            ['quota_exceeded', 'budget_exceeded'].includes(error.code))
    );
}

export function repairableModelOutput(error: unknown): error is ConnectorError {
    return (
        error instanceof ConnectorError &&
        (error.code === 'output_truncated' ||
            (error.code === 'invalid_response' &&
                (error.modelFailure === 'json' || error.modelFailure === 'schema')))
    );
}

export function modelRepairHint(error: ConnectorError): string {
    if (error.code === 'output_truncated')
        return 'The previous response exhausted its output limit. Reduce secondary items and return compact, complete JSON.';
    return `Regenerate complete JSON matching the supplied schema. Prior response failed ${error.modelFailure ?? 'structure'} validation.${error.modelSchemaIssues?.length ? ` Contract locations: ${JSON.stringify(error.modelSchemaIssues)}` : ''} Do not repeat invalid structure or add unsupported claims.`.slice(
        0,
        1000,
    );
}

/** Provider content passed transport validation but failed the requested domain structure. */
export function invalidModelOutput(message: string): ConnectorError {
    const error = new ConnectorError('invalid_response', message);
    error.modelFailure = 'schema';
    return error;
}
