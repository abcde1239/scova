<template>
    <section class="job" aria-labelledby="tools-title">
        <aside class="stages" aria-label="执行阶段">
            <p class="eyebrow">执行阶段</p>
            <button type="button" :aria-pressed="!selected" @click="selected = undefined">
                <app-icon name="tasks" /><span class="stage-label">全部日志</span
                ><small>{{ log.entries.length }}</small>
            </button>
            <button
                v-for="(label, step) in stepLabels"
                :key="step"
                type="button"
                :aria-pressed="selected === step"
                :class="{ failed: hasErrors(step), warned: log.steps[step]?.warnings }"
                @click="selected = step"
            >
                <app-icon :name="stageIcon(step)" />
                <span class="stage-label"
                    >{{ label }}<small>{{ stageText(step) }}</small></span
                >
                <small v-if="log.steps[step]?.durationMs">{{
                    duration(log.steps[step]!.durationMs)
                }}</small>
            </button>
        </aside>
        <div class="console">
            <header class="log-heading">
                <div>
                    <h2 id="tools-title">执行日志</h2>
                    <p>{{ selected ? stepLabels[selected] : '全部阶段' }} · 按事件时间更新</p>
                </div>
                <div class="log-controls">
                    <label><input v-model="errorsOnly" type="checkbox" />仅 warning / error</label>
                    <label><input v-model="follow" type="checkbox" />跟随最新</label>
                </div>
            </header>
            <p v-if="log.reset" class="log-note">
                历史游标已过期，已重新读取快照；这里只展示恢复后收到的日志。
            </p>
            <p v-if="log.omitted" class="log-note">
                仅保留最近 500 条日志，已有 {{ log.omitted }} 条较早日志移出视图。
            </p>
            <div
                ref="viewport"
                class="log-viewport"
                tabindex="0"
                role="region"
                aria-label="执行日志内容"
                @scroll="onScroll"
            >
                <ol v-if="visible.length" class="log-lines">
                    <li v-for="entry in visible" :key="entry.seq" :class="entry.level">
                        <span class="line-number" aria-label="事件序号">{{ entry.seq }}</span>
                        <time
                            :datetime="entry.at"
                            :title="new Date(entry.at).toLocaleString('zh-CN')"
                            >{{ timestamp(entry.at) }}</time
                        >
                        <span class="line-message"
                            ><span
                                v-if="entry.level === 'error' || entry.level === 'warning'"
                                class="error-label"
                                >{{
                                    entry.level === 'error' ? '错误 · error' : '警告 · warning'
                                }}</span
                            >{{ entry.text }}<code v-if="entry.code">{{ entry.code }}</code
                            ><small v-if="entry.guidance" class="guidance">{{
                                entry.guidance
                            }}</small></span
                        >
                        <span v-if="entry.durationMs !== undefined" class="line-duration">{{
                            duration(entry.durationMs)
                        }}</span>
                    </li>
                </ol>
                <p v-else class="log-empty">
                    {{
                        log.entries.length
                            ? '当前筛选下没有日志。'
                            : '暂无可用的执行日志，等待事件回放；当前执行状态与用量以快照为准。'
                    }}
                </p>
            </div>
            <footer class="log-footer">
                <span
                    class="connection-dot"
                    :class="{ active: !terminal }"
                    aria-hidden="true"
                ></span
                ><span role="status" aria-live="polite">{{ connectionText }}</span>
            </footer>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { stepLabels, type ExecutionLog, type ExecutionStep } from '@/utils/execution-log';
const props = defineProps<{ log: ExecutionLog; terminal: boolean; connectionText: string }>();
const selected = ref<ExecutionStep>();
const errorsOnly = ref(false);
const follow = ref(true);
const viewport = ref<HTMLElement>();
const visible = computed(() =>
    props.log.entries.filter(
        (entry) =>
            (!selected.value || entry.step === selected.value) &&
            (!errorsOnly.value || entry.level === 'error' || entry.level === 'warning'),
    ),
);
const duration = (ms: number) =>
    `${(ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}s`;
const timestamp = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
function stageIcon(step: ExecutionStep) {
    const stats = props.log.steps[step];
    if (stats?.failures) return 'warning';
    if (stats && stats.started > stats.completed) return props.terminal ? 'pause' : 'run';
    return stats?.completed ? 'confirm' : 'chevron';
}
function hasErrors(step: ExecutionStep) {
    const stats = props.log.steps[step];
    return !!stats && stats.failures > (stats.warnings ?? 0);
}
function stageText(step: ExecutionStep) {
    const stats = props.log.steps[step];
    if (!stats) return '未观察到记录';
    if (stats.failures)
        return `${stats.warnings ?? 0} 次警告 · ${stats.failures - (stats.warnings ?? 0)} 次错误`;
    if (stats.started > stats.completed) return props.terminal ? '未收到结束记录' : '进行中';
    return `节点已结束${stats.completed > 1 ? ` · ${stats.completed} 次` : ''}`;
}
function onScroll() {
    const element = viewport.value;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 48)
        follow.value = false;
}
watch([() => props.log.lastSeq, selected, errorsOnly, follow], async () => {
    if (!follow.value) return;
    await nextTick();
    const element = viewport.value;
    if (element) element.scrollTop = element.scrollHeight;
});
</script>

