<template>
    <div class="layout-grid gap-2">
        <p class="m-0" role="status">记录 {{ start }}–{{ end }}，共 {{ attachment.rowCount }} 条</p>
        <state-panel v-if="rows.isPending.value" state="loading" message="正在读取 CSV 记录" />
        <state-panel
            v-else-if="rows.isError.value"
            state="error"
            message="无法查看 CSV 记录"
            retryable
            @retry="rows.refetch()"
        />
        <ol v-else class="layout-grid gap-2 m-0 p-0 list-none" aria-label="CSV 提取内容">
            <li
                v-for="row in rows.data.value?.data.rows"
                :key="row.rowNumber"
                class="border-theme rounded-2 bg-surface p-2 break-anywhere"
            >
                <p class="m-0 font-semibold">
                    记录 {{ row.rowNumber }} · 原文件{{
                        row.startLine === row.endLine
                            ? `第 ${row.startLine} 行`
                            : `第 ${row.startLine}–${row.endLine} 行`
                    }}
                </p>
                <ol class="m-0 pl-6">
                    <li v-for="(cell, index) in row.cells" :key="index" class="whitespace-pre-wrap">
                        {{ cell || '（空）' }}
                    </li>
                </ol>
            </li>
        </ol>
        <div class="flex flex-wrap gap-2">
            <action-button
                :disabled="start === 1 || rows.isFetching.value"
                @click="start -= pageSize"
                >上一组</action-button
            >
            <action-button
                :disabled="end >= attachment.rowCount || rows.isFetching.value"
                @click="start += pageSize"
                >下一组</action-button
            >
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ReportAttachment } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { reportAttachmentRowsEndpoint } from '@/api/report-attachments';
import { useSessionQuery } from '@/composable/useSessionQuery';

const props = defineProps<{
    reportId: string;
    attachment: Extract<ReportAttachment, { status: 'ready' }>;
}>();
const pageSize = 10;
const start = ref(1);
const end = computed(() => Math.min(props.attachment.rowCount, start.value + pageSize - 1));
const rows = useSessionQuery(
    reportAttachmentRowsEndpoint,
    () => ({
        params: { reportId: props.reportId, attachmentId: props.attachment.id },
        query: { start: start.value, end: end.value },
    }),
    () => ['report-attachment-rows', props.reportId, props.attachment.id],
);
</script>
