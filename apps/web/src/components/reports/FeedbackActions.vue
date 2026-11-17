<template>
    <section
        class="feedback-actions scova-interface layout-stack break-anywhere [border-top:0.0625rem_solid_var(--scova-border)] pt-8 pb-8"
        aria-labelledby="feedback-title"
    >
        <h2 class="flex items-center gap-2 text-[1.25rem] m-0" id="feedback-title">
            <app-icon name="settings" />调整后续研究
        </h2>
        <p class="m-0">
            反馈仅供后续新执行捕获；不追溯在途执行或历史报告，也不修改配置版本与比较基线。
        </p>
        <div class="feedback-selector layout-stack break-anywhere">
            <label for="feedback-target">选择反馈资料或结论</label>
            <select
                class="w-full min-w-0 max-w-full min-h-11 border-theme rounded-2 bg-surface text-default font-inherit cursor-pointer p-2.5 keyboard-focus-wide disabled:cursor-not-allowed"
                id="feedback-target"
                v-model="selection"
                :disabled="pending || needsRecheck"
            >
                <option value="">请选择一个目标</option>
                <optgroup label="本报告资料">
                    <option v-for="item in sources" :key="targetKey(item)" :value="targetKey(item)">
                        {{ item.label }}
                    </option>
                </optgroup>
                <optgroup label="本报告结论">
                    <option v-for="item in claims" :key="targetKey(item)" :value="targetKey(item)">
                        {{ item.label }}
                    </option>
                </optgroup>
            </select>
        </div>
        <div v-if="selected" class="selected-target layout-stack break-anywhere">
            <h3 class="text-[1.125rem] m-0">
                {{ selected.type === 'source' ? '所选资料' : '所选结论' }}
            </h3>
            <p class="m-0">{{ selected.label }}</p>
            <p class="target-id text-muted m-0">目标标识：{{ selected.id }}</p>
            <p class="m-0">
                当前反馈：{{
                    !itemsKnown ? '尚未读取确认' : current ? feedbackLabels[current.kind] : '未设置'
                }}
            </p>
            <div class="feedback-buttons action-group" aria-label="设置所选目标反馈">
                <action-button
                    v-for="action in feedbackKinds"
                    :key="action.kind"
                    :disabled="!canWrite || current?.kind === action.kind"
                    :busy="pending"
                    @click="write(action.kind)"
                >
                    <app-icon :name="action.icon" />{{ action.label }}
                </action-button>
                <action-button
                    v-if="current"
                    :disabled="!canWrite"
                    :busy="pending"
                    @click="write(null, current)"
                >
                    <app-icon name="back" />撤销所选反馈
                </action-button>
            </div>
        </div>
        <p class="m-0" v-if="query.isPending.value" role="status">正在读取当前生效反馈。</p>
        <p class="m-0" v-else-if="query.isError.value" role="alert">{{ readError }}</p>
        <p class="m-0" v-if="query.isError.value && itemsKnown">
            以下保留上次读取值，尚未确认当前状态。
        </p>
        <p class="m-0" v-if="pending" role="status">正在提交反馈，请稍候。</p>
        <p v-if="needsRecheck" class="scova-warning m-0">
            请重新读取并核对当前生效项，再继续操作。
        </p>
        <action-button :disabled="pending || query.isFetching.value" @click="reload">
            <app-icon name="retry" />重新读取反馈
        </action-button>
        <details class="active-feedback border-theme rounded-2 min-w-0">
            <summary class="cursor-pointer py-3.5 px-4 keyboard-focus-wide">
                当前任务生效反馈（{{ itemsKnown ? `${items.length} / 200` : '尚未读取确认' }}）
            </summary>
            <div class="active-feedback-body layout-stack break-anywhere pt-0 pb-4 px-4">
                <p class="m-0">这里列出任务当前设置，不表示这份报告已经使用这些反馈。</p>
                <p class="m-0" v-if="query.isSuccess.value && !items.length">当前没有生效反馈。</p>
                <ul class="list-none m-0 p-0" v-if="items.length">
                    <li
                        class="flex flex-wrap items-start gap-4 pt-4 pb-4 [border-top:0.0625rem_solid_var(--scova-border)]"
                        v-for="item in items"
                        :key="item.id"
                    >
                        <div class="active-feedback-label [flex:1_1_18rem] min-w-0">
                            <p class="m-0">
                                {{ item.sourceId ? '资料' : '结论' }}：{{ describe(item) }}
                            </p>
                            <p class="m-0">{{ feedbackLabels[item.kind] }}</p>
                        </div>
                        <action-button
                            :disabled="!canWrite"
                            :busy="pending"
                            @click="write(null, item)"
                        >
                            <app-icon name="back" />撤销此项
                        </action-button>
                    </li>
                </ul>
            </div>
        </details>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Feedback, Report } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useActionNotification } from '@/composables/useActionNotification';
import {
    feedbackKinds,
    feedbackLabels,
    reportFeedbackTargets,
    targetKey,
    useFeedback,
} from '@/composables/useFeedback';
const props = defineProps<{ report: Report }>();
const targets = computed(() => reportFeedbackTargets(props.report));
const sources = computed(() => targets.value.filter((item) => item.type === 'source'));
const claims = computed(() => targets.value.filter((item) => item.type === 'claim'));
const selection = ref('');
const selected = computed(() => targets.value.find((item) => targetKey(item) === selection.value));
watch(
    () => props.report.id,
    () => {
        selection.value = '';
    },
);
const {
    query,
    items,
    itemsKnown,
    current,
    canWrite,
    pending,
    needsRecheck,
    notice,
    readError,
    reload,
    write,
} = useFeedback(() => props.report.taskId, selected);
useActionNotification().watch(notice, () => (needsRecheck.value ? 'warning' : 'info'));
function describe(item: Feedback) {
    const key = item.sourceId ? `source:${item.sourceId}` : `claim:${item.claimId}`;
    const target = targets.value.find((entry) => targetKey(entry) === key);
    return target ? `${target.label}（${target.id}）` : (item.sourceId ?? item.claimId);
}
</script>
