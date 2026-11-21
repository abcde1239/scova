<template>
    <section
        class="task-project layout-grid gap-3 min-w-0 rounded-3 border-theme p-4 bg-surface"
        aria-labelledby="task-project-heading"
    >
        <h2 id="task-project-heading" class="m-0">项目归类</h2>
        <p v-if="membership.isPending.value" role="status" class="m-0">正在读取项目归类</p>
        <div v-else-if="membership.isError.value" class="flex flex-wrap gap-2 items-center">
            <p role="alert" class="m-0">无法读取项目归类。</p>
            <action-button :busy="membership.isFetching.value" @click="membership.refetch()"
                >重新读取</action-button
            >
        </div>
        <template v-else>
            <p class="m-0">
                <router-link
                    v-if="project"
                    class="internal-link"
                    :to="{ name: 'project-detail', params: { projectId: project.id } }"
                    >{{ project.name }}</router-link
                >
                <span
                    v-else
                    class="inline-flex px-2 py-0.5 rounded-2 text-sm [background:var(--scova-selected)]"
                    >未归类</span
                >
            </p>
            <div class="flex flex-wrap gap-2">
                <action-button
                    type="primary"
                    :busy="command.pending.value"
                    @click="continueResearch"
                    >继续对话研究</action-button
                >
                <action-button :disabled="command.pending.value" @click="showPicker">
                    {{ project ? '更改项目归类' : '归入项目' }}
                </action-button>
            </div>
            <div
                v-if="picker"
                class="layout-grid gap-3 p-3 border-theme rounded-3 bg-surface max-w-[40rem] min-w-0"
            >
                <h3 ref="pickerHeading" tabindex="-1" class="m-0">
                    {{ forConversation ? '选择对话所属的项目' : '选择项目' }}
                </h3>
                <p v-if="forConversation" class="m-0">选择已有项目或新建项目，即可继续对话研究。</p>
                <p v-if="projects.query.isPending.value" role="status" class="m-0">正在读取项目</p>
                <p v-else-if="!projectOptions.length && !projects.query.isError.value" class="m-0">
                    暂无其他项目。
                </p>
                <form
                    v-if="projectOptions.length"
                    class="layout-grid gap-2"
                    method="post"
                    aria-label="归入已有项目"
                    @submit.prevent="assign"
                >
                    <label for="task-project-select">已有项目</label>
                    <select
                        id="task-project-select"
                        v-model="selected"
                        class="report-select w-full"
                        name="projectId"
                        required
                        :disabled="command.pending.value"
                    >
                        <option value="">选择已有项目</option>
                        <option
                            v-for="option in projectOptions"
                            :key="option.id"
                            :value="option.id"
                        >
                            {{ option.name }}
                        </option>
                    </select>
                    <action-button attr-type="submit" :busy="command.pending.value">
                        {{ forConversation ? '归类并继续对话' : '确认归类' }}
                    </action-button>
                </form>
                <action-button
                    v-if="projects.query.isError.value || projects.query.hasNextPage.value"
                    :busy="projects.query.isFetching.value"
                    :disabled="command.pending.value"
                    @click="loadProjects"
                    >{{
                        projects.query.isError.value ? '重试读取项目' : '加载更多项目'
                    }}</action-button
                >
                <form
                    v-if="!project"
                    class="layout-grid gap-2"
                    method="post"
                    aria-label="新建项目并归类"
                    @submit.prevent="create"
                >
                    <label for="task-new-project-name">新项目名称</label>
                    <input
                        id="task-new-project-name"
                        v-model="name"
                        type="text"
                        class="report-select w-full"
                        name="name"
                        maxlength="120"
                        required
                        :disabled="command.pending.value"
                    />
                    <action-button attr-type="submit" :busy="command.pending.value">
                        {{ forConversation ? '新建项目并继续对话' : '新建项目并归类' }}
                    </action-button>
                </form>
                <div class="flex flex-wrap gap-2">
                    <action-button v-if="project" :busy="command.pending.value" @click="unlink"
                        >取消归类</action-button
                    >
                    <action-button :disabled="command.pending.value" @click="closePicker"
                        >关闭</action-button
                    >
                </div>
            </div>
        </template>
        <p v-if="error" role="alert" class="m-0">{{ error }}</p>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import ActionButton from '@/component/common/ActionButton.vue';
