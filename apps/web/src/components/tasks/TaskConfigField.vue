<template>
    <div class="config-field">
        <label :for="id">{{ label }}</label>
        <select
            v-if="kind === 'select'"
            :id="id"
            v-model="value"
            :disabled="disabled"
            :aria-invalid="error ? 'true' : undefined"
            :aria-describedby="error ? `${id}-error` : undefined"
        >
            <option v-for="option in options" :key="option.value" :value="option.value">
                {{ option.label }}
            </option>
        </select>
        <input
            v-else-if="kind === 'checkbox'"
            :id="id"
            v-model="checked"
            type="checkbox"
            :disabled="disabled"
            :aria-invalid="error ? 'true' : undefined"
            :aria-describedby="error ? `${id}-error` : undefined"
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
                type: kind === 'date' ? 'datetime-local' : kind === 'time' ? 'time' : 'text',
                step: kind === 'time' ? '60' : undefined,
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
defineProps<{
    label: string;
    kind?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number' | 'date' | 'time';
    options?: { value: string; label: string }[];
    error?: string;
    disabled?: boolean;
}>();
const value = defineModel<string>({ default: '' });
const checked = defineModel<boolean>('checked', { default: false });
const id = useId();
</script>

<style scoped>
.config-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem;
    min-inline-size: 0;
}
label {
    font-weight: 500;
    cursor: default;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.config-field:has(input[type='checkbox']) {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    min-block-size: 2.75rem;
}
select {
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 2.75rem;
    padding: 0.625rem 0.75rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.375rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    font: inherit;
    cursor: pointer;
}
input[type='checkbox'] {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    margin: 0;
    accent-color: var(--scova-primary);
    cursor: pointer;
}
.config-field :deep(.n-input) {
    --n-font-size: 1rem !important;
    inline-size: 100%;
    max-inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 2.75rem;
    border-radius: 0.375rem;
}
.config-field :deep(.n-input-wrapper),
.config-field :deep(.n-input__input) {
    min-inline-size: 0;
}
.config-field :deep(input),
.config-field :deep(textarea) {
    min-inline-size: 0;
    font-size: 1rem;
    cursor: text;
}
.config-field :deep(.n-input__input),
.config-field :deep(.n-input__input-el) {
    block-size: auto;
    min-block-size: 2.75rem;
    line-height: 1.5;
}
.config-field :deep(input[type='time']),
.config-field :deep(input[type='datetime-local']) {
    appearance: auto;
    cursor: auto;
    max-inline-size: 100%;
    background: var(--scova-surface);
}
.config-field:has(input[type='checkbox']) label {
    min-block-size: 2.75rem;
    display: flex;
    align-items: center;
    cursor: pointer;
}
.field-error {
    margin: 0;
    color: var(--scova-danger);
    overflow-wrap: anywhere;
}
select:focus-visible,
input:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
select:disabled,
input:disabled {
    cursor: not-allowed;
}
.config-field :deep(input[type='time']:disabled),
.config-field :deep(input[type='time'][readonly]),
.config-field :deep(input[type='datetime-local']:disabled),
.config-field :deep(input[type='datetime-local'][readonly]) {
    cursor: not-allowed;
}
</style>
