<template>
    <section class="layout-grid gap-3 p-4" aria-labelledby="report-attachments-title">
        <h3 id="report-attachments-title" class="sr-only">附件管理</h3>
        <form class="layout-grid gap-2" method="post" @submit.prevent="upload">
            <label for="report-attachment-file">选择附件</label>
            <p id="report-attachment-help" class="m-0 text-muted">
                支持 UTF-8 CSV、TXT 和仅供下载的 PDF，每个文件最大 {{ maxFileKiB }} KiB。
            </p>
            <div class="flex items-center flex-wrap gap-2">
                <input
                    ref="picker"
                    id="report-attachment-file"
                    name="file"
                    type="file"
                    accept=".csv,.txt,.pdf"
                    aria-describedby="report-attachment-help"
                    class="min-w-0 max-w-full min-h-11 keyboard-focus-wide"
                    required
                    @change="selectFile"
                />
                <action-button
                    attr-type="submit"
                    :busy="uploadMutation.isPending.value"
                    :disabled="!file"
                    >上传附件</action-button
                >
            </div>
        </form>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取附件" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            message="无法读取附件"
            retryable
            @retry="query.refetch()"
        />
        <p v-else-if="!items.length" class="m-0 text-muted">暂无参考附件</p>
        <ul v-else class="layout-grid gap-3 list-none m-0 p-0">
            <li
                v-for="item in items"
                :key="item.id"
                class="layout-grid gap-2 border-theme rounded-2 p-3"
            >
                <p class="m-0 font-semibold break-anywhere">{{ item.filename }}</p>
                <p class="m-0 text-muted text-sm">
                    {{
                        item.status === 'ready'
                            ? `可查看 ${item.rowCount} 行`
                            : item.status === 'failed'
                              ? failureLabels[item.failureCode]
                              : 'PDF · 可下载原文件'
                    }}
                </p>
                <div class="flex flex-wrap items-center gap-3">
                    <action-button
                        v-if="item.status === 'ready'"
                        v-bind="{ 'aria-expanded': openId === item.id }"
                        @click="openId = openId === item.id ? '' : item.id"
                    >
                        {{ openId === item.id ? '收起内容' : '查看内容' }}
                    </action-button>
                    <action-button
                        :disabled="!!pendingDownload && pendingDownload !== item.id"
                        :busy="pendingDownload === item.id"
                        @click="downloadAttachment(item)"
                        >下载原文件</action-button
                    >
                    <action-button v-if="confirmId !== item.id" @click="confirmId = item.id"
                        >删除附件</action-button
                    >
                    <template v-else>
                        <action-button
                            :busy="deleteMutation.isPending.value"
                            class="danger-action"
                            @click="remove(item.id)"
                            >确认删除</action-button
                        >
                        <action-button
                            :disabled="deleteMutation.isPending.value"
                            @click="confirmId = ''"
                            >返回</action-button
                        >
                    </template>
                </div>
                <report-attachment-preview
                    v-if="openId === item.id && item.status === 'ready'"
                    :key="item.id"
                    :report-id="reportId"
                    :attachment="item"
                />
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import {
    REPORT_ATTACHMENT_MAX_BYTES,
    REPORT_ATTACHMENT_MEDIA_TYPES,
    reportAttachmentFormat,
    type ReportAttachment,
    type ReportAttachmentFailure,
} from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import ReportAttachmentPreview from '@/component/reports/ReportAttachmentPreview.vue';
import {
    deleteReportAttachmentEndpoint,
    downloadReportAttachmentEndpoint,
    reportAttachmentsEndpoint,
    uploadReportAttachmentEndpoint,
} from '@/api/report-attachments';
import { usePrivateDownload } from '@/composable/usePrivateDownload';
import { toApiError } from '@/api/errors';
import { useActionNotification } from '@/composable/useActionNotification';
import {
    useSessionLifecycle,
    useSessionMutation,
    useSessionQuery,
} from '@/composable/useSessionQuery';

