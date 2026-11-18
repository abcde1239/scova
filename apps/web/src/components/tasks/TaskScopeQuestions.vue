<template>
    <section
        ref="panel"
        class="scope-questions layout-grid gap-5"
        aria-labelledby="scope-question-title"
    >
        <h3 class="break-anywhere m-0 keyboard-focus-wide" id="scope-question-title" tabindex="-1">
            核对搜索范围 · {{ step }}/3
        </h3>
        <p class="break-anywhere m-0" v-if="summary">{{ summary }}</p>
        <details v-if="transcript?.length">
            <summary>已回答的需求澄清</summary>
            <dl class="break-anywhere grid gap-2 m-0">
                <template v-for="(item, index) in transcript" :key="index"
                    ><dt class="text-muted">{{ item.question }}</dt>
                    <dd class="break-anywhere m-0">{{ item.answer }}</dd></template
                >
            </dl>
        </details>
        <template v-if="step === 1">
            <p class="break-anywhere m-0">你希望查到什么？哪些内容必须包含，哪些不需要？</p>
            <task-config-field
                v-model="goal"
                label="希望回答的核心问题"
                kind="textarea"
                :disabled="disabled"
            />
            <list-input
                v-model="focusPoints"
                label="必须收集的内容（可选）"
                placeholder="例如：价格、申请条件"
                add-label="添加搜索重点"
                :disabled="disabled"
            />
            <list-input
                v-model="exclusions"
                label="不查哪些内容（可选）"
                placeholder="例如：广告、历史背景"
                add-label="添加排除内容"
                :disabled="disabled"
            />
        </template>
        <template v-else-if="step === 2">
            <p class="break-anywhere m-0">
                查哪些时间、哪些来源？不指定网址时，按已确认的问题搜索公开网页。
            </p>
            <task-config-field
                v-model="rangeKind"
                label="搜索时间范围"
                kind="select"
                :options="[
                    { value: 'rolling', label: '最近一段时间' },
                    { value: 'fixed', label: '指定时间段' },
                    ...(researchMode === 'analysis'
                        ? [{ value: 'unbounded', label: '不限日期' }]
                        : []),
                ]"
                :disabled="disabled"
            />
            <task-config-field
                v-if="rangeKind === 'rolling'"
                v-model="days"
                label="搜索最近多少天"
                kind="number"
                :disabled="disabled"
            />
            <template v-else-if="rangeKind === 'fixed'">
                <p class="break-anywhere m-0">
                    以下日期按浏览器当地时间 {{ browserTimezone }} 填写。
                </p>
                <task-config-field
                    v-model="start"
                    label="搜索起始时间"
                    kind="date"
                    :disabled="disabled"
                />
                <task-config-field
                    v-model="end"
                    label="搜索截止时间"
                    kind="date"
                    :disabled="disabled"
                />
            </template>
            <list-input
                v-model="preferredUrls"
                label="优先查阅的网址（可选）"
                url
                add-label="添加优先网址"
                :disabled="disabled"
            />
            <list-input
                v-model="excludedUrls"
                label="不查阅的网址（可选）"
                url
                add-label="添加排除网址"
                :disabled="disabled"
            />
            <task-config-field
                v-model:checked="officialOnly"
                label="限定官方来源"
                kind="checkbox"
                :disabled="disabled"
            />
        </template>
        <template v-else>
            <p class="break-anywhere m-0">只需要收集信息，还是需要分析？希望如何呈现结果？</p>
            <task-config-field
                v-model="researchMode"
                label="此次需要的工作"
                kind="select"
                :options="[
                    { value: 'collection', label: '资料采集' },
                    { value: 'analysis', label: '分析研究' },
                ]"
                :disabled="disabled"
            />
            <p class="break-anywhere m-0">
                资料采集只收录窗口内、有直接原文出处的值，不接受模型补答；分析研究允许带标记的模型回答，日期窗口可选。
            </p>
            <task-config-field
                v-if="researchMode === 'collection'"
                v-model="collectionDateUnknown"
                label="日期未确认的条目"
                kind="select"
                :options="[
                    { value: 'separate', label: '单列展示，不计入采集结果' },
                    { value: 'discard', label: '直接剔除' },
                ]"
                :disabled="disabled"
            />
            <output-format-select
                v-model="outputFormats"
                label="希望得到的形式"
                :disabled="disabled"
            />
            <dl class="break-anywhere grid gap-2 m-0">
                <dt class="text-muted">核心问题</dt>
                <dd class="break-anywhere m-0">{{ goal }}</dd>
                <dt class="text-muted">搜索重点</dt>
                <dd class="break-anywhere m-0">{{ focusPoints.join('、') || '围绕核心问题' }}</dd>
                <dt class="text-muted">时间范围</dt>
                <dd class="break-anywhere m-0">
                    {{
                        rangeKind === 'rolling'
                            ? `最近 ${days} 天`
                            : rangeKind === 'unbounded'
                              ? '不限日期'
                              : `${start} 至 ${end}`
                    }}
                </dd>
                <dt class="text-muted">优先来源</dt>
                <dd class="break-anywhere m-0">{{ preferredUrls.join('、') || '公开网页' }}</dd>
            </dl>
            <p class="break-anywhere m-0">
                确认后由需求整理 Agent 生成草稿，应用并保存后才会创建任务。
            </p>
        </template>
        <p v-if="error" role="alert" class="scope-error break-anywhere text-danger m-0">
            {{ error }}
        </p>
        <div class="scope-actions action-group">
            <action-button :disabled="disabled" @click="emit('cancel')">返回需求描述</action-button>
            <action-button :disabled="disabled" @click="emit('manual')">手动填写</action-button>
            <action-button v-if="step > 1" :disabled="disabled" @click="move(-1)"
                >上一步</action-button
            >
            <action-button :disabled="disabled" @click="advance">{{
                step < 3 ? '下一步' : '确认范围并生成草稿'
            }}</action-button>
        </div>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import {
    parseContract,
    TaskDraftScopeSchema,
    type TaskDraftScope,
    type TaskClarifications,
} from '@scova/models';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import OutputFormatSelect from '@/components/tasks/OutputFormatSelect.vue';
import ListInput from '@/components/common/ListInput.vue';
import ActionButton from '@/components/common/ActionButton.vue';
const props = defineProps<{
    inputText: string;
    format: string;
    mode: string;
    initial?: TaskDraftScope;
    summary?: string;
    transcript?: TaskClarifications;
    disabled?: boolean;
}>();
const emit = defineEmits<{ confirm: [scope: TaskDraftScope]; cancel: []; manual: [] }>();
const panel = ref<HTMLElement>();
const step = ref(1);
const error = ref('');
const goal = ref(props.initial?.goal ?? props.inputText.trim());
const focusPoints = ref([...(props.initial?.focusPoints ?? [])]);
const exclusions = ref([...(props.initial?.exclusions ?? [])]);
const preferredUrls = ref([...(props.initial?.sourcePreferences.preferredUrls ?? [])]);
const excludedUrls = ref([...(props.initial?.sourcePreferences.excludedUrls ?? [])]);
const officialOnly = ref(props.initial?.sourcePreferences.officialOnly ?? false);
const rangeKind = ref<string>(props.initial?.timeRange.kind ?? 'rolling');
const days = ref(
    String(props.initial?.timeRange.kind === 'rolling' ? props.initial.timeRange.days : 7),
);
const localTime = (value: string) => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
};
const start = ref(
    props.initial?.timeRange.kind === 'fixed' ? localTime(props.initial.timeRange.start) : '',
);
const end = ref(
    props.initial?.timeRange.kind === 'fixed' ? localTime(props.initial.timeRange.end) : '',
);
const researchMode = ref(props.initial?.researchMode ?? props.mode);
const collectionDateUnknown = ref<string>(props.initial?.collectionDateUnknown ?? 'separate');
const outputFormats = ref<import('@scova/models').OutputFormat[]>(
    props.initial?.outputFormats ?? [
        parseContract(
            TaskDraftScopeSchema.properties.outputFormat,
            props.initial?.outputFormat ?? props.format,
        ),
    ],
);
watch(researchMode, (mode) => {
    if (mode !== 'collection') return;
    if (rangeKind.value === 'unbounded') {
        rangeKind.value = 'rolling';
        days.value = '7';
    }
    outputFormats.value = ['list'];
});
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function fixedInstant(value: string, key: 'start' | 'end') {
    const initial = props.initial?.timeRange;
    if (initial?.kind === 'fixed' && value === localTime(initial[key])) return initial[key];
    return new Date(value).toISOString();
}
function scope(validateStep = 3) {
    return parseContract(TaskDraftScopeSchema, {
        goal: goal.value,
        focusPoints: focusPoints.value.filter((v) => v.trim()),
        exclusions: exclusions.value.filter((v) => v.trim()),
        sourcePreferences:
            validateStep === 1
                ? { preferredUrls: [], excludedUrls: [], officialOnly: false }
                : {
                      preferredUrls: preferredUrls.value
                          .filter((v) => v.trim())
                          .map((v) => v.trim()),
                      excludedUrls: excludedUrls.value.filter((v) => v.trim()).map((v) => v.trim()),
                      officialOnly: officialOnly.value,
                  },
        timeRange:
            validateStep === 1
                ? { kind: 'rolling', days: 7 }
                : rangeKind.value === 'rolling'
                  ? { kind: 'rolling', days: Number(days.value) }
                  : rangeKind.value === 'unbounded'
                    ? { kind: 'unbounded' }
                    : {
                          kind: 'fixed',
                          start: fixedInstant(start.value, 'start'),
                          end: fixedInstant(end.value, 'end'),
                      },
        researchMode: researchMode.value,
        ...(researchMode.value === 'collection'
            ? { collectionDateUnknown: collectionDateUnknown.value }
            : {}),
        outputFormat: outputFormats.value[0],
        ...(outputFormats.value.length > 1 ? { outputFormats: outputFormats.value } : {}),
    });
}
async function move(delta: number) {
    step.value += delta;
    error.value = '';
    await nextTick();
    panel.value?.querySelector<HTMLElement>('h3')?.focus();
}
function advance() {
    try {
        const confirmed = scope(step.value);
        if (step.value < 3) void move(1);
        else emit('confirm', confirmed);
    } catch {
        error.value =
            step.value === 1
                ? '请填写核心问题；每项最多1000字、最多10项，核心问题最多2000字。'
                : '请检查日期先后、正整数天数和公开网页链接；每类网址最多10条。';
    }
}
</script>
