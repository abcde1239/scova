import { ContractValidationError, type UpdatePreferencesInput } from '@scova/models';
import { updatePreferencesEndpoint } from '@/api/endpoints';
import type { SessionLifecycle } from '@/api/session';

export async function savePreferences(
    scope: ReturnType<SessionLifecycle['capture']>,
    body: UpdatePreferencesInput,
    signal: AbortSignal,
) {
    const session = (await scope.request(updatePreferencesEndpoint, { body }, { signal })).data;
    if (session.user.id !== scope.accountId)
        throw new ContractValidationError([
            { path: '/user/id', message: '偏好响应不属于当前账号' },
        ]);
    return session;
}
