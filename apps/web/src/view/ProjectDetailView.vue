<template>
    <state-panel v-if="query.isPending.value" state="loading" message="正在读取项目" />
    <state-panel
        v-else-if="query.isError.value && (!detail || hidden)"
        state="error"
        :message="toApiError(query.error.value).message"
        :retryable="!hidden"
        @retry="query.refetch()"
    />
    <div v-else-if="detail" class="layout-grid gap-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
            <h2 class="m-0 break-anywhere">{{ detail.project.name }}</h2>
            <action-button v-if="!confirmDelete" @click="confirmDelete = true"
                >删除项目</action-button
            >
            <div v-else class="layout-grid gap-2 border-theme rounded-2 p-3 bg-surface">
                <p class="m-0">删除后，项目中的任务将解除关联，报告和执行记录仍可访问。</p>
                <div class="flex flex-wrap gap-2">
                    <action-button
                        :busy="deleteProject.isPending.value"
                        class="danger-action"
                        @click="remove"
                        >确认删除项目</action-button
                    >
                    <action-button
                        :disabled="deleteProject.isPending.value"
                        @click="confirmDelete = false"
                        >返回</action-button
                    >
                </div>
            </div>
        </div>
        <section class="layout-grid gap-3" aria-labelledby="project-tasks">
            <h3 id="project-tasks" class="m-0">关联任务</h3>
            <form class="layout-grid gap-2 max-w-[36rem]" method="post" @submit.prevent="assign">
                <label for="project-task-select">选择要关联或移入的任务</label>
                <div class="flex flex-wrap items-start gap-2">
                    <select
                        id="project-task-select"
                        v-model="selected"
                        name="task"
                        class="report-select flex-1 basis-52"
                        required
                    >
                        <option value="">选择任务</option>
                        <option v-for="task in taskOptions" :key="task.id" :value="task.id">
                            {{ task.title }}
                        </option>
                    </select>
                    <action-button
                        type="primary"
                        attr-type="submit"
                        :busy="assignment.isPending.value"
                        :disabled="!selected || unlink.isPending.value"
                        >关联任务</action-button
                    >
                </div>
                <p v-if="options.query.isPending.value" class="m-0 text-muted" role="status">
                    正在读取任务选项
                </p>
                <state-panel
                    v-if="options.query.isError.value && !options.items.value.length"
                    state="error"
                    message="无法读取任务选项"
                    retryable
                    @retry="options.query.refetch()"
                />
                <action-button
                    v-if="options.query.hasNextPage.value"
                    :busy="options.query.isFetchingNextPage.value"
                    @click="options.query.fetchNextPage()"
                >
                    {{
                        options.query.isFetchNextPageError.value
                            ? '重试加载任务选项'
                            : '加载更多任务选项'
                    }}
                </action-button>
            </form>
            <p v-if="!tasks.length" class="m-0 text-muted">暂无关联任务</p>
            <ul v-else class="list-none layout-grid gap-2 p-0 m-0">
                <li
                    v-for="task in tasks"
                    :key="task.id"
                    class="flex flex-wrap items-center justify-between gap-3 border-theme rounded-2 p-3 bg-surface"
                >
                    <router-link
                        class="internal-link break-anywhere"
                        :to="{ name: 'task-summary', params: { taskId: task.id } }"
                        >{{ task.title }}</router-link
                    >
                    <action-button
                        :busy="pendingUnlink === task.id"
                        :disabled="
                            assignment.isPending.value ||
                            (!!pendingUnlink && pendingUnlink !== task.id)
                        "
                        @click="detach(task.id)"
                        >解除关联 <span class="sr-only">{{ task.title }}</span></action-button
                    >
                </li>
            </ul>
            <action-button
                v-if="query.hasNextPage.value"
                :busy="query.isFetchingNextPage.value"
                @click="query.fetchNextPage()"
            >
                {{ query.isFetchNextPageError.value ? '重试加载关联任务' : '加载更多关联任务' }}
            </action-button>
            <state-panel
                v-else-if="query.isError.value"
                state="error"
                message="项目暂时无法刷新"
                retryable
                @retry="query.refetch()"
            />
        </section>
        <project-recent-results :runs="detail.recentRuns" :reports="detail.recentReports" />
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import ProjectRecentResults from '@/component/projects/ProjectRecentResults.vue';
import { toApiError } from '@/api/errors';
import {
    assignProjectTaskEndpoint,
    deleteProjectEndpoint,
    unlinkProjectTaskEndpoint,
} from '@/api/projects';
import { invalidateProjects, useProject } from '@/composable/useProjects';
import { useTasks } from '@/composable/useTasks';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { useActionNotification } from '@/composable/useActionNotification';

const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const notice = useActionNotification();
const projectId = computed(() =>
    typeof route.params.projectId === 'string' ? route.params.projectId : '',
);
const { query, detail, tasks } = useProject(projectId, lifecycle);
const hidden = computed(() => [401, 403, 404].includes(toApiError(query.error.value).status ?? 0));
const options = useTasks('all', lifecycle, () => !!detail.value && !hidden.value);
const taskOptions = computed(() => {
    const linked = new Set(tasks.value.map((task) => task.id));
    return options.items.value.filter((task) => !linked.has(task.id));
});
const selected = ref('');
const pendingUnlink = ref('');
const confirmDelete = ref(false);
const assignment = useSessionMutation(assignProjectTaskEndpoint, lifecycle);
const unlink = useSessionMutation(unlinkProjectTaskEndpoint, lifecycle);
const deleteProject = useSessionMutation(deleteProjectEndpoint, lifecycle);

watch([projectId, () => lifecycle.session.epoch], () => {
    selected.value = '';
    confirmDelete.value = false;
});

async function assign() {
    const taskId = selected.value;
    if (!taskId || assignment.isPending.value || unlink.isPending.value) return;
    const scope = lifecycle.capture();
    const id = projectId.value;
    try {
        await assignment.mutateAsync({ input: { params: { projectId: id, taskId } } });
        if (!scope.isCurrent()) return;
        if (id === projectId.value) selected.value = '';
        notice.success('已关联任务');
        await invalidateProjects(lifecycle, scope);
    } catch (error) {
        if (scope.isCurrent()) notice.error('关联任务失败', toApiError(error).message);
    }
}

async function detach(taskId: string) {
    if (pendingUnlink.value || assignment.isPending.value) return;
    const scope = lifecycle.capture();
    pendingUnlink.value = taskId;
    try {
        await unlink.mutateAsync({ input: { params: { projectId: projectId.value, taskId } } });
        if (!scope.isCurrent()) return;
        notice.success('已解除任务关联');
        await invalidateProjects(lifecycle, scope);
    } catch (error) {
        if (scope.isCurrent()) notice.error('解除关联失败', toApiError(error).message);
    } finally {
        pendingUnlink.value = '';
    }
}

async function remove() {
    if (deleteProject.isPending.value) return;
    const scope = lifecycle.capture();
    const id = projectId.value;
    try {
        await deleteProject.mutateAsync({ input: { params: { projectId: id } } });
        if (!scope.isCurrent()) return;
        notice.success('已删除项目');
        if (id === projectId.value) await router.push({ name: 'projects' });
        await invalidateProjects(lifecycle, scope);
    } catch (error) {
        if (scope.isCurrent()) notice.error('删除项目失败', toApiError(error).message);
    }
}
</script>
