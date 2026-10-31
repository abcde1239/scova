import {
    TaskDraftInputSchema,
    TaskDraftResponseSchema,
    ContractValidationError,
    parseContract,
    type TaskDraftInput,
    type TaskDraftResponse,
} from '@scova/models';
import { InvalidResponseError } from 'requestlane';
import { defineApiEndpoint } from '@/api/endpoints';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { modelValidator } from '@/api/validator';

export function validateDraftInput(value: unknown) {
    const input = parseContract(TaskDraftInputSchema, value);
    if (new TextEncoder().encode(input.inputText).byteLength > 8000)
        throw new ContractValidationError([
            { path: '/inputText', message: '原始描述不得超过8000 UTF-8字节' },
        ]);
    return input;
}
const endpoint = defineApiEndpoint<{ body: TaskDraftInput; data: TaskDraftResponse }>({
    method: 'POST',
    path: '/task-drafts',
    timeout: 30_000,
    inputValidators: { body: { parse: validateDraftInput } },
    validator: modelValidator(TaskDraftResponseSchema),
});
export async function requestTaskDraft(
    scope: ReturnType<SessionLifecycle['capture']>,
    input: TaskDraftInput,
    signal: AbortSignal,
    timeout?: number,
) {
    const result = await scope.request(endpoint, { body: input }, { signal, timeout });
    if (
        result.data.inputText !== input.inputText ||
        (result.data.mode === 'model'
            ? result.data.manualReason !== null
            : result.data.manualReason === null)
    )
        throw toApiError(new InvalidResponseError('解析原文或结果模式不一致'));
    return result;
}
