<template>
    <fieldset class="task-filters">
        <legend>任务状态</legend>
        <label
            v-for="item in taskFilters"
            :key="item.value"
            :class="{ selected: value === item.value }"
        >
            <input
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

<style scoped>
.task-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    border: 0;
}
legend {
    margin-block-end: 0.75rem;
}
label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    padding: 0.5rem 0.875rem;
    border-radius: 0.5rem;
    cursor: pointer;
}
input {
    margin: 0;
    accent-color: var(--scova-primary);
    cursor: pointer;
}
.selected {
    color: var(--scova-primary);
    background: var(--scova-selected);
}
label:has(input:focus-visible) {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
</style>
