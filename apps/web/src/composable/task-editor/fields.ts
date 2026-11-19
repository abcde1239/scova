import {
    ContractValidationError,
    TaskDetailResponseSchema,
    parseRevisionEtag,
    parseContract,
    type TaskDetailResponse,
    type FieldError,
} from '@scova/models';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import type { ApiResponse } from '@/api/client';
import type { SessionLifecycle } from '@/api/session';
import { type TaskDraft, type TaskDraftField, budgetFields } from './draft.ts';

const fieldPaths: Partial<Record<string, TaskDraftField>> = {
    title: 'title',
    topic: 'topic',
    goal: 'goal',
    focusPoints: 'focusPoints',
    exclusions: 'exclusions',
    'sourcePreferences/preferredUrls': 'preferredUrls',
    'sourcePreferences/excludedUrls': 'excludedUrls',
    'sourcePreferences/officialOnly': 'officialOnly',
    'timeRange/days': 'days',
    'timeRange/start': 'start',
    'timeRange/end': 'end',
    timezone: 'timezone',
    'schedule/frequency': 'scheduleFrequency',
    'schedule/localTime': 'scheduleLocalTime',
    'schedule/weekday': 'scheduleWeekday',
    outputFormat: 'outputFormat',
    outputFormats: 'outputFormats',
    researchMode: 'researchMode',
    collectionDateUnknown: 'collectionDateUnknown',
    timeRange: 'rangeKind',
    'timeRange/kind': 'rangeKind',
    agentProviderId: 'agentProviderId',
    searchMode: 'searchMode',
    'notificationPreference/mode': 'notificationMode',
    'notificationPreference/runIssues': 'runIssues',
    ...Object.fromEntries(budgetFields.map(({ key }) => [`budget/${key}`, key])),
};

export function taskField(path: string): TaskDraftField | undefined {
    const key = path.replace(/^\/(?:body\/)?config\//, '').replace(/\/\d+$/, '');
    return fieldPaths[key];
}

export function taskValidationFields(range: TaskDraft['rangeKind'], details: FieldError[] = []) {
    const fields: Partial<Record<TaskDraftField, string>> = {};
    for (const detail of details) {
        const field = taskField(detail.path);
        if (!field || (range === 'fixed' ? field === 'days' : field === 'start' || field === 'end'))
            continue;
        fields[field] ??= detail.message;
    }
    return fields;
}

export function saveNotConfirmed(status?: number) {
    return !(status && status >= 400 && status < 500 && status !== 408);
}

/** Keep the response ETag verbatim; validate consistency without deriving a replacement. */
export function validateTaskEditResponse(
    response: ApiResponse<TaskDetailResponse>,
    taskId: string,
) {
    const value = parseContract(TaskDetailResponseSchema, response.data);
    const etag = response.headers.etag;
    if (
        !etag ||
        parseRevisionEtag(etag) !== value.task.revision ||
        value.task.id !== taskId ||
        value.version.taskId !== taskId ||
        value.task.currentVersionId !== value.version.id
    )
        throw new ContractValidationError([
            { path: '/', message: '任务配置、版本或 ETag 不一致，请重新读取' },
        ]);
    return response;
}

export function taskEditOptions(lifecycle: SessionLifecycle, taskId: string) {
    const options = lifecycle.queryOptions(taskEndpoint, { params: { taskId } }, [
        ...taskKeys.detail(taskId),
        'edit',
    ]);
    return {
        ...options,
        staleTime: 0,
        async queryFn(context: { signal: AbortSignal }) {
            return validateTaskEditResponse(await options.queryFn(context), taskId);
        },
    };
}
