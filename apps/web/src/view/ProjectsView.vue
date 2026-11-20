<template>
    <div class="layout-grid gap-6">
        <form class="layout-grid gap-2 max-w-[32rem]" method="post" @submit.prevent="create">
            <label for="project-name">新项目名称</label>
            <div class="flex flex-wrap items-start gap-2">
                <input
                    id="project-name"
                    v-model="name"
                    class="min-w-0 flex-1 basis-44 min-h-11 px-3 py-2 rounded-2 bg-surface text-default border border-solid border-[var(--scova-border)] keyboard-focus-wide"
                    name="name"
                    required
                    maxlength="120"
                />
                <action-button
                    type="primary"
                    attr-type="submit"
                    :busy="createProject.isPending.value"
                    :disabled="!name.trim()"
                    >创建项目</action-button
                >
            </div>
        </form>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取项目" />
        <state-panel
            v-else-if="query.isError.value && !items.length"
            state="error"
            :message="toApiError(query.error.value).message"
            retryable
            @retry="query.refetch()"
        />
        <state-panel v-else-if="!items.length" state="empty" icon="projects" message="暂无项目" />
        <ul v-else class="layout-grid gap-2 list-none p-0 m-0">
            <li
                v-for="project in items"
                :key="project.id"
                class="border-theme rounded-2 bg-surface p-4 break-anywhere"
            >
                <router-link
                    class="internal-link font-semibold"
                    :to="{ name: 'project-detail', params: { projectId: project.id } }"
                >
                    {{ project.name }}
                </router-link>
            </li>
        </ul>
        <div v-if="query.hasNextPage.value">
            <action-button :busy="query.isFetchingNextPage.value" @click="query.fetchNextPage()">
                {{ query.isFetchNextPageError.value ? '重试加载' : '加载更多项目' }}
            </action-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { createProjectEndpoint } from '@/api/projects';
import { toApiError } from '@/api/errors';
import { useProjects, invalidateProjects } from '@/composable/useProjects';
import { useActionNotification } from '@/composable/useActionNotification';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';

const lifecycle = useSessionLifecycle();
const router = useRouter();
const notice = useActionNotification();
const name = ref('');
const { query, items } = useProjects(lifecycle);
const createProject = useSessionMutation(createProjectEndpoint, lifecycle);

async function create(event: SubmitEvent) {
    const input = name.value.trim();
    if (!input || createProject.isPending.value) return;
    const form = event.currentTarget as HTMLFormElement;
    if (!form.reportValidity()) return;
    const scope = lifecycle.capture();
    try {
        const { data } = await createProject.mutateAsync({ input: { body: { name: input } } });
        if (!scope.isCurrent()) return;
        name.value = '';
        notice.success('已创建项目');
        await invalidateProjects(lifecycle, scope);
        if (scope.isCurrent() && router.currentRoute.value.name === 'projects')
            await router.push({ name: 'project-detail', params: { projectId: data.id } });
    } catch (error) {
        if (scope.isCurrent()) notice.error('创建项目失败', toApiError(error).message);
    }
}
</script>
