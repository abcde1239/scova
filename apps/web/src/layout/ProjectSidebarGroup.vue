<template>
    <div>
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center">
            <router-link
                class="project-row font-medium"
                :to="{ name: 'project-detail', params: { projectId: project.id } }"
                :title="project.name"
            >
                <app-icon name="projects" class="shrink-0" /><span class="truncate">{{
                    project.name
                }}</span>
            </router-link>
            <button
                type="button"
                class="project-row px-2"
                :aria-controls="listId"
                :aria-expanded="open"
                :aria-label="`${open ? '收起' : '展开'}${project.name}的会话`"
                @click="open = !open"
            >
                <app-icon :name="open ? 'expand' : 'chevron'" />
            </button>
        </div>
        <div v-show="open" :id="listId" class="pl-3">
            <p v-if="query.isPending.value" class="sidebar-caption">正在读取会话…</p>
            <div v-else-if="query.isError.value" class="sidebar-caption">
                <p class="m-0">会话读取失败</p>
                <action-button text @click="query.refetch()">重试</action-button>
            </div>
            <template v-else>
                <p v-if="!active.length" class="sidebar-caption">暂无活跃会话</p>
                <router-link
                    v-for="thread in active"
                    :key="thread.id"
                    class="project-row"
                    :to="destination(thread.id)"
                    :title="thread.title"
                >
                    <app-icon name="question" class="shrink-0" /><span class="truncate">{{
                        thread.title
                    }}</span>
                </router-link>
                <details v-if="archived.length" :open="containsArchivedCurrent || undefined">
                    <summary class="sidebar-caption cursor-pointer keyboard-focus-inset">
                        已归档（{{ archived.length }}）
                    </summary>
                    <router-link
                        v-for="thread in archived"
                        :key="thread.id"
                        class="project-row"
                        :to="destination(thread.id)"
                        :title="thread.title"
                    >
                        <app-icon name="archive" class="shrink-0" /><span class="truncate">{{
                            thread.title
                        }}</span>
                    </router-link>
                </details>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Project } from '@scova/models';
import { useProjectThreads } from '@/composable/useProjectThreads';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';

const props = defineProps<{ project: Project }>();
const route = useRoute();
const open = ref(route.params.projectId === props.project.id);
const listId = `project-threads-${useId()}`;
const query = useProjectThreads(() => (open.value ? props.project.id : undefined));
const active = computed(
    () => query.data.value?.data.items.filter(({ archivedAt }) => !archivedAt) ?? [],
);
const archived = computed(
    () => query.data.value?.data.items.filter(({ archivedAt }) => !!archivedAt) ?? [],
);
const containsArchivedCurrent = computed(() =>
    archived.value.some(({ id }) => route.params.threadId === id),
);
watch(
    () => route.params.projectId,
    (id) => {
        if (id === props.project.id) open.value = true;
    },
);
const destination = (threadId: string) => ({
    name: 'project-thread',
    params: { projectId: props.project.id, threadId },
});
</script>

<style scoped>
.project-row {
    @apply flex gap-2 items-center min-w-0 min-h-10 px-2 w-full bg-transparent text-default
        no-underline rounded-2 text-sm border-0 cursor-pointer keyboard-focus-inset;
}
.project-row:hover {
    @apply [background:var(--scova-selected)] text-primary;
}
.project-row.router-link-exact-active {
    @apply [background:var(--scova-selected)] text-primary font-semibold;
}
.sidebar-caption {
    @apply m-0 px-2 py-1.5 text-sm text-muted;
}
</style>
