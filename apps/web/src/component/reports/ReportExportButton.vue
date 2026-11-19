<template>
    <div class="report-export">
        <n-button
            class="report-export-action"
            :loading="pending"
            :disabled="pending"
            @click="download"
            >导出 Markdown</n-button
        >
        <span v-if="message" class="report-export-error" role="alert">{{ message }}</span>
    </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { NButton } from 'naive-ui';
import { reportExportEndpoint } from '@/api/reports';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

const props = defineProps<{ reportId: string }>();
const lifecycle = useSessionLifecycle();
const pending = ref(false);
const message = ref('');
const controller = new AbortController();
onUnmounted(() => controller.abort());

async function download() {
    if (pending.value) return;
    const scope = lifecycle.capture();
    const reportId = props.reportId;
    pending.value = true;
    message.value = '';
    try {
        const { data } = await scope.request(
            reportExportEndpoint,
            { params: { reportId } },
            { signal: controller.signal },
        );
        if (!scope.isCurrent() || controller.signal.aborted) return;
        if (data.reportId !== reportId || data.filename !== `scova-report-${reportId}.md`) {
            message.value = '导出与当前报告不匹配，请重试。';
            return;
        }
        const blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' });
        if (blob.size !== data.byteLength) {
            message.value = '导出文件长度校验失败，请重试。';
            return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = data.filename;
        document.body.append(link);
        try {
            link.click();
        } finally {
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }
    } catch (error) {
        if (!scope.isCurrent() || controller.signal.aborted) return;
        const failure = toApiError(error);
        if (failure.kind !== 'cancelled') {
            message.value =
                failure.status === 409 || failure.status === 422
                    ? failure.message
                    : '暂时无法导出报告，请重试。';
        }
    } finally {
        pending.value = false;
    }
}
</script>

<style scoped>
.report-export {
    @apply grid gap-1 min-w-0 max-w-full;
}
.report-export-action {
    min-block-size: 44px;
    min-inline-size: 44px;
    block-size: auto;
    white-space: normal;
}
.report-export-error {
    @apply text-sm break-anywhere;
}
</style>
