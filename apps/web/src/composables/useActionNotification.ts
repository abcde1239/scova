import { h, onScopeDispose, toValue, watch, type MaybeRefOrGetter, type VNodeChild } from 'vue';
import { useNotification } from 'naive-ui';

type NotificationType = 'success' | 'error' | 'warning' | 'info';

/** 用户操作的即时反馈；不读取服务端通知或改变业务状态。 */
export function useActionNotification() {
    const notification = useNotification();
    let active = true;
    onScopeDispose(() => {
        active = false;
    });
    function show(
        type: NotificationType,
        title: string,
        content?: string,
        action?: () => VNodeChild,
    ) {
        if (!active) return;
        return notification[type]({
            title: () =>
                h(
                    'span',
                    {
                        role: type === 'error' ? 'alert' : 'status',
                        'aria-live': type === 'error' ? 'assertive' : 'polite',
                    },
                    title,
                ),
            content,
            ...(action ? { action } : {}),
            duration: type === 'success' ? 3000 : 6000,
            closable: true,
            keepAliveOnHover: true,
        });
    }
    return {
        // Non-immediate: cached messages must not reappear when a panel is remounted.
        watch: (
            message: MaybeRefOrGetter<string>,
            type: MaybeRefOrGetter<NotificationType> = 'info',
        ) =>
            watch(
                () => toValue(message),
                (value) => {
                    if (value.trim()) show(toValue(type), value);
                },
            ),
        success: (title: string, content?: string) => show('success', title, content),
        error: (title: string, content?: string) => show('error', title, content),
        warning: (title: string, content?: string) => show('warning', title, content),
        info: (title: string, content?: string, action?: () => VNodeChild) =>
            show('info', title, content, action),
    };
}
