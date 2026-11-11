<template>
    <article v-if="run" class="execution-detail layout-stack pb-12">
        <section
            v-if="terminal"
            class="detail-section scova-surface report-grid [align-content:start] rounded-3 p-[clamp(1rem,_3%,_2rem)]"
            aria-labelledby="report-title"
        >
            <h2 class="text-[1.25rem] leading-[1.5] m-0" id="report-title">报告结果</h2>
            <router-link
                v-if="execution.reportId.value"
                class="scova-reference report-link keyboard-focus-wide [&&]:(inline-flex flex-wrap gap-2 items-center min-h-11 justify-self-start cursor-pointer)"
                :to="`/reports/${execution.reportId.value}`"
                >查看已发布报告<app-icon name="library"
            /></router-link>
            <template v-else-if="['succeeded', 'partial'].includes(run.status)">
                <p>
                    {{
                        execution.reports.isError.value
                            ? '报告入口暂时无法读取，请重试查找。'
                            : execution.reports.isPending.value
                              ? '正在查找已发布报告'
                              : '当前已读取记录中尚未找到此执行的报告。'
                    }}
                </p>
                <action-button
                    v-if="execution.reports.isError.value"
                    :busy="execution.reports.isFetching.value"
                    @click="execution.reports.refetch()"
                    >重试查找报告</action-button
                >
                <div v-else-if="execution.reports.hasNextPage.value" class="scova-pagination">
                    <action-button
                        :busy="execution.reports.isFetchingNextPage.value"
                        @click="execution.reports.fetchNextPage()"
                        >继续查找报告</action-button
                    >
                </div>
            </template>
            <p v-else>本次执行未完成报告交付。</p>
        </section>

        <section
            class="execution-overview scova-surface layout-grid [align-content:start] gap-2.5 rounded-3 break-anywhere p-[clamp(1rem,_3%,_2rem)]"
            aria-labelledby="execution-status"
        >
            <div class="status-heading flex flex-wrap items-center justify-between gap-4">
                <h2
                    class="text-[1.25rem] leading-[1.5] m-0 [.status-heading_&:is(h2)]:text-[1.75rem] [.status-heading_&:is(h2):focus-visible]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem])"
                    id="execution-status"
                    tabindex="-1"
                    :class="{
                        'scova-partial': run.status === 'partial',
                        'scova-failure': run.status === 'failed',
                    }"
                >
                    {{
                        run.coverage?.delivery && terminal
                            ? reportDeliveryLabels[run.coverage.delivery.status]
                            : executionStates[run.status][0]
                    }}
                </h2>
                <p class="mode text-primary font-semibold [.execution-overview_&:is(p)]:m-0">
                    {{ run.mode === 'demo' ? '演示模式 · Demo' : '真实查阅 · Live' }}
                </p>
            </div>
            <p class="[.execution-overview_&:is(p)]:m-0">{{ executionStates[run.status][1] }}</p>
            <p class="[.execution-overview_&:is(p)]:m-0" v-if="run.mode === 'demo'">
                此执行使用演示数据，不代表真实联网研究。
            </p>
            <p
                v-if="executionOutcome(run)"
                class="outcome text-[1.25rem] font-semibold [.execution-overview_&:is(p)]:m-0"
            >
                {{ executionOutcome(run) }}
            </p>
            <p class="[.execution-overview_&:is(p)]:m-0" v-if="executionFailure(run)">
                {{ executionFailure(run) }}
            </p>
            <p class="run-timing [.execution-overview_&:is(p)]:m-0">
                <time :datetime="run.startedAt ?? run.queuedAt">{{
                    time(run.startedAt ?? run.queuedAt)
                }}</time
                ><span v-if="elapsed"> · {{ elapsed }}</span>
            </p>
            <details class="execution-metadata">
                <summary
                    class="cursor-pointer min-h-11 [display:list-item] [align-content:center] text-muted text-[0.875rem]"
                >
                    执行标识与时间
                </summary>
                <dl
                    class="identity grid gap-4 grid-cols-[repeat(auto-fit,_minmax(min(100%,_19rem),_1fr))] pt-4 [border-top:0.0625rem_solid_var(--scova-border)] m-0"
                >
                    <div>
                        <dt class="text-muted">执行</dt>
                        <dd
                            class="mt-1 mb-0 mx-0 [.identity_&:is(dd)]:(text-[1rem] break-anywhere)"
                        >
                            {{ run.id }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-muted">固定任务版本</dt>
                        <dd
                            class="mt-1 mb-0 mx-0 [.identity_&:is(dd)]:(text-[1rem] break-anywhere)"
                        >
                            {{ run.taskVersionId }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-muted">排队时间</dt>
                        <dd
                            class="mt-1 mb-0 mx-0 [.identity_&:is(dd)]:(text-[1rem] break-anywhere)"
                        >
                            <time :datetime="run.queuedAt">{{ time(run.queuedAt) }}</time>
                        </dd>
                    </div>
                    <div v-if="run.startedAt">
                        <dt class="text-muted">开始时间</dt>
                        <dd
                            class="mt-1 mb-0 mx-0 [.identity_&:is(dd)]:(text-[1rem] break-anywhere)"
                        >
                            <time :datetime="run.startedAt">{{ time(run.startedAt) }}</time>
                        </dd>
                    </div>
                    <div v-if="run.finishedAt">
                        <dt class="text-muted">结束时间</dt>
                        <dd
                            class="mt-1 mb-0 mx-0 [.identity_&:is(dd)]:(text-[1rem] break-anywhere)"
                        >
                            <time :datetime="run.finishedAt">{{ time(run.finishedAt) }}</time>
                        </dd>
                    </div>
                </dl>
            </details>
        </section>

        <execution-logs
            :key="run.id"
            :log="execution.log.value"
            :terminal="terminal"
            :connection-text="connectionText"
        />

        <section
            class="connection scova-glass scova-glass--tools flex flex-wrap items-center justify-between gap-4 py-4 px-6"
            aria-label="执行连接"
        >
            <p
                class="[.connection_&:is(p)]:([flex:1_1_24rem] break-anywhere)"
                v-if="execution.query.isPaused.value"
            >
                快照更新已暂停，当前展示上次成功读取的状态；恢复网络后将继续更新。
            </p>
            <p
                class="[.connection_&:is(p)]:([flex:1_1_24rem] break-anywhere)"
                v-else-if="execution.query.isError.value"
            >
                快照更新暂不可用，当前展示上次成功读取的状态。
            </p>
            <action-button
                :busy="execution.query.isFetching.value"
                @click="execution.query.refetch()"
                ><app-icon name="retry" />刷新快照</action-button
            >
        </section>

        <div
            class="execution-columns layout-grid gap-6 [@media(min-width:_52rem)]:grid-cols-[minmax(0,_1.15fr)_minmax(0,_1fr)]"
        >
            <section
                class="detail-section scova-surface report-grid [align-content:start] rounded-3 p-[clamp(1rem,_3%,_2rem)]"
                aria-labelledby="coverage-title"
            >
                <h2 class="text-[1.25rem] leading-[1.5] m-0" id="coverage-title">覆盖与局限</h2>
                <template v-if="run.coverage">
                    <p :class="{ 'scova-partial': run.coverage.completeness === 'partial' }">
                        {{
                            run.coverage.completeness === 'partial'
                                ? '结果已生成（覆盖范围说明）'
                                : '已完成本次查阅范围'
                        }}
                    </p>
                    <p v-if="run.coverage.completeness === 'complete'">
                        范围完整不代表互联网穷尽，也不保证所有事实已经验证。
                    </p>
                    <ul v-if="run.coverage.gaps.length" class="coverage-gaps pl-5 grid gap-3 m-0">
                        <li v-for="(gap, index) in run.coverage.gaps" :key="index">{{ gap }}</li>
                    </ul>
                    <p v-else>
                        {{
                            run.coverage.completeness === 'partial'
                                ? '结果已整理当前查阅到的内容；未覆盖项目见查阅说明。'
                                : '当前快照未记录额外覆盖缺口。'
                        }}
                    </p>
                    <p v-if="run.coverage.exhausted.length" class="scova-partial">
                        已耗尽预算：{{
                            run.coverage.exhausted.map((key) => exhaustedLabels[key]).join('、')
                        }}
                    </p>
                    <p>已执行查询：{{ run.coverage.searchedQueries.length }} 项</p>
                    <p v-if="run.coverage.reportValue">
                        核心问题：
                        <span
                            v-for="question in run.coverage.reportValue.questions.filter(
                                (q) => q.priority === 'core',
                            )"
                            :key="question.id"
                        >
                            {{ question.text }} ·
                            {{
                                {
                                    supported: '已回答',
                                    provisional: '主要结论',
                                    disputed: '不同来源',
                                    unresolved: '暂无直接回答',
                                }[question.status]
                            }}；
                        </span>
                    </p>
                    <details v-if="run.coverage.notes?.length">
                        <summary
                            class="cursor-pointer min-h-11 [display:list-item] [align-content:center] text-muted text-[0.875rem]"
                        >
                            查阅说明
                        </summary>
                        <ul class="pl-5 grid gap-3 m-0">
                            <li v-for="(note, index) in run.coverage.notes" :key="index">
                                {{ note }}
                            </li>
                        </ul>
                    </details>
                </template>
                <p v-else>尚未形成覆盖结论；不能将等待、失败或取消视为没有变化。</p>
            </section>

            <section
                class="detail-section scova-surface report-grid [align-content:start] rounded-3 p-[clamp(1rem,_3%,_2rem)]"
                aria-labelledby="budget-title"
            >
                <h2 class="text-[1.25rem] leading-[1.5] m-0" id="budget-title">用量与预算</h2>
                <p>本次使用启动时的预算快照；修改任务后的新预算不会应用于此执行或其重试。</p>
                <p v-if="run.coverage?.research">
                    正文成功 {{ run.coverage.research.readSuccess }} /
                    {{ run.coverage.research.readAttempts }} 次， 筛选判断相关
                    {{ run.coverage.research.relatedPages }} 页， 保留结论
                    {{ run.coverage.research.acceptedClaims }} 条。 搜索缓存命中
                    {{ run.coverage.research.cacheHits }} 次。
                    相关性判断与请求成功均不代表研究已完整完成。
                    <span v-if="run.coverage.research.uncertainClaims"
                        >其中
                        {{ run.coverage.research.uncertainClaims }}
                        条需要补充材料，详情见报告引用。</span
                    >
                </p>
                <dl class="usage grid gap-4 m-0">
                    <div
                        class="[.usage_&:is(div)]:(flex flex-wrap gap-[0.5rem_1rem] justify-between)"
                    >
                        <dt class="text-muted">搜索调用</dt>
                        <dd class="mt-1 mb-0 mx-0 [.usage_&:is(dd)]:m-0">
                            {{ run.usage.searches }} / {{ run.budget.maxSearches }} 次
                        </dd>
                    </div>
                    <div
                        class="[.usage_&:is(div)]:(flex flex-wrap gap-[0.5rem_1rem] justify-between)"
                    >
                        <dt class="text-muted">网页读取</dt>
                        <dd class="mt-1 mb-0 mx-0 [.usage_&:is(dd)]:m-0">
                            {{ run.usage.pages }} / {{ run.budget.maxPages }} 次
                        </dd>
                    </div>
                    <div
                        class="[.usage_&:is(div)]:(flex flex-wrap gap-[0.5rem_1rem] justify-between)"
                    >
                        <dt class="text-muted">模型输入</dt>
                        <dd class="mt-1 mb-0 mx-0 [.usage_&:is(dd)]:m-0">
                            {{ run.usage.inputTokens }} / {{ run.budget.maxInputTokens }} token
                        </dd>
                    </div>
                    <div
                        class="[.usage_&:is(div)]:(flex flex-wrap gap-[0.5rem_1rem] justify-between)"
                    >
                        <dt class="text-muted">模型输出</dt>
                        <dd class="mt-1 mb-0 mx-0 [.usage_&:is(dd)]:m-0">
                            {{ run.usage.outputTokens }} / {{ run.budget.maxOutputTokens }} token
                        </dd>
                    </div>
                    <div
                        class="[.usage_&:is(div)]:(flex flex-wrap gap-[0.5rem_1rem] justify-between)"
                    >
                        <dt class="text-muted">总时间预算</dt>
                        <dd class="mt-1 mb-0 mx-0 [.usage_&:is(dd)]:m-0">
                            {{ run.budget.maxDurationSeconds }} 秒
                        </dd>
                    </div>
                </dl>
                <p>
                    用量包含重试与恢复。{{
                        run.usage.estimated ? '模型计量为保守估算。' : '当前快照未标记估算。'
                    }}
                </p>
            </section>
        </div>

        <details class="execution-actions pl-4 pr-4" open>
            <summary
                class="cursor-pointer min-h-11 [display:list-item] [align-content:center] text-muted text-[0.875rem]"
            >
                执行操作
            </summary>
            <run-actions :task-id="run.taskId" :run="run" />
        </details>
    </article>
</template>

<script setup lang="ts">
import { reportDeliveryLabels } from '@scova/models';
import { computed, onScopeDispose, shallowRef } from 'vue';
import { onlineManager } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import RunActions from '@/components/run/RunActions.vue';
import ExecutionLogs from '@/components/run/ExecutionLogs.vue';
import {
    executionStates,
    executionOutcome,
    executionFailure,
    type useExecution,
} from '@/composables/useExecution';
const props = defineProps<{ execution: ReturnType<typeof useExecution> }>();
// Use the same browser connectivity signal as Query. An existing SSE connection
// can retain its last open state while the browser pauses new network requests.
const online = shallowRef(onlineManager.isOnline());
onScopeDispose(onlineManager.subscribe((value) => (online.value = value)));
const run = computed(() => props.execution.run.value);
const terminal = computed(
    () => !!run.value && ['succeeded', 'partial', 'failed', 'canceled'].includes(run.value.status),
);
const elapsed = computed(() => {
    const current = run.value;
    if (!current?.startedAt || !current.finishedAt) return undefined;
    const seconds = Math.max(
        0,
        Math.round((Date.parse(current.finishedAt) - Date.parse(current.startedAt)) / 1000),
    );
    return `耗时 ${seconds >= 60 ? `${Math.floor(seconds / 60)}分 ` : ''}${seconds % 60}秒`;
});
const connectionText = computed(() => {
    if (!online.value) return '浏览器网络已断开，实时更新暂停；后台执行状态需恢复连接后确认。';
    if (props.execution.query.isPaused.value)
        return '快照更新已暂停；后台执行状态仍需读取快照确认。';
    const state = props.execution.subscription.value?.state.value;
    if (state === 'error') return '实时连接已停止，执行结果尚需读取快照确认。';
    if (state === 'reconnecting') return '实时连接中断，正在有限重连；后台执行不会因此判为失败。';
    if (state === 'complete') return '已读取终态快照，实时连接结束。';
    if (state === 'open') return '实时连接正常';
    if (state === 'closed') return '实时连接已关闭，可刷新快照确认执行状态。';
    return '正在连接执行事件';
});
const exhaustedLabels = {
    searches: '搜索',
    pages: '网页读取',
    time: '执行时间',
    input_tokens: '模型输入',
    output_tokens: '模型输出',
};
const time = (instant: string) => new Date(instant).toLocaleString('zh-CN', { hour12: false });
</script>
