<template>
    <section
        ref="section"
        class="run-history layout-grid gap-6 [border-top:0.0625rem_solid_var(--scova-border)] pt-8 [&.run-history_>_.scova-action-button]:justify-self-start"
        aria-labelledby="run-history-title"
    >
        <h2
            class="text-[1.25rem] leading-[1.6] m-0 keyboard-focus-wide"
            id="run-history-title"
            ref="title"
            tabindex="-1"
        >
            执行历史
        </h2>
        <p class="[.run-history_>_&:is(p)]:text-muted">
            排队时间按 {{ timezone }} 显示；每次执行保留其固定配置版本。
        </p>
        <state-panel v-if="query.isPending.value" state="loading" />
        <state-panel
            v-else-if="query.isError.value && !items.length"
            state="error"
            message="执行历史暂不可用，请检查权限或稍后重试"
            retryable
            @retry="retry"
        />
        <template v-else>
            <state-panel
                v-if="!items.length"
                state="empty"
                icon="run"
                message="此任务尚无执行记录"
            />
            <ol class="grid gap-6 list-none m-0 p-0" v-else>
                <li
                    v-for="run in items"
                    :key="run.id"
                    class="history-entry layout-grid gap-3 break-anywhere [.history-entry_+_&.history-entry]:([border-top:0.0625rem_solid_var(--scova-border)] pt-6)"
                >
                    <div class="flex flex-wrap items-center justify-between gap-x-6">
                        <router-link
                            class="title-link inline-flex items-center min-h-11"
                            :class="{
                                'scova-partial': run.status === 'partial',
                                'scova-failure': run.status === 'failed',
                            }"
                            :to="`/runs/${run.id}`"
                            >{{ executionTitle(run) }}</router-link
                        >
                        <router-link
                            class="navigation-link"
                            :aria-label="`查看${localTaskTime(run.queuedAt, timezone)}的执行`"
                            :to="`/runs/${run.id}`"
                            >查看<app-icon name="chevron"
                        /></router-link>
                    </div>
                    <p class="text-muted m-0">
                        <span>{{ run.mode === 'demo' ? '演示执行' : '任务执行' }}</span> ·
                        <time :datetime="run.queuedAt">{{
                            localTaskTime(run.queuedAt, timezone)
                        }}</time>
                        · <span>版本 {{ run.taskVersionId.slice(0, 8) }}</span>
                    </p>
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
import AppIcon from '@/components/common/AppIcon.vue';
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