<style scoped>
.job {
    display: grid;
    min-inline-size: 0;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 40%, transparent);
    border-radius: 0.75rem;
    overflow: hidden;
    background: var(--scova-surface);
}
.stages {
    padding: 1rem;
    background: color-mix(in srgb, var(--scova-selected) 50%, var(--scova-surface));
    display: grid;
    align-content: start;
    gap: 0.25rem;
    min-inline-size: 0;
}
.eyebrow {
    margin: 0 0 0.75rem;
    padding-inline: 0.5rem;
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.stages button {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0.625rem;
    background: transparent;
    border: 0;
    border-radius: 0.375rem;
    color: var(--scova-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
}
.stages button:hover {
    background: var(--scova-selected);
}
.stages button[aria-pressed='true'] {
    background: var(--scova-selected);
    box-shadow: inset 0.1875rem 0 var(--scova-primary);
}
.stages button > .stage-label {
    flex: 1;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.stages small {
    display: block;
    color: var(--scova-muted);
    font-size: 0.75rem;
    line-height: 1.6;
}
.stages .failed > .app-icon {
    color: var(--scova-danger);
}
.stages .warned:not(.failed) > .app-icon {
    color: var(--scova-partial);
}
.console {
    min-inline-size: 0;
    display: flex;
    flex-direction: column;
}
.log-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    border-block-end: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
}
h2 {
    margin: 0;
    font-size: 1rem;
}
.log-heading p {
    margin: 0.25rem 0 0;
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.log-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.8125rem;
}
.log-controls label {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-block-size: 2.75rem;
    cursor: pointer;
}
input {
    accent-color: var(--scova-primary);
}
.log-viewport {
    block-size: 32rem;
    max-block-size: 65dvh;
    min-block-size: 12rem;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding-block: 0.75rem;
    background: color-mix(in srgb, var(--scova-canvas) 55%, var(--scova-surface));
}
.log-lines {
    list-style: none;
    padding: 0;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.8125rem;
    line-height: 1.8;
}
.log-lines li {
    display: grid;
    grid-template-columns: 2.5rem 4.5rem minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.3125rem 1rem 0.3125rem 0.5rem;
}
.log-lines li:hover {
    background: var(--scova-selected);
}
.line-number,
time,
.line-duration {
    color: var(--scova-muted);
    font-variant-numeric: tabular-nums;
}
.line-number {
    text-align: end;
    user-select: none;
}
.line-message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.error {
    background: color-mix(in srgb, var(--scova-danger) 7%, transparent);
}
.error .line-message {
    color: var(--scova-danger);
}
.warning {
    background: color-mix(in srgb, var(--scova-partial) 6%, transparent);
}
.warning .line-message {
    color: var(--scova-partial);
}
.guidance {
    display: block;
    font: inherit;
    color: var(--scova-muted);
}
.error-label {
    font-size: 0.75rem;
    font-weight: 600;
    margin-inline-end: 0.5rem;
}
code {
    display: block;
    font: inherit;
    font-size: 0.75rem;
    opacity: 0.85;
}
.log-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.875rem 1.25rem;
    font-size: 0.8125rem;
    color: var(--scova-muted);
    overflow-wrap: anywhere;
}
.connection-dot {
    inline-size: 0.4375rem;
    block-size: 0.4375rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--scova-muted);
}
.connection-dot.active {
    background: var(--scova-primary);
}
.log-note,
.log-empty {
    padding: 0.75rem 1.25rem;
    margin: 0;
    font-size: 0.875rem;
    color: var(--scova-muted);
}
button:focus-visible,
input:focus-visible,
.log-viewport:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: -0.125rem;
}
@media (min-width: 56rem) {
    .job {
        grid-template-columns: 14rem minmax(0, 1fr);
    }
    .stages {
        border-inline-end: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
    }
}
@media (max-width: 55.999rem) {
    .stages {
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
    }
    .eyebrow {
        grid-column: 1 / -1;
    }
    .stages button {
        font-size: 0.8125rem;
    }
    .stages button > small {
        display: none;
    }
}
@media (max-width: 34rem) {
    .log-lines li {
        grid-template-columns: 1.5rem minmax(0, 1fr);
        gap: 0.25rem 0.625rem;
    }
    time {
        grid-column: 2;
        font-size: 0.6875rem;
    }
    .line-number {
        grid-row: span 2;
    }
    .line-message {
        grid-column: 2;
    }
    .line-duration {
        grid-column: 2;
        font-size: 0.75rem;
    }
    .log-heading {
        padding-inline: 1rem;
    }
}
</style>
