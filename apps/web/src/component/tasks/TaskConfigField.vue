<template>
    <div class="config-field">
        <label :for="id">{{ label }}</label>
        <app-select
            v-if="kind === 'select'"
            :id="id"
            v-model="value"
            :disabled="disabled"
            :label="label"
            :options="options ?? []"
            :searchable="searchable"
            :invalid="!!error"
            :describedby="error ? `${id}-error` : undefined"
        />
        <input
            v-else-if="kind === 'checkbox'"
            :id="id"
            v-model="checked"
            type="checkbox"
            :disabled="disabled"
            :aria-invalid="error ? 'true' : undefined"
            :aria-describedby="error ? `${id}-error` : undefined"
        />
        <app-date-time-input
            v-else-if="kind === 'date' || kind === 'time'"
            :id="id"
            v-model="value"
            :kind="kind"
            :label="label"
            :error="error"
            :disabled="disabled"
        />
        <n-input
            v-else
            v-model:value="value"
            :type="kind === 'textarea' ? 'textarea' : 'text'"
            :autosize="kind === 'textarea' ? { minRows: 3 } : undefined"
            :readonly="disabled"
            placeholder=""
            :input-props="{
                id,
                type: 'text',
                inputmode: kind === 'number' ? 'numeric' : undefined,
                'aria-invalid': error ? 'true' : undefined,
                'aria-describedby': error ? `${id}-error` : undefined,
            }"
        />
        <p v-if="error" :id="`${id}-error`" class="field-error">{{ error }}</p>
    </div>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { NInput } from 'naive-ui';
import AppSelect from '@/component/common/AppSelect.vue';
import AppDateTimeInput from '@/component/common/AppDateTimeInput.vue';
defineProps<{
    label: string;
    kind?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number' | 'date' | 'time';
    options?: { value: string; label: string; description?: string }[];
    searchable?: boolean;
    error?: string;
    disabled?: boolean;
}>();
const value = defineModel<string>({ default: '' });
const checked = defineModel<boolean>('checked', { default: false });
const id = useId();
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.config-field {
    @apply layout-grid grid-cols-[minmax(0,_1fr)] gap-2;
}
label {
    @apply font-medium cursor-default min-w-0 break-anywhere;
}
.config-field:has(input[type='checkbox']) {
    @apply grid-cols-[minmax(0,_1fr)_auto] items-center min-h-11;
}
input[type='checkbox'] {
    @apply w-5 h-5 [accent-color:var(--scova-primary)] cursor-pointer m-0;
}
.config-field :deep(.n-input) {
    @apply ![--n-font-size:1rem] w-full max-w-full min-w-0 min-h-11 rounded-1.5;
}
.config-field :deep(.n-input-wrapper),
.config-field :deep(.n-input__input) {
    @apply min-w-0;
}
.config-field :deep(input),
.config-field :deep(textarea) {
    @apply min-w-0 text-[1rem] [cursor:text];
}
.config-field :deep(.n-input__input),
.config-field :deep(.n-input__input-el) {
    @apply h-auto min-h-11 leading-[1.5];
}
.config-field :deep(input[type='time']),
.config-field :deep(input[type='datetime-local']) {
    @apply [appearance:auto] [cursor:auto] max-w-full bg-surface;
}
.config-field:has(input[type='checkbox']) label {
    @apply min-h-11 flex items-center cursor-pointer;
}
.field-error {
    @apply text-danger break-anywhere m-0;
}
input:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.1875rem];
}
input:disabled {
    @apply cursor-not-allowed;
}
.config-field :deep(input[type='time']:disabled),
.config-field :deep(input[type='time'][readonly]),
.config-field :deep(input[type='datetime-local']:disabled),
.config-field :deep(input[type='datetime-local'][readonly]) {
    @apply cursor-not-allowed;
}
</style>
