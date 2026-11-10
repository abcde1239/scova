import { computed, onScopeDispose, ref, watch } from 'vue';
import {
    avatarStateEndpoint,
    removeAvatarEndpoint,
    uploadAvatarEndpoint,
    validateAvatarFile,
} from '@/api/avatar';
import { currentSessionEndpoint } from '@/api/endpoints';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle, useSessionQuery } from '@/composables/useSessionQuery';

export function useAvatar() {
    const lifecycle = useSessionLifecycle();
    const query = useSessionQuery(avatarStateEndpoint, {}, ['account-avatar']);
    const file = ref<File>();
    const preview = ref<string>();
    const pending = ref(false);
    const message = ref('');
    const success = ref(false);
    let disposed = false;
    let active: AbortController | undefined;
    let operation = 0;
    const user = computed(() => lifecycle.session.user);
    const clear = () => {
        if (preview.value) URL.revokeObjectURL(preview.value);
        preview.value = undefined;
        file.value = undefined;
    };
    const select = (next: File | undefined) => {
        if (pending.value || !next) return;
        message.value = '';
        success.value = false;
        clear();
        try {
            validateAvatarFile(next);
            file.value = next;
            preview.value = URL.createObjectURL(next);
        } catch (error) {
            message.value = error instanceof Error ? error.message : '图片无法读取';
        }
    };
    async function run(action: 'upload' | 'remove' | 'refresh') {
        if (disposed || pending.value || (action === 'upload' && !file.value)) return;
        const scope = lifecycle.capture();
        if (!scope.accountId) return;
        const currentOperation = ++operation;
        pending.value = true;
        message.value = '';
        success.value = false;
        active = new AbortController();
        const queryInput = { expectedVersion: user.value?.avatarVersion ?? 'none' };
        try {
            const options = { signal: active.signal, timeout: 45_000 };
            const response =
                action === 'refresh'
                    ? await scope.request(currentSessionEndpoint, {}, options)
                    : action === 'remove'
                      ? await scope.request(removeAvatarEndpoint, { query: queryInput }, options)
                      : await scope.request(
                            uploadAvatarEndpoint,
                            { query: queryInput, body: file.value! },
                            options,
                        );
            if (disposed || !scope.isCurrent()) return;
            if (response.data.user.id !== scope.accountId) throw new Error('账号响应不匹配');
            scope.refreshSession(response.data);
            clear();
            await query.refetch();
            if (disposed || !scope.isCurrent()) return;
            success.value = true;
            message.value =
                action === 'upload'
                    ? '头像已更新'
                    : action === 'remove'
                      ? '头像已移除'
                      : '头像已刷新';
        } catch (cause) {
            const error = toApiError(cause);
            if (disposed || !scope.isCurrent() || error.kind === 'cancelled') return;
            message.value =
                error.status === 409
                    ? '头像已在其他页面更新，请先刷新头像后重试'
                    : error.status === 413
                      ? '请选择不超过5 MiB的图片'
                      : error.status === 415 || error.status === 422
                        ? '图片无法读取，请选择完整的JPEG、PNG、GIF或WebP图片'
                        : error.status === 429
                          ? '操作过于频繁，请稍后重试'
                          : error.status === 503
                            ? '头像存储暂时不可用，请稍后重试'
                            : '暂未确认头像是否保存，请先刷新头像后再操作';
        } finally {
            if (!disposed && currentOperation === operation) {
                pending.value = false;
                active = undefined;
            }
        }
    }
    const stop = watch(
        () => lifecycle.session.epoch,
        () => {
            operation++;
            active?.abort();
            clear();
            message.value = '';
            success.value = false;
            pending.value = false;
        },
    );
    onScopeDispose(() => {
        disposed = true;
        active?.abort();
        clear();
        stop();
    });
    return {
        query,
        file,
        preview,
        pending,
        message,
        success,
        user,
        select,
        cancel: clear,
        upload: () => run('upload'),
        remove: () => run('remove'),
        refresh: () => run('refresh'),
    };
}
