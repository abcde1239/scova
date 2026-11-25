<template>
    <section v-if="signedIn" class="min-w-0 text-default" aria-label="项目导航">
        <div class="grid gap-2 pb-3">
            <action-button
                v-if="activeProject && mayCreate"
                type="primary"
                :busy="create.isPending.value"
                @click="newThread"
            >
                <app-icon name="create" />新建会话
            </action-button>
            <router-link
                v-else
                class="sidebar-new"
                :to="{ name: 'projects' }"
                ariaCurrentValue="false"
                ><app-icon name="create" />选择项目以新建会话</router-link
            >
            <p v-if="failure" class="m-0 text-sm break-anywhere" role="alert">{{ failure }}</p>
            <input
                v-model="search"
                type="search"
                class="sidebar-search"
                placeholder="筛选项目"
                aria-label="筛选项目"
            />
        </div>
        <div class="flex items-center justify-between gap-2 px-2 py-1">
            <router-link
                :to="{ name: 'projects' }"
                class="internal-link rounded-2 keyboard-focus-inset text-sm font-semibold"
                >项目</router-link
            >
        </div>
        <p v-if="query.isPending.value" class="m-2 text-sm text-muted">正在读取项目…</p>
        <template v-else>
            <div v-if="query.isError.value" class="m-2 text-sm">
                <p class="m-0">项目读取失败</p>
                <action-button text @click="query.refetch()">重试</action-button>
            </div>
            <p v-else-if="!filtered.length" class="m-2 text-sm text-muted">
                {{ items.length ? '未找到匹配项目' : '还没有项目' }}
            </p>
            <project-sidebar-group
                v-for="project in filtered"
                :key="project.id"
                :project="project"
            />
            <action-button
                v-if="query.hasNextPage.value"
                quaternary
                :busy="query.isFetchingNextPage.value"
                @click="query.fetchNextPage()"
                >加载更多项目</action-button
            >
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toApiError } from '@/api/errors';
import { createThreadEndpoint } from '@/api/project-threads';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import ProjectSidebarGroup from '@/layout/ProjectSidebarGroup.vue';
import { invalidateProjectThreads } from '@/composable/useProjectThreads';
import { useProject, useProjects } from '@/composable/useProjects';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';

const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const signedIn = computed(() => !!lifecycle.session.user);
const { query, items } = useProjects(lifecycle);
const activeProject = computed(() =>
    typeof route.params.projectId === 'string' ? route.params.projectId : '',
);
const { detail } = useProject(activeProject, lifecycle);
const mayCreate = computed(
    () =>
        detail.value?.project.id === activeProject.value ||
        items.value.some(({ id }) => id === activeProject.value),
);
const search = ref('');
const failure = ref('');
const filtered = computed(() => {
    const projects = new Map(items.value.map((project) => [project.id, project]));
    if (detail.value) projects.set(detail.value.project.id, detail.value.project);
    const term = search.value.trim().toLocaleLowerCase();
    return [...projects.values()].filter(({ name }) => name.toLocaleLowerCase().includes(term));
});
const create = useSessionMutation(createThreadEndpoint, lifecycle);
watch([activeProject, () => lifecycle.session.epoch], () => {
    failure.value = '';
});
async function newThread() {
    const projectId = activeProject.value;
    const scope = lifecycle.capture();
    const path = route.fullPath;
    if (!projectId || !mayCreate.value || create.isPending.value) return;
    failure.value = '';
    try {
        const { data } = await create.mutateAsync({ input: { params: { projectId }, body: {} } });
        if (!scope.isCurrent()) return;
        void invalidateProjectThreads(lifecycle, projectId);
        if (route.fullPath === path)
            await router.push({ name: 'project-thread', params: { projectId, threadId: data.id } });
    } catch (error) {
        if (scope.isCurrent() && route.fullPath === path) failure.value = toApiError(error).message;
    }
}
</script>

<style scoped>
.sidebar-search {
    @apply box-border min-w-0 w-full min-h-10 rounded-2 px-3 text-sm bg-surface border-theme
        text-default keyboard-focus-inset;
}
.sidebar-new {
    @apply flex items-center gap-2 px-2 py-2 min-h-11 bg-surface border-theme rounded-2 text-sm
        text-default no-underline keyboard-focus-inset;
}
</style>
