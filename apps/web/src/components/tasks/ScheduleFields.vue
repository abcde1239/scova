<template>
    <fieldset class="schedule-fields layout-grid gap-6 [border:0] m-0 p-0" :disabled="disabled">
        <legend class="text-[1.25rem] font-semibold mb-6 p-0">执行计划</legend>
        <task-config-field
            v-model="frequency"
            label="计划频率"
            kind="select"
            :options="frequencies"
            :error="errors?.scheduleFrequency"
            :disabled="disabled"
        />
        <task-config-field
            v-model="timezone"
            label="任务时区"
            kind="select"
            searchable
            :options="timezones"
            :error="errors?.timezone"
            :disabled="disabled"
        />
        <template v-if="frequency !== 'manual'">
            <task-config-field
                v-model="localTime"
                label="执行当地时间"
                kind="time"
                :error="errors?.scheduleLocalTime"
                :disabled="disabled"
            />
            <task-config-field
                v-if="frequency === 'weekly'"
                v-model="weekday"
                label="每周执行星期"
                kind="select"
                :options="weekdayOptions"
                :error="errors?.scheduleWeekday"
                :disabled="disabled"
            />
        </template>
        <schedule-preview
            :draft="{
                scheduleFrequency: frequency,
                timezone,
                scheduleLocalTime: localTime,
                scheduleWeekday: weekday,
            }"
            :saved="saved"
            :dirty="dirty"
        />
    </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import SchedulePreview from '@/components/tasks/SchedulePreview.vue';
import { timezoneOptions } from '@/utils/timezones';
import { weekdayOptions, type SavedSchedule, type ScheduleDraft } from '@/utils/schedule';
defineProps<{
    disabled?: boolean;
    errors?: Partial<Record<keyof ScheduleDraft, string>>;
    saved?: SavedSchedule;
    dirty?: boolean;
}>();
const frequency = defineModel<string>('frequency', { required: true });
const timezone = defineModel<string>('timezone', { required: true });
const timezones = computed(() => timezoneOptions(timezone.value));
const localTime = defineModel<string>('localTime', { required: true });
const weekday = defineModel<string>('weekday', { required: true });
const frequencies = [
    { value: 'manual', label: '仅手动' },
    { value: 'daily', label: '每日' },
    { value: 'weekly', label: '每周' },
];
</script>
