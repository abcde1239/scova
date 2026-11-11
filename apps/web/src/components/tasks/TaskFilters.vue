<template>
    <fieldset class="task-filters flex flex-wrap gap-2 [border:0] m-0 p-0">
        <legend class="absolute w-[1px] h-[1px] overflow-hidden [clip-path:inset(50%)]">
            任务状态
        </legend>
        <label
            class="flex items-center gap-2 min-h-11 rounded-2 cursor-pointer py-2 px-3.5 [&.selected]:(text-primary [background:var(--scova-selected)]) [&:is(label):has(input:focus-visible)]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.1875rem])"
            v-for="item in taskFilters"
            :key="item.value"
            :class="{ selected: value === item.value }"
        >
            <input
                class="[accent-color:var(--scova-primary)] cursor-pointer m-0"
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
import { taskFilters, type TaskFilter } from '@/composables/useTasks';
defineProps<{ value: TaskFilter }>();
const emit = defineEmits<{ change: [value: TaskFilter] }>();
const group = useId();
</script>
