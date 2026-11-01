import {
    RegisterInputSchema,
    SessionResponseSchema,
    type RegisterInput,
    type SessionResponse,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import type { SessionLifecycle } from '@/api/session';

const registerEndpoint = defineApiEndpoint<{ body: RegisterInput; data: SessionResponse }>({
    method: 'POST',
    path: '/auth/register',
    anonymous: true,
    inputValidators: { body: modelValidator(RegisterInputSchema) },
    validator: modelValidator(SessionResponseSchema),
});
export async function register(
    scope: ReturnType<SessionLifecycle['capture']>,
    input: RegisterInput,
    signal: AbortSignal,
) {
    const response = await scope.request(registerEndpoint, { body: input }, { signal });
    scope.replaceSession(response.data);
}
