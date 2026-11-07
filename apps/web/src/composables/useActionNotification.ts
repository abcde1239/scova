import { h, onScopeDispose } from 'vue';
import { useNotification } from 'naive-ui';

/** 仅展示已确认的用户操作结果；不读取服务端通知或改变业务状态。 */
export function useActionNotification() {
    const notification = useNotification();
    let active = true;
    onScopeDispose(() => {
        active = false;
    });
    function show(type: 'success' | 'error' | 'warning' | 'info', title: string, content?: string) {
        if (!active) return;
        return notification[type]({
            title: () => h('span', { role: 'status', 'aria-live': 'polite' }, title),
            content,
            duration: type === 'success' ? 3000 : 6000,
            closable: true,
            keepAliveOnHover: true,
        });
    }
    return {
        success: (title: string, content?: string) => show('success', title, content),
        error: (title: string, content?: string) => show('error', title, content),
        warning: (title: string, content?: string) => show('warning', title, content),
        info: (title: string, content?: string) => show('info', title, content),
    };
}
