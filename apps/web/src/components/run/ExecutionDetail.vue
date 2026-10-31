<template>
    <article v-if="run" class="execution-detail">
        <section class="execution-overview scova-surface" aria-labelledby="execution-status">
            <div class="status-heading">
                <h2
                    id="execution-status"
                    tabindex="-1"
                    :class="{
                        'scova-partial': run.status === 'partial',
                        'scova-failure': run.status === 'failed',
                    }"
                >
                    {{ executionStates[run.status][0] }}
                </h2>
                <p class="mode">
                    {{ run.mode === 'demo' ? '演示模式 · Demo' : '真实查阅 · Live' }}
                </p>
            </div>
            <p>{{ executionStates[run.status][1] }}</p>
            <p v-if="run.mode === 'demo'">此执行使用演示数据，不代表真实联网研究。</p>
            <p v-if="executionOutcome(run)" class="outcome">{{ executionOutcome(run) }}</p>
            <p v-if="executionFailure(run)">{{ executionFailure(run) }}</p>
            <dl class="identity">
                <div>
                    <dt>执行</dt>
                    <dd>{{ run.id }}</dd>
                </div>
                <div>
                    <dt>固定任务版本</dt>
                    <dd>{{ run.taskVersionId }}</dd>
                </div>
                <div>
                    <dt>排队时间</dt>
                    <dd>
                        <time :datetime="run.queuedAt">{{ time(run.queuedAt) }}</time>
                    </dd>
                </div>
                <div v-if="run.startedAt">
                    <dt>开始时间</dt>
                    <dd>
                        <time :datetime="run.startedAt">{{ time(run.startedAt) }}</time>
                    </dd>
                </div>
                <div v-if="run.finishedAt">
                    <dt>结束时间</dt>
                    <dd>
                        <time :datetime="run.finishedAt">{{ time(run.finishedAt) }}</time>
                    </dd>
                </div>
            </dl>
        </section>

        <run-actions :task-id="run.taskId" :run="run" />

        <section class="connection scova-glass scova-glass--tools" aria-label="执行连接">
            <p role="status" aria-live="polite">{{ connectionText }}</p>
            <p v-if="execution.query.isError.value">
                快照更新暂不可用，当前展示上次成功读取的状态。
            </p>
            <action-button
                :busy="execution.query.isFetching.value"
                @click="execution.query.refetch()"
                ><app-icon name="retry" />刷新快照</action-button
            >
        </section>

        <div class="execution-columns">
            <section class="detail-section scova-surface" aria-labelledby="coverage-title">
                <h2 id="coverage-title">覆盖与局限</h2>
                <template v-if="run.coverage">
                    <p :class="{ 'scova-partial': run.coverage.completeness === 'partial' }">
                        {{
                            run.coverage.completeness === 'partial'
                                ? '查阅不完整'
                                : '已完成本次查阅范围'
                        }}
                    </p>
                    <p v-if="run.coverage.completeness === 'complete'">
                        范围完整不代表互联网穷尽，也不保证所有事实已经验证。
                    </p>
                    <ul v-if="run.coverage.gaps.length" class="coverage-gaps">
                        <li v-for="(gap, index) in run.coverage.gaps" :key="index">{{ gap }}</li>
                    </ul>
                    <p v-else>
                        {{
                            run.coverage.completeness === 'partial'
                                ? '尚未取得具体缺口说明，结论仍不完整。'
                                : '当前快照未记录额外覆盖缺口。'
                        }}
                    </p>
                    <p v-if="run.coverage.exhausted.length" class="scova-partial">
                        已耗尽预算：{{
                            run.coverage.exhausted.map((key) => exhaustedLabels[key]).join('、')
                        }}
                    </p>
                    <p>已执行查询：{{ run.coverage.searchedQueries.length }} 项</p>
                </template>
                <p v-else>尚未形成覆盖结论；不能将等待、失败或取消视为没有变化。</p>
            </section>

            <section class="detail-section scova-surface" aria-labelledby="budget-title">
                <h2 id="budget-title">用量与预算</h2>
                <dl class="usage">
                    <div>
                        <dt>搜索调用</dt>
                        <dd>{{ run.usage.searches }} / {{ run.budget.maxSearches }} 次</dd>
                    </div>
                    <div>
                        <dt>网页读取</dt>
                        <dd>{{ run.usage.pages }} / {{ run.budget.maxPages }} 次</dd>
                    </div>
                    <div>
                        <dt>模型输入</dt>
                        <dd>{{ run.usage.inputTokens }} / {{ run.budget.maxInputTokens }} token</dd>
                    </div>
                    <div>
                        <dt>模型输出</dt>
                        <dd>
                            {{ run.usage.outputTokens }} / {{ run.budget.maxOutputTokens }} token
                        </dd>
                    </div>
                    <div>
                        <dt>总时间预算</dt>
                        <dd>{{ run.budget.maxDurationSeconds }} 秒</dd>
                    </div>
                </dl>
                <p>
                    用量包含重试与恢复。{{
                        run.usage.estimated ? '模型计量为保守估算。' : '当前快照未标记估算。'
                    }}
                </p>
            </section>
        </div>

        <section class="detail-section scova-surface" aria-labelledby="tools-title">
            <h2 id="tools-title">工具活动</h2>
            <ul v-if="execution.tools.value.length" class="tools-list">
                <li v-for="tool in execution.tools.value" :key="tool.id">
                    <strong>{{ toolLabels[tool.tool] }}</strong>
                    <p>
                        {{
                            tool.status === 'completed'
                                ? '调用已完成'
                                : tool.status === 'failed'
                                  ? '本次调用失败；执行结果仍以快照为准'
                                  : terminal
                                    ? '已观察到调用开始，未取得结束记录'
                                    : '调用中'
                        }}
                    </p>
                    <p v-if="tool.durationMs !== undefined">
                        耗时
                        {{
                            (tool.durationMs / 1000).toLocaleString('zh-CN', {
                                maximumFractionDigits: 2,
                            })
                        }}
                        秒
                    </p>
                </li>
            </ul>
            <p v-else>暂无可用的工具活动记录，当前执行状态与用量以上方快照为准。</p>
        </section>

        <section
            v-if="terminal"
            class="detail-section scova-surface"
            aria-labelledby="report-title"
        >
            <h2 id="report-title">交付报告</h2>
            <router-link
                v-if="execution.reportId.value"
                class="scova-reference report-link"
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
                <action-button
                    v-else-if="execution.reports.hasNextPage.value"
                    :busy="execution.reports.isFetchingNextPage.value"
                    @click="execution.reports.fetchNextPage()"
                    >继续查找报告</action-button
                >
            </template>
            <p v-else>本次执行未完成报告交付。</p>
        </section>
    </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import RunActions from '@/components/run/RunActions.vue';
