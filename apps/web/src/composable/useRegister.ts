import { ref } from 'vue';
import { RegisterInputSchema, parseContract, type RegisterInput } from '@scova/models';
import { register } from '@/api/register';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { authErrors, type AuthErrorTranslator } from '@/utils/i18n/auth-errors';
import { useCommand } from '@/composable/useCommand';

type RegisterField = keyof RegisterInput;
export function createRegisterController(
    lifecycle: SessionLifecycle,
    translate?: AuthErrorTranslator,
) {
    const command = useCommand();
    const { fields, fieldKeys, message, messageKey } = authErrors<RegisterField>(translate);
    const firstField = ref<RegisterField>();
    const closed = ref(false);
    const controller = new AbortController();
    let disposed = false;
    const labels = {
        email: 'invalidEmail',
        password: 'passwordTooShort',
        defaultTimezone: 'invalidTimezone',
    } as const;
    async function submit(input: RegisterInput) {
        if (disposed || command.pending.value || closed.value) return 'ignored';
        return command.run(async () => {
            fieldKeys.value = {};
            firstField.value = undefined;
            messageKey.value = undefined;
            const scope = lifecycle.capture();
            try {
                parseContract(RegisterInputSchema, input);
                await register(scope, input, controller.signal);
                return disposed ? 'cancelled' : 'success';
            } catch (cause) {
                const error = toApiError(cause);
                if (disposed || error.kind === 'cancelled') return 'cancelled';
                const errors: typeof fieldKeys.value = {};
                for (const detail of error.fieldErrors ?? []) {
                    const field = detail.path.replace(/^\/(body\/)?/, '');
                    if (field === 'email' || field === 'password' || field === 'defaultTimezone')
                        errors[field] =
                            field === 'password' && Array.from(input.password).length > 128
                                ? 'passwordTooLong'
                                : labels[field];
                }
                if (error.status === 409) errors.email = 'emailRegistered';
                fieldKeys.value = errors;
                firstField.value = (['email', 'password', 'defaultTimezone'] as const).find(
                    (field) => errors[field],
                );
                closed.value = error.status === 403 && error.code === 'REGISTRATION_DISABLED';
                messageKey.value = closed.value
                    ? 'registrationClosed'
                    : firstField.value
                      ? undefined
                      : error.status === 429
                        ? 'registerLimited'
                        : error.kind === 'network'
                          ? 'network'
                          : 'registerFailed';
                return firstField.value ? 'invalid' : 'error';
            }
        });
    }
    function dispose() {
        disposed = true;
        controller.abort();
    }
    return {
        pending: command.pending,
        fields,
        firstField,
        message,
        messageKey,
        closed,
        submit,
        dispose,
    };
}
