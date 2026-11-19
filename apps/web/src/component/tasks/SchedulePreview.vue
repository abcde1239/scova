<template>
    <section
        class="schedule-preview scova-surface layout-stack rounded-3 break-anywhere p-[clamp(1rem,_3%,_1.5rem)]"
        aria-labelledby="schedule-preview-title"
    >
        <div class="preview-heading flex items-center justify-between flex-wrap gap-2">
            <h3 class="text-[1.125rem] leading-[1.5] m-0" id="schedule-preview-title">计划预览</h3>
            <info-dialog label="计划说明" title="执行计划说明">
                <p class="m-0">
                    保存任务后，计划才会生效。下次执行时间以服务端记录为准；未保存的修改不会影响原有计划。
                </p>
                <p class="m-0">
                    “仅手动”表示不自动定时执行。定时执行会调用已配置的搜索与模型；缺少配置时会明确报错。
                </p>
                <p class="m-0">
                    夏令时：当地时刻不存在时，顺延至首个有效时刻；时刻重复时，只执行第一次。
                </p>
            </info-dialog>
        </div>
        <p class="m-0">{{ description }}</p>
        <p v-if="!saved || dirty" class="preview-hint text-muted text-[0.875rem] m-0">
            保存后生效；下次执行时间以已保存计划为准。
        </p>
        <section
            v-if="saved"
            class="saved-schedule layout-stack [border-top:0.0625rem_solid_var(--scova-border)] pt-4"
            aria-labelledby="saved-schedule-title"
        >
            <h3 class="text-[1.125rem] leading-[1.5] m-0" id="saved-schedule-title">
                服务端已保存的计划
            </h3>
            <p class="m-0" v-if="dirty">有未保存修改，以下为上次保存的计划。</p>
            <p class="m-0">{{ scheduleDescription(saved.schedule, saved.timezone) }}</p>
            <dl class="grid gap-4 m-0" v-if="serverTime">
                <div>
                    <dt class="text-muted">下次计划 · 任务当地时间</dt>
                    <dd class="mt-1 mb-0 mx-0">
                        <time :datetime="saved.nextRunAt!">{{ serverTime.local }}</time>
                    </dd>
                </div>
                <div>
                    <dt class="text-muted">下次计划 · UTC</dt>
                    <dd class="mt-1 mb-0 mx-0">
                        <time :datetime="saved.nextRunAt!">{{ serverTime.utc }}</time>
                    </dd>
                </div>
            </dl>
            <p class="m-0" v-else>{{ noServerTime }}</p>
        </section>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import InfoDialog from '@/component/common/InfoDialog.vue';
import {
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
</script>
