<template>
    <section class="schedule-preview scova-surface" aria-labelledby="schedule-preview-title">
        <h3 id="schedule-preview-title">计划预览</h3>
        <p>{{ description }}</p>
        <p v-if="!saved || dirty">
            当前未保存修改尚未安排执行；下次计划以保存后从服务端读取的时刻为准。
        </p>
        <p v-else>当前填写内容与已保存配置一致，下次计划见下方服务端记录。</p>
        <section v-if="saved" class="saved-schedule" aria-labelledby="saved-schedule-title">
            <h3 id="saved-schedule-title">服务端已保存的计划</h3>
            <p v-if="dirty">当前有未保存修改，下列记录仍对应上次保存或读取的配置与时区。</p>
            <p>{{ scheduleDescription(saved.schedule, saved.timezone) }}</p>
            <dl v-if="serverTime">
                <div>
                    <dt>下次计划 · 任务当地时间</dt>
                    <dd>
                        <time :datetime="saved.nextRunAt!">{{ serverTime.local }}</time>
                    </dd>
                </div>
                <div>
                    <dt>下次计划 · UTC</dt>
                    <dd>
                        <time :datetime="saved.nextRunAt!">{{ serverTime.utc }}</time>
                    </dd>
                </div>
            </dl>
            <p v-else>{{ noServerTime }}</p>
        </section>
        <p v-else>尚未保存任务，服务端还没有此任务的下次计划时刻。</p>
        <p>
            “仅手动”是计划频率，不是执行模式。定时执行模式由部署者设置，默认演示
            demo；当前部署模式未知，页面不能修改或保证真实 live。
        </p>
        <details>
            <summary>夏令时与重复时刻规则</summary>
            <p>
                当地时刻不存在时顺延到首个有效时刻；当地时刻重复时只选择首次。以下 America/New_York
                固定示例用于解释规则，不是当前任务预测。
            </p>
            <dl class="dst-examples">
                <div v-for="example in examples" :key="example.kind">
                    <dt>{{ example.kind }}示例 · 请求 {{ example.requested }}</dt>
                    <dd>{{ example.note }}</dd>
                    <dd>实际当地时间：{{ example.local }}</dd>
                    <dd>UTC：{{ example.utc }}</dd>
                </div>
            </dl>
        </details>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
    dstExamples,
    formatScheduleInstant,
    scheduleDescription,
    scheduleInput,
    type ScheduleDraft,
    type SavedSchedule,
} from '@/utils/schedule';
const props = defineProps<{ draft: ScheduleDraft; saved?: SavedSchedule; dirty?: boolean }>();
const description = computed(() => {
    try {
        return scheduleDescription(scheduleInput(props.draft), props.draft.timezone.trim());
    } catch {
        return '请填写合法的频率、任务时区与当地时间；每周计划还需要明确星期。';
    }
});
const serverTime = computed(() =>
    props.saved?.nextRunAt
        ? formatScheduleInstant(props.saved.nextRunAt, props.saved.timezone)
        : undefined,
);
const noServerTime = computed(() =>
    props.saved?.status === 'paused'
        ? '服务端任务已暂停，当前未安排下一次周期执行。'
        : props.saved?.status === 'archived'
          ? '服务端任务已归档，当前未安排下一次周期执行。'
          : props.saved?.schedule.frequency === 'manual'
            ? '服务端已保存为仅手动执行，没有周期计划。'
            : '服务端当前未返回下次计划时刻，请重新读取任务核对。',
);
const examples = dstExamples.map((example) => ({
    ...example,
    ...formatScheduleInstant(example.instant, 'America/New_York'),
}));
</script>

<style scoped>
.schedule-preview,
.saved-schedule {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
.schedule-preview {
    padding: clamp(1rem, 3%, 1.5rem);
    border-radius: 0.75rem;
    overflow-wrap: anywhere;
}
h3,
p {
    margin: 0;
}
h3 {
    font-size: 1.125rem;
    line-height: 1.5;
}
.saved-schedule {
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 1rem;
}
dl {
    display: grid;
    gap: 1rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0.25rem 0 0;
}
details > p,
.dst-examples {
    margin-block-start: 1rem;
}
summary {
    cursor: pointer;
    min-block-size: 2.75rem;
    padding-block: 0.5rem;
}
summary:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
