<template>
    <task-config-form
        v-if="!draftId || seedDraft"
        :seed-draft="seedDraft"
        :key="`${lifecycle.session.epoch}:${projectId ?? ''}:${draftId ?? ''}`"
        :project-id="projectId"
        @saved="saved"
        @draft-saved="backToProject"
    />
    <p v-else-if="draftQuery.isPending.value" role="status">正在读取草案</p>
    <p v-else role="alert">草案不可用或已经确认。</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import type { TaskDetailResponse } from '@scova/models';
import TaskConfigForm from '@/component/tasks/TaskConfigForm.vue';
import { projectConversationEndpoint } from '@/api/projects';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
const router = useRouter();
const route = useRoute();
const projectId = computed(() => route.params.projectId as string | undefined);
const lifecycle = useSessionLifecycle();
const draftId = computed(() =>
    typeof route.params.draftId === 'string' ? route.params.draftId : undefined,
);
const draftQuery = useQuery(
    computed(() => ({
        ...lifecycle.queryOptions(
            projectConversationEndpoint,
            {
                params: {
                    projectId: draftId.value
                        ? projectId.value!
                        : '00000000-0000-4000-8000-000000000000',
                },
            },
            ['projects', projectId.value, 'conversation'],
        ),
        enabled: Boolean(draftId.value && lifecycle.capture().accountId),
    })),
    lifecycle.queryClient,
);
const seedDraft = computed(() =>
    draftQuery.data.value?.data.drafts.find((draft) => draft.id === draftId.value && !draft.taskId),
);
function backToProject() {
    const scope = lifecycle.capture();
    void lifecycle.queryClient.invalidateQueries({
        queryKey: scope.queryKey(['projects', projectId.value, 'conversation']),
    });
    void router.replace({ name: 'project-detail', params: { projectId: projectId.value } });
}
function saved(result: TaskDetailResponse, runId?: string) {
    void router.replace(
        runId
            ? { name: 'run-detail', params: { runId } }
            : projectId.value
              ? { name: 'project-detail', params: { projectId: projectId.value } }
              : { name: 'task-summary', params: { taskId: result.task.id } },
    );
}
</script>
