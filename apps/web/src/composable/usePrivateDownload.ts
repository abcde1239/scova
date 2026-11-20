import { onScopeDispose, ref } from 'vue';
import type { Endpoint } from 'requestlane';
import { toApiError } from '@/api/errors';
import { useActionNotification } from '@/composable/useActionNotification';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

type DownloadSpec<P> = { params: P; data: Blob };

export function usePrivateDownload() {
    const lifecycle = useSessionLifecycle();
    const notice = useActionNotification();
    const controller = new AbortController();
    onScopeDispose(() => controller.abort());
    const pending = ref('');

    async function download<P extends Record<string, string>>(
        endpoint: Endpoint<DownloadSpec<P>>,
        params: P,
        id: string,
        filename: string,
    ) {
        if (pending.value) return;
        const scope = lifecycle.capture();
        pending.value = id;
        try {
            const { data } = await scope.request(
                endpoint,
                { params },
                { signal: controller.signal },
            );
            if (!scope.isCurrent() || controller.signal.aborted) return;
            const url = URL.createObjectURL(data);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.append(link);
            try {
                link.click();
            } finally {
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
        } catch (error) {
            if (!scope.isCurrent() || controller.signal.aborted) return;
            notice.error(
                '下载失败',
                toApiError(error).status === 410
                    ? '图表下载已过期，请重新生成。'
                    : '暂时无法下载，请重试。',
            );
        } finally {
            pending.value = '';
        }
    }
    return { download, pending };
}
