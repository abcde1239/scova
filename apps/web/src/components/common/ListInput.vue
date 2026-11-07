<template>
    <section class="list-input" :aria-labelledby="`${id}-label`">
        <div class="list-heading">
            <span :id="`${id}-label`" class="list-label">{{ label }}</span>
            <span class="list-count">{{ items.filter((item) => item.trim()).length }} 项</span>
        </div>
        <p v-if="hint" :id="`${id}-hint`" class="list-hint">{{ hint }}</p>
        <ol v-if="items.length" class="list-rows">
            <li v-for="(item, index) in items" :key="keys[index]" class="list-row">
                <span class="row-number" aria-hidden="true">{{ index + 1 }}</span>
                <n-input
                    :value="item"
                    :type="url ? 'text' : 'textarea'"
                    :autosize="url ? undefined : { minRows: 1 }"
                    :disabled="disabled"
                    :placeholder="placeholder"
                    :input-props="{
                        id: `${id}-${index}`,
                        'aria-label': `${label} ${index + 1}`,
                        'aria-invalid': error ? 'true' : undefined,
                        'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
                        inputmode: url ? 'url' : undefined,
                    }"
                    @update:value="update(index, $event)"
                    @keydown.enter="enter($event, index)"
                />
                <button
                    type="button"
                    class="remove-row"
                    :disabled="disabled"
                    :aria-label="`删除${label} ${index + 1}`"
                    @click="remove(index)"
                >
                    <app-icon name="close" />
                </button>
            </li>
        </ol>
        <p v-if="error" :id="`${id}-error`" class="list-error">{{ error }}</p>
        <button ref="addButton" type="button" class="add-row" :disabled="disabled" @click="add()">
            <app-icon name="create" />{{ addLabel || '添加一项' }}
        </button>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import { NInput } from 'naive-ui';
import AppIcon from '@/components/common/AppIcon.vue';
const props = defineProps<{
    label: string;
    hint?: string;
    placeholder?: string;
    addLabel?: string;
    url?: boolean;
    disabled?: boolean;
    error?: string;
}>();
const items = defineModel<string[]>({ required: true });
const id = `list-${useId()}`;
const addButton = ref<HTMLButtonElement>();
let sequence = 0;
const keys = ref(items.value.map(() => sequence++));
watch(
    () => items.value.length,
    (length) => {
        while (keys.value.length < length) keys.value.push(sequence++);
        keys.value.length = length;
    },
);
async function focus(index: number) {
    await nextTick();
    document.getElementById(`${id}-${index}`)?.focus();
}
function update(index: number, value: string) {
    const next = [...items.value];
    next[index] = value;
    items.value = next;
}
function add(after = items.value.length - 1) {
    if (props.disabled) return;
    const next = [...items.value];
    next.splice(after + 1, 0, '');
    keys.value.splice(after + 1, 0, sequence++);
    items.value = next;
    void focus(after + 1);
}
async function remove(index: number) {
    if (props.disabled) return;
    const next = [...items.value];
    next.splice(index, 1);
    keys.value.splice(index, 1);
    items.value = next;
    if (next.length) await focus(Math.min(index, next.length - 1));
    else {
        await nextTick();
        addButton.value?.focus();
    }
}
function enter(event: KeyboardEvent, index: number) {
    if (event.isComposing || event.shiftKey) return;
    event.preventDefault();
    add(index);
}
</script>

<style scoped>
.list-input {
    display: grid;
    gap: 0.65rem;
    min-inline-size: 0;
}
.list-heading {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
}
.list-label {
    font-weight: 550;
}
.list-count,
.list-hint {
    font-size: 0.875rem;
    color: var(--scova-muted);
}
.list-hint,
.list-error {
    margin: 0;
    line-height: 1.6;
    overflow-wrap: anywhere;
}
.list-rows {
    display: grid;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
}
.list-row {
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr) 2.75rem;
    align-items: start;
    gap: 0.5rem;
    min-inline-size: 0;
}
.row-number {
    padding-block-start: 0.75rem;
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.list-row :deep(.n-input) {
    min-inline-size: 0;
    border-radius: 0.5rem;
    --n-font-size: 1rem !important;
}
.remove-row,
.add-row {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-block-size: 2.75rem;
    border: 0;
    background: transparent;
    color: var(--scova-muted);
    font: inherit;
    cursor: pointer;
    border-radius: 0.4rem;
}
.add-row {
    justify-self: start;
    color: var(--scova-primary);
    padding-inline: 0.4rem;
}
.remove-row:hover {
    color: var(--scova-danger);
    background: color-mix(in srgb, var(--scova-danger) 8%, transparent);
}
button:focus-visible {
    outline: 0.0625rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
}
.list-error {
    color: var(--scova-danger);
    font-size: 0.875rem;
}
</style>