import {
    executionStates,
    executionOutcome,
    executionFailure,
    type useExecution,
} from '@/composables/useExecution';
import '@/theme/glass.css';
const props = defineProps<{ execution: ReturnType<typeof useExecution> }>();
const run = computed(() => props.execution.run.value);
const terminal = computed(
    () => !!run.value && ['succeeded', 'partial', 'failed', 'canceled'].includes(run.value.status),
);
const connectionText = computed(() => {
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
const toolLabels = { search: '搜索来源', read: '读取网页', model: '模型处理' };
const time = (instant: string) => new Date(instant).toLocaleString('zh-CN', { hour12: false });
</script>

<style scoped>
.execution-detail {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    padding-block-end: 3rem;
}
.execution-overview,
.detail-section {
    display: grid;
    align-content: start;
    gap: 1.25rem;
    padding: clamp(1rem, 3%, 2rem);
    border-radius: 0.75rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.execution-overview {
    gap: 1rem;
}
.status-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}
h2 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.5;
}
.status-heading h2 {
    font-size: 1.75rem;
}
.status-heading h2:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.mode {
    color: var(--scova-primary);
    font-weight: 600;
}
.outcome {
    font-size: 1.25rem;
    font-weight: 600;
}
dl {
    margin: 0;
    display: grid;
    gap: 1rem;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0.25rem 0 0;
}
.identity {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
    padding-block-start: 1rem;
    border-top: 0.0625rem solid var(--scova-border);
}
.identity dd {
    font-size: 1rem;
    overflow-wrap: anywhere;
}
.connection {
    padding: 1rem 1.5rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}
.connection p {
    flex: 1 1 24rem;
    overflow-wrap: anywhere;
}
.execution-columns {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
}
.usage div {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    justify-content: space-between;
}
.usage dd {
    margin: 0;
}
ul {
    margin: 0;
    padding-inline-start: 1.25rem;
    display: grid;
    gap: 0.75rem;
}
.tools-list {
    list-style: none;
    padding: 0;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 1.5rem;
}
.report-link {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    min-block-size: 2.75rem;
    justify-self: start;
    cursor: pointer;
}
.report-link:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
@media (min-width: 52rem) {
    .execution-columns {
        grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    }
}
</style>
