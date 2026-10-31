import { computed, onScopeDispose, ref, watch } from 'vue';
import {
    UpdatePreferencesInputSchema,
    parseContract,
    type Preferences,
    type UpdatePreferencesInput,
    type User,
} from '@scova/models';
import { currentSessionEndpoint } from '@/api/endpoints';
import { savePreferences } from '@/api/preferences';
import { toApiError } from '@/api/errors';
import type { SessionLifecycle } from '@/api/session';
import { useCommand } from '@/composables/useCommand';
import { useSessionLifecycle, useSessionQuery } from '@/composables/useSessionQuery';

export type PreferenceField = 'defaultTimezone' | 'mode' | 'runIssues';
type Outcome = 'success' | 'invalid' | 'error' | 'cancelled' | 'ignored';

function copy(preferences: Preferences): Preferences {
    return {
        defaultTimezone: preferences.defaultTimezone,
        notificationPreference: { ...preferences.notificationPreference },
    };
}

export function createPreferencesController(lifecycle: SessionLifecycle) {
    const command = useCommand();
    const draft = ref<Preferences>({
        defaultTimezone: '',
        notificationPreference: { mode: 'summary', runIssues: true },
    });
    let baseline = copy(draft.value);
    const revision = ref(0);
    const fields = ref<Partial<Record<PreferenceField, string>>>({});
    const firstField = ref<PreferenceField>();
    const message = ref('');
    const saved = ref(false);
    const controller = new AbortController();
    let disposed = false;
    let owner: string | undefined;
    const changes = computed<UpdatePreferencesInput>(() => {
        void revision.value;
        return {
            ...(draft.value.defaultTimezone === baseline.defaultTimezone
                ? {}
                : { defaultTimezone: draft.value.defaultTimezone }),
            ...(draft.value.notificationPreference.mode === baseline.notificationPreference.mode &&
            draft.value.notificationPreference.runIssues ===
                baseline.notificationPreference.runIssues
                ? {}
                : { notificationPreference: { ...draft.value.notificationPreference } }),
        };
    });
    const dirty = computed(() => Object.keys(changes.value).length > 0);
    function apply(user: User) {
        baseline = copy(user.preferences);
        draft.value = copy(user.preferences);
        revision.value++;
    }
    function acceptServer(user: User) {
        if (
            !disposed &&
            user.id === lifecycle.session.user?.id &&
            !dirty.value &&
            !command.pending.value
        )
            apply(user);
    }
    // Vue batches advance/install into one account transition. A same-account refresh keeps edits.
    const stopAccount = watch(
        () => lifecycle.session.user,
        (user) => {
            if (user?.id !== owner) {
                owner = user?.id;
                fields.value = {};
                message.value = '';
                saved.value = false;
                if (user) apply(user);
                else {
                    draft.value = {
                        defaultTimezone: '',
                        notificationPreference: { mode: 'summary', runIssues: true },
                    };
                    baseline = copy(draft.value);
                    revision.value++;
                }
            } else if (user) acceptServer(user);
        },
        { immediate: true },
    );
    const stopDirty = watch(dirty, (value) => {
        if (value) saved.value = false;
    });

    async function submit(input: UpdatePreferencesInput = changes.value): Promise<Outcome> {
        if (disposed || command.pending.value) return 'ignored';
        return (
            (await command.run(async (): Promise<Outcome> => {
                fields.value = {};
                firstField.value = undefined;
                message.value = '';
                saved.value = false;
                const scope = lifecycle.capture();
                if (!scope.accountId) return 'cancelled';
                try {
                    parseContract(UpdatePreferencesInputSchema, input);
                    const session = await savePreferences(scope, input, controller.signal);
                    if (disposed || !scope.isCurrent()) return 'cancelled';
                    // The returned session is schema-validated; install through the guarded epoch.
                    scope.replaceSession(session);
                    apply(session.user);
                    saved.value = true;
                    return 'success';
                } catch (cause) {
                    const error = toApiError(cause);
                    if (disposed || !scope.isCurrent() || error.kind === 'cancelled')
                        return 'cancelled';
                    for (const detail of error.fieldErrors ?? []) {
                        const path = detail.path.replace(/^\/(body\/)?/, '');
                        if (path === 'defaultTimezone')
                            fields.value.defaultTimezone =
                                '请输入有效的 IANA 时区，例如 Asia/Shanghai';
                        else if (path === 'notificationPreference/runIssues')
                            fields.value.runIssues = '请选择是否接收运行问题提醒';
                        else if (path.startsWith('notificationPreference'))
                            fields.value.mode = '请选择有效的结果提醒方式';
                    }
                    firstField.value = (['defaultTimezone', 'mode', 'runIssues'] as const).find(
                        (field) => fields.value[field],
                    );
                    if (firstField.value || error.kind === 'validation') {
                        message.value = Object.keys(input).length
                            ? '请检查标出的偏好设置'
                            : '请至少修改一项默认偏好';
                        return 'invalid';
                    }
                    message.value =
                        error.status === 429
                            ? '保存过于频繁，请稍后重试'
                            : error.status === 403
                              ? '暂时无法保存，请刷新页面后重试'
                              : error.kind === 'network'
                                ? '暂时无法连接，请检查网络后重试'
                                : '默认偏好未保存，请稍后重试';
                    return 'error';
                }
            })) ?? 'ignored'
        );
    }
    function dispose() {
        disposed = true;
        controller.abort();
        stopAccount();
        stopDirty();
    }
    return {
        draft,
        dirty,
        fields,
        firstField,
        message,
        saved,
        pending: command.pending,
        acceptServer,
        submit,
        dispose,
    };
}

export function usePreferences() {
    const lifecycle = useSessionLifecycle();
    const form = createPreferencesController(lifecycle);
    const query = useSessionQuery(currentSessionEndpoint, {}, ['account-preferences'], lifecycle);
    watch(query.data, (response) => {
        if (response) form.acceptServer(response.data.user);
    });
    onScopeDispose(form.dispose);
    return { form, query };
}
