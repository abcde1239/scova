<template>
    <action-button v-if="attachment" text :busy="pending === attachmentId" @click="saveAttachment">
        下载附件：{{ attachment.filename }}
    </action-button>
    <span v-else-if="query.isPending.value" class="text-sm text-muted" role="status"
        >正在读取附件…</span
    >
    <div v-else class="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>附件暂不可用</span>
        <action-button v-if="retryable" text @click="query.refetch()">重试读取附件</action-button>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { toApiError } from '@/api/errors';
import {
    downloadThreadAttachmentEndpoint,
    threadAttachmentEndpoint,
} from '@/api/thread-attachments';
import ActionButton from '@/component/common/ActionButton.vue';
import { usePrivateDownload } from '@/composable/usePrivateDownload';
import { useSessionQuery } from '@/composable/useSessionQuery';

const props = defineProps<{ threadId: string; attachmentId: string }>();
const params = computed(() => ({ threadId: props.threadId, attachmentId: props.attachmentId }));
const query = useSessionQuery(threadAttachmentEndpoint, () => ({ params: params.value }));
const attachment = computed(() => {
    const data = query.data.value?.data;
    if (!query.isError.value && data?.id === props.attachmentId && data.threadId === props.threadId)
        return data;
});
const retryable = computed(
    () => ![401, 403, 404, 410].includes(toApiError(query.error.value).status ?? 0),
);
const { download, pending } = usePrivateDownload();
function saveAttachment() {
    if (attachment.value)
        return download(
            downloadThreadAttachmentEndpoint,
            params.value,
            props.attachmentId,
            attachment.value.filename,
        );
}
</script>
