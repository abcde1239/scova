<template>
    <fieldset class="schedule-fields" :disabled="disabled">
        <legend>执行计划</legend>
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
            label="任务时区（IANA）"
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
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import SchedulePreview from '@/components/tasks/SchedulePreview.vue';
import { weekdayOptions, type SavedSchedule, type ScheduleDraft } from '@/utils/schedule';
defineProps<{
    disabled?: boolean;
    errors?: Partial<Record<keyof ScheduleDraft, string>>;
    saved?: SavedSchedule;
    dirty?: boolean;
}>();
const frequency = defineModel<string>('frequency', { required: true });
const timezone = defineModel<string>('timezone', { required: true });
const localTime = defineModel<string>('localTime', { required: true });
const weekday = defineModel<string>('weekday', { required: true });
const frequencies = [
    { value: 'manual', label: '仅手动' },
    { value: 'daily', label: '每日' },
    { value: 'weekly', label: '每周' },
];
</script>

<style scoped>
.schedule-fields {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
}
legend {
    font-size: 1.25rem;
    font-weight: 600;
    padding: 0;
    margin-block-end: 1.5rem;
}
</style>
