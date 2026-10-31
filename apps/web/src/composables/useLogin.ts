import { ref } from 'vue';
import { LoginInputSchema, parseContract, type LoginInput } from '@scova/models';
import { login } from '@/api/auth';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { useCommand } from '@/composables/useCommand';

export type LoginField = 'email' | 'password';
export type LoginOutcome = 'success' | 'invalid' | 'error' | 'cancelled' | 'ignored';

export function createLoginController(lifecycle: SessionLifecycle) {
    const command = useCommand();
    const fields = ref<Partial<Record<LoginField, string>>>({});
    const message = ref('');
    const firstField = ref<LoginField>();
    const controller = new AbortController();
    let disposed = false;

    async function submit(input: LoginInput): Promise<LoginOutcome> {
        if (disposed || command.pending.value) return 'ignored';
        return (
            (await command.run(async (): Promise<LoginOutcome> => {
                fields.value = {};
                message.value = '';
                firstField.value = undefined;
                const scope = lifecycle.capture();
                try {
                    parseContract(LoginInputSchema, input);
                    await login(scope, input, controller.signal);
                    return disposed ? 'cancelled' : 'success';
                } catch (cause) {
                    const error = toApiError(cause);
                    if (disposed || error.kind === 'cancelled') return 'cancelled';
                    for (const detail of error.fieldErrors ?? []) {
                        const field = detail.path.replace(/^\/(body\/)?/, '');
                        if (field === 'email' || field === 'password')
                            fields.value[field] =
                                field === 'email'
                                    ? '请输入有效邮箱地址'
                                    : '请输入1至128个字符的密码';
                    }
                    firstField.value = fields.value.email
                        ? 'email'
                        : fields.value.password
                          ? 'password'
                          : undefined;
                    if (firstField.value) {
                        message.value = '请检查标出的字段';
                        return 'invalid';
                    }
                    message.value =
                        error.status === 401
                            ? '邮箱或密码不正确'
                            : error.status === 429
                              ? '登录尝试过于频繁，请稍后重试'
                              : error.kind === 'network'
                                ? '暂时无法连接，请检查网络后重试'
                                : '登录未成功，请稍后重试';
                    return 'error';
                }
            })) ?? 'ignored'
        );
    }
    function dispose() {
        disposed = true;
        controller.abort();
    }
    return { pending: command.pending, fields, message, firstField, submit, dispose };
}
