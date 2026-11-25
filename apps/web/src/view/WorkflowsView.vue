<template>
    <div class="layout-grid gap-6">
        <form class="layout-grid gap-2 max-w-[32rem]" method="post" @submit.prevent="create">
            <label for="workflow-create-title">新工作流名称</label>
            <div class="flex flex-wrap items-start gap-2">
                <input
                    id="workflow-create-title"
                    v-model="title"
                    class="min-w-0 flex-1 basis-44 min-h-11 px-3 py-2 rounded-2 bg-surface text-default border border-solid border-[var(--scova-border)] keyboard-focus-wide"
                    name="title"
                    required
                    maxlength="160"
                    pattern=".*\S.*"
                    :disabled="creating"
                />
                <action-button type="primary" attr-type="submit" :busy="creating">
                    创建工作流
                </action-button>
            </div>
            <p v-if="creationError" class="m-0" role="alert">{{ creationError }}</p>
        </form>

        <div class="layout-grid gap-1">
            <label for="workflow-import">从 JSON 创建工作流</label>
            <input
                id="workflow-import"
                type="file"
                accept=".json,application/json"
                :disabled="creating"
                :aria-invalid="importError ? true : undefined"
                :aria-describedby="importError ? 'workflow-import-error' : undefined"
                @change="importWorkflow"
            />
            <p v-if="importError" id="workflow-import-error" class="m-0" role="alert">
                {{ importError }}
            </p>
        </div>

        <workflow-templates @copied="openWorkflow" @started="openRun" />

        <state-panel v-if="query.isPending.value" state="loading" message="正在读取工作流" />
        <state-panel
            v-else-if="query.isError.value && !items.length"
            state="error"
            :message="toApiError(query.error.value).message"
            retryable
            @retry="query.refetch()"
        />
        <state-panel v-else-if="!items.length" state="empty" message="暂无工作流" />
        <ul v-else class="layout-grid gap-2 list-none p-0 m-0">
            <li
                v-for="workflow in items"
                :key="workflow.id"
                class="surface-card p-4 break-anywhere"
            >
                <router-link
                    class="internal-link font-semibold"
                    :to="{ name: 'workflow-detail', params: { workflowId: workflow.id } }"
                    >{{ workflow.title }}</router-link
                >
            </li>
        </ul>
        <div v-if="query.hasNextPage.value">
            <action-button :busy="query.isFetchingNextPage.value" @click="query.fetchNextPage()">
                {{ query.isFetchNextPageError.value ? '重试加载' : '加载更多工作流' }}
            </action-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { parseContract, WorkflowDraftInputSchema } from '@scova/models';
import { RouterLink, useRouter } from 'vue-router';
import { createWorkflowEndpoint, workflowsEndpoint, type WorkflowDraft } from '@/api/workflows';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import ActionButton from '@/component/common/ActionButton.vue';
import WorkflowTemplates from '@/component/workflows/WorkflowTemplates.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { useWorkflowPages } from '@/composable/useWorkflowPages';
import { readWorkflowTextFile } from '@/utils/workflow/input-file';
import { serialGraph, upgradeWorkflowGraph } from '@/utils/workflow/serial';

const lifecycle = useSessionLifecycle();
const router = useRouter();
function openWorkflow(workflowId: string) {
    void lifecycle.queryClient.invalidateQueries({
        queryKey: lifecycle.capture().queryKey(listKey),
    });
    void router.push({ name: 'workflow-detail', params: { workflowId } });
}
function openRun(_workflowId: string, runId: string) {
    void router.push({ name: 'workflow-run-detail', params: { runId } });
}
const listKey = ['workflows', 'list'];
const title = ref('');
const creationError = ref('');
const importError = ref('');
const readingImport = ref(false);
const { query, items } = useWorkflowPages(lifecycle, listKey, (scope, query, signal) =>
    scope.request(workflowsEndpoint, { query }, { signal }),
);
const mutation = useSessionMutation(createWorkflowEndpoint, lifecycle);
const creating = computed(() => readingImport.value || mutation.isPending.value);

watch(
    () => lifecycle.session.epoch,
    () => {
        title.value = '';
        creationError.value = '';
        importError.value = '';
        readingImport.value = false;
        mutation.reset();
    },
);

async function create() {
    if (creating.value || !title.value.trim()) return;
    await saveNewWorkflow(
        {
            title: title.value.trim(),
            graph: upgradeWorkflowGraph(
                serialGraph({ id: 'start', type: 'start' }, [], { id: 'end', type: 'end' }),
            ),
        },
        creationError,
    );
}

async function importWorkflow(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    const file = field.files?.item(0);
    field.value = '';
    if (!file || creating.value) return;
    const scope = lifecycle.capture();
    readingImport.value = true;
    importError.value = '';
    try {
        const text = await readWorkflowTextFile(file, '工作流 JSON', 2 * 1024 * 1024);
        if (!scope.isCurrent() || router.currentRoute.value.name !== 'workflows') return;
        let draft: WorkflowDraft;
        try {
            draft = parseContract(WorkflowDraftInputSchema, JSON.parse(text));
        } catch {
            importError.value = '工作流 JSON 需要包含有效的 title 和 graph，请参考导出的草稿文件。';
            return;
        }
        await saveNewWorkflow(draft, importError);
    } catch (error) {
        if (scope.isCurrent() && error instanceof Error) importError.value = error.message;
    } finally {
        if (scope.isCurrent()) readingImport.value = false;
    }
}

async function saveNewWorkflow(body: WorkflowDraft, errorMessage: typeof creationError) {
    const scope = lifecycle.capture();
    errorMessage.value = '';
    try {
        const { data } = await mutation.mutateAsync({ input: { body } });
        if (!scope.isCurrent()) return;
        title.value = '';
        void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(listKey) });
        if (router.currentRoute.value.name === 'workflows')
            await router.push({
                name: 'workflow-detail',
                params: { workflowId: data.workflow.id },
            });
    } catch (error) {
        if (scope.isCurrent() && shouldReportQueryError(error))
            errorMessage.value = toApiError(error).message;
    }
}
</script>
