import { ref } from 'vue';
import { RegisterInputSchema, parseContract, type RegisterInput } from '@scova/models';
import { register } from '@/api/register';
import type { SessionLifecycle } from '@/api/session';
import { toApiError } from '@/api/errors';
import { useCommand } from '@/composables/useCommand';

type RegisterField = keyof RegisterInput;
export function createRegisterController(lifecycle: SessionLifecycle) {
    const command = useCommand();
    const fields = ref<Partial<Record<RegisterField, string>>>({});
    const firstField = ref<RegisterField>();
    const message = ref('');
    const closed = ref(false);
    const controller = new AbortController();
    let disposed = false;
    const labels: Record<RegisterField, string> = {
        email: '请输入有效邮箱地址',
        password: '密码须为12至128个字符',
        defaultTimezone: '请输入有效的IANA时区，例如Asia/Shanghai',
    };
    async function submit(input: RegisterInput) {
        if (disposed || command.pending.value || closed.value) return 'ignored';
        return command.run(async () => {
            fields.value = {};
            firstField.value = undefined;
            message.value = '';
            const scope = lifecycle.capture();
            try {
                parseContract(RegisterInputSchema, input);
                await register(scope, input, controller.signal);
                return disposed ? 'cancelled' : 'success';
            } catch (cause) {
                const error = toApiError(cause);
                if (disposed || error.kind === 'cancelled') return 'cancelled';
                for (const detail of error.fieldErrors ?? []) {
                    const field = detail.path.replace(/^\/(body\/)?/, '');
                    if (field === 'email' || field === 'password' || field === 'defaultTimezone')
                        fields.value[field] = labels[field];
                }
                if (error.status === 409) fields.value.email = '该邮箱已注册，请返回登录';
                firstField.value = (['email', 'password', 'defaultTimezone'] as const).find(
                    (field) => fields.value[field],
                );
                closed.value = error.status === 403 && error.code === 'REGISTRATION_DISABLED';
                message.value = closed.value
                    ? '当前部署已关闭注册，请返回登录'
                    : firstField.value
                      ? '请检查标出的字段'
                      : error.status === 429
                        ? '注册尝试过于频繁，请稍后重试'
                        : error.kind === 'network'
                          ? '暂时无法连接，请检查网络后重试'
                          : '注册未成功，请稍后重试';
                return firstField.value ? 'invalid' : 'error';
            }
        });
    }
    function dispose() {
        disposed = true;
        controller.abort();
    }
    return { pending: command.pending, fields, firstField, message, closed, submit, dispose };
}
