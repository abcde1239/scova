import { ref } from 'vue';
import { LoginInputSchema, parseContract, type LoginInput } from '@scova/models';
import { login } from '@/api/auth';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { authErrors, type AuthErrorTranslator } from '@/utils/i18n/auth-errors';
import { useCommand } from '@/composable/useCommand';

export type LoginField = 'email' | 'password';
export type LoginOutcome = 'success' | 'invalid' | 'error' | 'cancelled' | 'ignored';

export function createLoginController(
    lifecycle: SessionLifecycle,
    translate?: AuthErrorTranslator,
) {
    const command = useCommand();
    const { fields, fieldKeys, message, messageKey } = authErrors<LoginField>(translate);
    const firstField = ref<LoginField>();
    const controller = new AbortController();
    let disposed = false;

    async function submit(input: LoginInput): Promise<LoginOutcome> {
        if (disposed || command.pending.value) return 'ignored';
        return (
            (await command.run(async (): Promise<LoginOutcome> => {
                fieldKeys.value = {};
                messageKey.value = undefined;
                firstField.value = undefined;
                const scope = lifecycle.capture();
                try {
                    parseContract(LoginInputSchema, input);
                    await login(scope, input, controller.signal);
                    return disposed ? 'cancelled' : 'success';
                } catch (cause) {
                    const error = toApiError(cause);
                    if (disposed || error.kind === 'cancelled') return 'cancelled';
                    const errors: typeof fieldKeys.value = {};
                    for (const detail of error.fieldErrors ?? []) {
                        const field = detail.path.replace(/^\/(body\/)?/, '');
                        if (field === 'email' || field === 'password')
                            errors[field] =
                                field === 'email'
                                    ? 'invalidEmail'
                                    : input.password.length > 128
                                      ? 'passwordTooLong'
                                      : 'requiredPassword';
                    }
                    fieldKeys.value = errors;
                    firstField.value = errors.email
                        ? 'email'
                        : errors.password
                          ? 'password'
                          : undefined;
                    if (firstField.value) {
                        messageKey.value = undefined;
                        return 'invalid';
                    }
                    messageKey.value =
                        error.status === 401
                            ? 'invalidCredentials'
                            : error.status === 429
                              ? 'loginLimited'
                              : error.kind === 'network'
                                ? 'network'
                                : 'loginFailed';
                    return 'error';
                }
            })) ?? 'ignored'
        );
    }
    function dispose() {
        disposed = true;
        controller.abort();
    }
    return { pending: command.pending, fields, message, firstField, messageKey, submit, dispose };
}
