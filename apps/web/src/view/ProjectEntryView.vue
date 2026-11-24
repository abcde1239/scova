<template>
    <project-detail-view v-if="route.hash || query.isError.value" />
    <state-panel
        v-else-if="query.isPending.value || newest"
        state="loading"
        message="正在打开项目会话"
    />
    <section v-else class="grid gap-3 justify-items-start">
        <state-panel state="empty" message="此项目暂无活跃会话，可在侧栏新建会话。" />
        <router-link class="internal-link" :to="{ name: 'project-legacy', params: { projectId } }"
            >打开原项目页</router-link
        >
    </section>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatePanel from '@/component/common/StatePanel.vue';
import { useProjectThreads } from '@/composable/useProjectThreads';
import ProjectDetailView from '@/view/ProjectDetailView.vue';

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? ''));
const query = useProjectThreads(() => (route.hash ? undefined : projectId.value));
const newest = computed(() =>
    query.data.value?.data.items.find(
        (thread) => thread.projectId === projectId.value && !thread.archivedAt,
    ),
);
watch(
    [newest, () => query.isFetching.value, () => route.hash, () => route.name],
    ([thread, fetching, hash, name]) => {
        if (name !== 'project-detail' || !thread || fetching || hash || query.isError.value) return;
        void router.replace({
            name: 'project-thread',
            params: { projectId: thread.projectId, threadId: thread.id },
        });
    },
    { immediate: true },
);
</script>
