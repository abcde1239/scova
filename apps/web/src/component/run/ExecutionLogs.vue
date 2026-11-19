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
import AppIcon from '@/component/common/AppIcon.vue';
import { stepLabels, type ExecutionLog, type ExecutionStep } from '@/utils/run/log';
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
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.job {
    @apply layout-grid [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_40%,_transparent)]
        rounded-3 overflow-hidden bg-surface;
}
.stages {
    @apply layout-grid [background:color-mix(in_srgb,_var(--scova-selected)_50%,_var(--scova-surface))]
        [align-content:start] gap-1 p-4;
}
.eyebrow {
    @apply mt-0 mr-0 mb-3 ml-0 pl-2 pr-2 text-muted text-[0.8125rem];
}
.stages button {
    @apply font-inherit flex items-center gap-2.5 w-full min-h-11 bg-transparent [border:0] rounded-1.5
        text-default text-start cursor-pointer p-2.5;
}
.stages button:hover {
    @apply [background:var(--scova-selected)];
}
.stages button[aria-pressed='true'] {
    @apply [background:var(--scova-selected)] [box-shadow:inset_0.1875rem_0_var(--scova-primary)];
}
.stages button > .stage-label {
    @apply flex-1 min-w-0 break-anywhere;
}
.stages small {
    @apply block text-muted text-[0.75rem] leading-[1.6];
}
.stages .failed > .app-icon {
    @apply text-danger;
}
.stages .warned:not(.failed) > .app-icon {
    @apply [color:var(--scova-partial)];
}
.console {
    @apply min-w-0 flex flex-col;
}
.log-heading {
    @apply action-row justify-between pt-4 pr-5 pb-4 pl-5
        [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)];
}
h2 {
    @apply text-[1rem] m-0;
}
.log-heading p {
    @apply mt-1 mr-0 mb-0 ml-0 text-muted text-[0.8125rem];
}
.log-controls {
    @apply flex flex-wrap gap-4 text-[0.8125rem];
}
.log-controls label {
    @apply inline-flex items-center gap-1.5 min-h-11 cursor-pointer;
}
input {
    @apply [accent-color:var(--scova-primary)];
}
.log-viewport {
    @apply h-[32rem] max-h-[65dvh] min-h-[12rem] overflow-auto [overscroll-behavior:contain]
        [scrollbar-gutter:stable] pt-3 pb-3
        [background:color-mix(in_srgb,_var(--scova-canvas)_55%,_var(--scova-surface))];
}
.log-lines {
    @apply list-none [font-family:ui-monospace,_SFMono-Regular,_Consolas,_monospace] text-[0.8125rem]
        leading-[1.8] m-0 p-0;
}
.log-lines li {
    @apply grid grid-cols-[2.5rem_4.5rem_minmax(0,_1fr)_auto] gap-3 pt-[0.3125rem] pr-4 pb-[0.3125rem]
        pl-2;
}
.log-lines li:hover {
    @apply [background:var(--scova-selected)];
}
.line-number,
time,
.line-duration {
    @apply text-muted [font-variant-numeric:tabular-nums];
}
.line-number {
    @apply text-end [user-select:none];
}
.line-message {
    @apply whitespace-pre-wrap break-anywhere;
}
.error {
    @apply [background:color-mix(in_srgb,_var(--scova-danger)_7%,_transparent)];
}
.error .line-message {
    @apply text-danger;
}
.warning {
    @apply [background:color-mix(in_srgb,_var(--scova-partial)_6%,_transparent)];
}
.warning .line-message {
    @apply [color:var(--scova-partial)];
}
.guidance {
    @apply font-inherit block text-muted;
}
.error-label {
    @apply text-[0.75rem] font-semibold mr-2;
}
code {
    @apply block [font-family:inherit] text-[0.75rem] [font-weight:inherit] [font-style:inherit]
        leading-[inherit] [font-variant:inherit] opacity-85;
}
.log-footer {
    @apply flex items-center gap-2 pt-3.5 pr-5 pb-3.5 pl-5 text-[0.8125rem] text-muted break-anywhere;
}
.connection-dot {
    @apply w-[0.4375rem] h-[0.4375rem] shrink-0 rounded-[50%] [background:var(--scova-muted)];
}
.connection-dot.active {
    @apply [background:var(--scova-primary)];
}
.log-note,
.log-empty {
    @apply pt-3 pr-5 pb-3 pl-5 text-[0.875rem] text-muted m-0;
}
button:focus-visible,
input:focus-visible,
.log-viewport:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:-0.125rem];
}
@media (min-width: 56rem) {
    .job {
        @apply grid-cols-[14rem_minmax(0,_1fr)];
    }
    .stages {
        @apply [border-right:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)];
    }
}
@media (max-width: 55.999rem) {
    .stages {
        @apply grid-cols-[repeat(auto-fit,_minmax(min(100%,_9rem),_1fr))];
    }
    .eyebrow {
        @apply col-span-full;
    }
    .stages button {
        @apply text-[0.8125rem];
    }
    .stages button > small {
        @apply hidden;
    }
}
@media (max-width: 34rem) {
    .log-lines li {
        @apply grid-cols-[1.5rem_minmax(0,_1fr)] gap-[0.25rem_0.625rem];
    }
    time {
        @apply [grid-column:2] text-[0.6875rem];
    }
    .line-number {
        @apply [grid-row:span_2];
    }
    .line-message {
        @apply [grid-column:2];
    }
    .line-duration {
        @apply [grid-column:2] text-[0.75rem];
    }
    .log-heading {
        @apply pl-4 pr-4;
    }
}
</style>