import {
    assignProjectTaskEndpoint,
    createTaskProjectEndpoint,
    taskProjectEndpoint,
    unlinkProjectTaskEndpoint,
} from '@/api/projects';
import { toApiError } from '@/api/errors';
import { invalidateProjects, useProjects } from '@/composable/useProjects';
import { useSessionLifecycle, useSessionQuery } from '@/composable/useSessionQuery';
import { useCommand } from '@/composable/useCommand';

const { taskId } = defineProps<{ taskId: string }>();
const params = { taskId };
const router = useRouter();
const lifecycle = useSessionLifecycle();
const scope = lifecycle.capture();
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());
const options = { signal: controller.signal };
const isCurrent = () => scope.isCurrent() && !controller.signal.aborted;
const membership = useSessionQuery(taskProjectEndpoint, { params }, ['projects', 'task', taskId]);
const project = computed(() => membership.data.value?.data.project);
const picker = ref(false);
const forConversation = ref(false);
const pickerHeading = ref<HTMLElement>();
const selected = ref('');
const name = ref('');
const error = ref('');
const command = useCommand();
let pickerTrigger: HTMLElement | undefined;
const projects = useProjects(lifecycle, picker);
const projectOptions = computed(() =>
    projects.items.value.filter((option) => option.id !== project.value?.id),
);

function openPicker(continueToConversation: boolean, trigger: EventTarget | null) {
    pickerTrigger = trigger instanceof HTMLElement ? trigger : undefined;
    forConversation.value = continueToConversation;
    picker.value = true;
    error.value = '';
    void nextTick(() => pickerHeading.value?.focus());
}
function showPicker(event: MouseEvent) {
    openPicker(false, event.currentTarget);
}
function closePicker() {
    picker.value = false;
    void nextTick(() => pickerTrigger?.focus());
}
function openConversation(projectId: string) {
    return router.push({
        name: 'project-detail',
        params: { projectId },
        hash: '#project-conversation-heading',
    });
}
async function continueResearch(event: MouseEvent) {
    const trigger = event.currentTarget;
    await command.run(async () => {
        error.value = '';
        const result = await membership.refetch();
        if (!isCurrent() || result.isError) return;
        if (result.data?.data.project) await openConversation(result.data.data.project.id);
        else openPicker(true, trigger);
    });
}
function loadProjects() {
    if (projects.query.isFetchNextPageError.value || !projects.query.isError.value)
        return projects.query.fetchNextPage();
    return projects.query.refetch();
}
async function changeProject(write: () => Promise<string | undefined>) {
    await command.run(async () => {
        error.value = '';
        try {
            const id = await write();
            if (!isCurrent()) return;
            await invalidateProjects(lifecycle, scope);
            if (!isCurrent()) return;
            selected.value = '';
            name.value = '';
            if (id && forConversation.value) {
                picker.value = false;
                await openConversation(id);
            } else closePicker();
        } catch (cause) {
            if (!isCurrent()) return;
            error.value = toApiError(cause).message;
            await invalidateProjects(lifecycle, scope);
        }
    });
}
function assign() {
    const projectId = selected.value;
    if (!projectId) return;
    return changeProject(async () => {
        await scope.request(assignProjectTaskEndpoint, { params: { taskId, projectId } }, options);
        return projectId;
    });
}
function create() {
    const value = name.value.trim();
    if (!value) {
        error.value = '请输入项目名称。';
        return;
    }
    return changeProject(async () => {
        const result = await scope.request(
            createTaskProjectEndpoint,
            { params, body: { name: value } },
            options,
        );
        return result.data.id;
    });
}
function unlink() {
    const projectId = project.value?.id;
    if (!projectId) return;
    return changeProject(async () => {
        await scope.request(unlinkProjectTaskEndpoint, { params: { taskId, projectId } }, options);
        return undefined;
    });
}
</script>
