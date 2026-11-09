<template>
    <section ref="section" class="run-history" aria-labelledby="run-history-title">
        <h2 id="run-history-title" ref="title" tabindex="-1">执行历史</h2>
        <p>排队时间按 {{ timezone }} 显示；每次执行保留其固定配置版本。</p>
        <state-panel v-if="query.isPending.value" state="loading" />
        <state-panel
            v-else-if="query.isError.value && !items.length"
            state="error"
            message="执行历史暂不可用，请检查权限或稍后重试"
            retryable
            @retry="retry"
        />
        <template v-else>
            <state-panel v-if="!items.length" state="empty" message="此任务尚无执行记录" />
            <ol v-else>
                <li v-for="run in items" :key="run.id" class="history-entry">
                    <router-link :to="`/runs/${run.id}`"
                        >{{ executionTitle(run) }} · 查看执行</router-link
                    >
                    <p>{{ run.mode === 'demo' ? '演示模式 · Demo' : '真实查阅 · Live' }}</p>
                    <p>
                        排队于
                        <time :datetime="run.queuedAt">{{
                            localTaskTime(run.queuedAt, timezone)
                        }}</time>
                    </p>
                    <p>固定配置版本：{{ run.taskVersionId }}</p>
                </li>
            </ol>
            <state-panel
                v-if="query.isFetchNextPageError.value"
                state="error"
                message="后续执行记录读取失败"
                retryable
                @retry="more"
            />
            <state-panel
                v-else-if="query.isRefetchError.value"
                state="error"
                message="历史刷新失败，当前显示上次成功读取的记录"
                retryable
                @retry="retry"
            />
            <div v-if="query.hasNextPage.value" class="scova-pagination">
                <action-button :busy="query.isFetchingNextPage.value" @click="more">
                    {{ query.isFetchingNextPage.value ? '正在加载历史' : '加载更早的执行' }}
                </action-button>
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useTaskRunHistory } from '@/composables/useTaskRunHistory';
import { executionTitle } from '@/composables/useExecution';
import { localTaskTime } from '@/composables/useTasks';
import ActionButton from '@/components/common/ActionButton.vue';
import StatePanel from '@/components/common/StatePanel.vue';
const props = defineProps<{ taskId: string }>();
const { query, items } = useTaskRunHistory(() => props.taskId);
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const title = ref<HTMLElement>();
const section = ref<HTMLElement>();
async function restore(operation: () => Promise<unknown>, always: boolean) {
    const target = props.taskId;
    const active = section.value?.contains(document.activeElement);
    await operation();
    await nextTick();
    if (active && target === props.taskId && (always || !query.hasNextPage.value))
        title.value?.focus();
}
const retry = () => restore(() => query.refetch(), true);
const more = () => restore(() => query.fetchNextPage(), false);
</script>

<style scoped>
.run-history {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 2rem;
}
h2 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.6;
}
ol {
    display: grid;
    gap: 1.5rem;
    padding: 0;
    margin: 0;
    list-style: none;
}
.history-entry {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.history-entry + .history-entry {
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 1.5rem;
}
.run-history > p {
    color: var(--scova-muted);
}
a {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a:focus-visible,
h2:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.run-history > :deep(.scova-action-button) {
    justify-self: start;
}
</style>