const props = defineProps<{ reportId: string }>();
const lifecycle = useSessionLifecycle();
const notice = useActionNotification();
const { download, pending: pendingDownload } = usePrivateDownload();
function downloadAttachment(item: ReportAttachment) {
    return download(
        downloadReportAttachmentEndpoint,
        { reportId: props.reportId, attachmentId: item.id },
        item.id,
        item.filename,
    );
}
const key = () => ['report-attachments', props.reportId];
const query = useSessionQuery(
    reportAttachmentsEndpoint,
    () => ({ params: { reportId: props.reportId } }),
    key,
    lifecycle,
);
const items = computed(() => query.data.value?.data.items ?? []);
const uploadMutation = useSessionMutation(uploadReportAttachmentEndpoint, lifecycle);
const deleteMutation = useSessionMutation(deleteReportAttachmentEndpoint, lifecycle);
const maxFileKiB = REPORT_ATTACHMENT_MAX_BYTES / 1024;
const failureLabels: Record<ReportAttachmentFailure, string> = {
    INVALID_UTF8: '无法解析：文件不是有效的 UTF-8 文本。',
    INVALID_CSV: '无法解析：CSV 格式无效。',
    CSV_LIMIT_EXCEEDED: '无法解析：行、列或单元格超出限制。',
    INVALID_TEXT: '无法解析：纯文本无内容或含不支持的控制字符。',
    TEXT_LIMIT_EXCEEDED: '无法解析：纯文本的行数或单行长度超出限制。',
};
const picker = ref<HTMLInputElement>();
const file = shallowRef<File>();
const openId = ref('');
const confirmId = ref('');

function resetFile() {
    file.value = undefined;
    if (picker.value) picker.value.value = '';
}
watch([() => props.reportId, () => lifecycle.session.epoch], () => {
    resetFile();
    openId.value = '';
    confirmId.value = '';
});
function selectFile(event: Event) {
    file.value = (event.currentTarget as HTMLInputElement).files?.[0];
}

async function upload() {
    const source = file.value;
    if (!source || uploadMutation.isPending.value) return;
    const format = reportAttachmentFormat(source.name);
    if (!format || !source.size || source.size > REPORT_ATTACHMENT_MAX_BYTES) {
        notice.error(`请选择非空且不超过 ${maxFileKiB} KiB 的 CSV、TXT 或 PDF 文件`);
        return;
    }
    const scope = lifecycle.capture();
    const reportId = props.reportId;
    try {
        const { data } = await uploadMutation.mutateAsync({
            input: {
                params: { reportId },
                query: { filename: source.name },
                body: source.slice(0, source.size, REPORT_ATTACHMENT_MEDIA_TYPES[format]),
            },
        });
        if (!scope.isCurrent() || props.reportId !== reportId) return;
        resetFile();
        if (data.status === 'failed')
            notice.warning('已保留原文件', failureLabels[data.failureCode]);
        else notice.success(data.status === 'ready' ? '已上传并解析附件' : '已上传 PDF 附件');
        await query.refetch();
    } catch (error) {
        if (scope.isCurrent() && props.reportId === reportId)
            notice.error('上传附件失败', toApiError(error).message);
    }
}

async function remove(attachmentId: string) {
    if (deleteMutation.isPending.value) return;
    const scope = lifecycle.capture();
    const reportId = props.reportId;
    try {
        await deleteMutation.mutateAsync({ input: { params: { reportId, attachmentId } } });
        if (!scope.isCurrent() || props.reportId !== reportId) return;
        confirmId.value = '';
        if (openId.value === attachmentId) openId.value = '';
        notice.success('已删除附件');
        await query.refetch();
    } catch (error) {
        if (scope.isCurrent() && props.reportId === reportId)
            notice.error('删除附件失败', toApiError(error).message);
    }
}
</script>
