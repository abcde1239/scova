import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref, type VNode } from 'vue';
import { useActionNotification } from '@/composables/useActionNotification';

const notification = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
}));
vi.mock('naive-ui', () => ({ useNotification: () => notification }));
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop());
    vi.clearAllMocks();
});

describe('操作 notification', () => {
    it('不回放旧消息，忽略空消息，相同操作在新一轮仍可报告', async () => {
        const message = ref('旧结果');
        const scope = effectScope();
        scopes.push(scope);
        scope.run(() => useActionNotification().watch(message, 'success'));
        await nextTick();
        expect(notification.success).not.toHaveBeenCalled();
        message.value = '';
        await nextTick();
        message.value = '已恢复为未读。';
        await nextTick();
        expect(notification.success).toHaveBeenCalledTimes(1);
        const options = notification.success.mock.calls[0]![0];
        expect((options.title() as VNode).children).toBe('已恢复为未读。');
        expect(options.duration).toBe(3000);
        expect(options.closable).toBe(true);
        message.value = '   ';
        await nextTick();
        message.value = '已恢复为未读。';
        await nextTick();
        expect(notification.success).toHaveBeenCalledTimes(2);
    });

    it('按实际结果分级，卸载后停止观察和迟到的显式报告', async () => {
        const message = ref('');
        const failed = ref(false);
        const scope = effectScope();
        scopes.push(scope);
        const notices = scope.run(() => {
            const value = useActionNotification();
            value.watch(message, () => (failed.value ? 'error' : 'info'));
            return value;
        })!;
        failed.value = true;
        message.value = '操作未完成';
        await nextTick();
        const options = notification.error.mock.calls[0]![0];
        expect((options.title() as VNode).props?.role).toBe('alert');
        expect(options.duration).toBe(6000);
        scope.stop();
        message.value = '迟到结果';
        notices.success('旧页面的成功结果');
        await nextTick();
        expect(notification.error).toHaveBeenCalledTimes(1);
        expect(notification.success).not.toHaveBeenCalled();
        expect(notification.info).not.toHaveBeenCalled();
    });
});
