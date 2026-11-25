<template>
    <div class="layout-grid gap-6">
        <state-panel v-if="detail.isPending.value" state="loading" message="正在读取工作流" />
        <state-panel
            v-else-if="!detail.data.value && detail.isError.value"
            :state="toApiError(detail.error.value).status === 404 ? 'empty' : 'error'"
            :message="toApiError(detail.error.value).message"
            :retryable="toApiError(detail.error.value).status !== 404"
            @retry="detail.refetch()"
        />
        <template v-else-if="detail.data.value">
            <workflow-editor
                :key="`${instanceKey}-editor`"
                :snapshot="detail.data.value"
                @dirty="draftDirty = $event"
            />
            <workflow-templates
                v-if="detail.data.value.data.publishedVersion"
                :key="`${instanceKey}-templates`"
                :workflow-id="workflowId"
                :version-id="detail.data.value.data.publishedVersion.id"
                @copied="openWorkflow"
                @started="openRun"
            />
            <workflow-runs
                :key="`${instanceKey}-runs`"
                :workflow-id="workflowId"
                :published="detail.data.value.data.publishedVersion"
                :draft="detail.data.value.data.draft"
                :draft-revision="detail.data.value.data.workflow.revision"
                :draft-dirty="draftDirty"
            />
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toApiError } from '@/api/errors';
import { workflowEndpoint } from '@/api/workflows';
import StatePanel from '@/component/common/StatePanel.vue';
import WorkflowEditor from '@/component/workflows/WorkflowEditor.vue';
import WorkflowTemplates from '@/component/workflows/WorkflowTemplates.vue';
import WorkflowRuns from '@/component/workflows/WorkflowRuns.vue';
import { useSessionLifecycle, useSessionQuery } from '@/composable/useSessionQuery';

const route = useRoute();
const router = useRouter();
const draftDirty = ref(false);
const lifecycle = useSessionLifecycle();
const workflowId = computed(() => String(route.params.workflowId));
function openWorkflow(id: string) {
    void lifecycle.queryClient.invalidateQueries({
        queryKey: lifecycle.capture().queryKey(['workflows', 'list']),
    });
    void router.push({ name: 'workflow-detail', params: { workflowId: id } });
}
function openRun(_workflowId: string, runId: string) {
    void router.push({ name: 'workflow-run-detail', params: { runId } });
}
const instanceKey = computed(() => `${lifecycle.session.epoch}-${workflowId.value}`);
const detail = useSessionQuery(
    workflowEndpoint,
    () => ({ params: { workflowId: workflowId.value } }),
    () => ['workflows', workflowId.value, 'detail'],
    lifecycle,
);
</script>
