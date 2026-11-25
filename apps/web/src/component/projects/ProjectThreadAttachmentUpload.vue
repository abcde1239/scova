<template>
    <div class="min-w-0 flex flex-col gap-1 text-sm">
        <label :for="inputId" class="font-medium">添加附件</label>
        <input
            :id="inputId"
            name="thread-attachment"
            type="file"
            accept=".csv,.txt,.pdf"
            class="max-w-full"
            :disabled="disabled || pending || remaining < 1"
            :aria-describedby="`${inputId}-hint ${inputId}-status`"
            :aria-invalid="Boolean(error)"
            @change="selectAttachment"
        />
        <span :id="`${inputId}-hint`" class="text-xs opacity-75">
            CSV、TXT 或 PDF，最大 256 KiB。PDF 仅供下载。
        </span>
        <div :id="`${inputId}-status`" role="status">
            {{ error || (pending ? '正在上传附件…' : success) }}
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ProjectThreadAttachment } from '@scova/models';
import { onScopeDispose, ref, useId, watch } from 'vue';
import { toApiError } from '@/api/errors';
import { threadAttachmentFile, uploadThreadAttachmentEndpoint } from '@/api/thread-attachments';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

const props = withDefaults(
    defineProps<{ threadId: string; disabled?: boolean; remaining?: number }>(),
    {
        disabled: false,
        remaining: 3,
    },
);
const emit = defineEmits<{
    uploaded: [attachment: ProjectThreadAttachment];
    busy: [value: boolean];
}>();
const inputId = useId();
const lifecycle = useSessionLifecycle();
const pending = ref(false);
const error = ref('');
const success = ref('');
let active: AbortController | undefined;

function stopUpload() {
    active?.abort();
    active = undefined;
    if (pending.value) emit('busy', false);
    pending.value = false;
    error.value = '';
    success.value = '';
}
watch(() => props.threadId, stopUpload);
onScopeDispose(stopUpload);

async function selectAttachment(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || props.disabled || pending.value || props.remaining < 1) return;
    error.value = '';
    success.value = '';
    let upload;
    try {
        upload = threadAttachmentFile(file);
    } catch (cause) {
        error.value = cause instanceof TypeError ? cause.message : '无法读取附件';
        return;
    }
    const threadId = props.threadId;
    const scope = lifecycle.capture();
    const controller = new AbortController();
    const unregister = scope.registerCleanup(stopUpload);
    active = controller;
    pending.value = true;
    emit('busy', true);
    const isCurrent = () =>
        !controller.signal.aborted && scope.isCurrent() && props.threadId === threadId;
    try {
        const { data } = await scope.request(
            uploadThreadAttachmentEndpoint,
            {
                params: { threadId },
                ...upload,
            },
            { signal: controller.signal },
        );
        if (!isCurrent()) return;
        if (data.threadId !== threadId) throw new Error('附件会话不匹配');
        success.value = `已添加 ${data.filename}`;
        emit('uploaded', data);
    } catch (cause) {
        if (!isCurrent()) return;
        const failure = toApiError(cause);
        error.value =
            failure.status === 503
                ? '附件存储暂时不可用，请稍后重试。'
                : failure.status === 415 || failure.status === 422
                  ? '文件内容与格式不符，请检查后重试。'
                  : '附件上传失败，请重试。';
    } finally {
        unregister();
        if (active === controller) {
            active = undefined;
            pending.value = false;
            emit('busy', false);
        }
    }
}
</script>
