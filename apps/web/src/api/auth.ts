import type { LoginInput } from '@scova/models';
import { loginEndpoint } from '@/api/endpoints';
import type { SessionLifecycle } from '@/api/session';

/** 成功交接使用发起时的代次，旧登录不能覆盖后安装的会话。 */
export async function login(
    scope: ReturnType<SessionLifecycle['capture']>,
    input: LoginInput,
    signal: AbortSignal,
) {
    const response = await scope.request(loginEndpoint, { body: input }, { signal });
    scope.replaceSession(response.data);
}
