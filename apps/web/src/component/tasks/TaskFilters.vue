<template>
    <fieldset class="task-filters segmented-track [border:0] m-0">
        <legend class="absolute w-[1px] h-[1px] overflow-hidden [clip-path:inset(50%)]">
            任务状态
        </legend>
        <label
            class="segmented-item relative [&.selected]:segmented-selected [&:is(label):has(input:focus-visible)]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
            v-for="item in taskFilters"
            :key="item.value"
            :class="{ selected: value === item.value }"
        >
            <input
                class="absolute inset-0 w-full h-full opacity-0 cursor-pointer m-0"
                type="radio"
                :name="group"
                :value="item.value"
                :checked="value === item.value"
                @change="emit('change', item.value)"
            />
            {{ item.label }}
        </label>
    </fieldset>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { taskFilters, type TaskFilter } from '@/composable/useTasks';
defineProps<{ value: TaskFilter }>();
const emit = defineEmits<{ change: [value: TaskFilter] }>();
const group = useId();
</script>
