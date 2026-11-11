<template>
    <section class="list-input layout-grid gap-[0.65rem]" :aria-labelledby="`${id}-label`">
        <div class="list-heading flex items-baseline gap-3">
            <span :id="`${id}-label`" class="list-label [font-weight:550]">{{ label }}</span>
            <span class="list-count text-[0.875rem] text-muted"
                >{{ items.filter((item) => item.trim()).length }} 项</span
            >
        </div>
        <p
            v-if="hint"
            :id="`${id}-hint`"
            class="list-hint text-[0.875rem] text-muted leading-[1.6] break-anywhere m-0"
        >
            {{ hint }}
        </p>
        <ol v-if="items.length" class="list-rows grid gap-[0.6rem] list-none m-0 p-0">
            <li
                v-for="(item, index) in items"
                :key="keys[index]"
                class="list-row layout-grid grid-cols-[1.25rem_minmax(0,_1fr)_2.75rem] items-start gap-2 [&.list-row_.n-input]:(min-w-0 rounded-2 ![--n-font-size:1rem])"
            >
                <span class="row-number pt-3 text-muted text-[0.875rem]" aria-hidden="true">{{
                    index + 1
                }}</span>
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
                    class="remove-row inline-flex items-center justify-center gap-[0.4rem] min-h-11 [border:0] bg-transparent text-muted font-inherit cursor-pointer rounded-[0.4rem] hover:(text-danger [background:color-mix(in_srgb,_var(--scova-danger)_8%,_transparent)]) focus-visible:([outline:0.0625rem_solid_var(--scova-primary)] [outline-offset:0.125rem]) disabled:(cursor-not-allowed opacity-55)"
                    :disabled="disabled"
                    :aria-label="`删除${label} ${index + 1}`"
                    @click="remove(index)"
                >
                    <app-icon name="close" />
                </button>
            </li>
        </ol>
        <p
            v-if="error"
            :id="`${id}-error`"
            class="list-error leading-[1.6] break-anywhere text-danger text-[0.875rem] m-0"
        >
            {{ error }}
        </p>
        <button
            ref="addButton"
            type="button"
            class="add-row inline-flex items-center justify-center gap-[0.4rem] min-h-11 [border:0] bg-transparent text-primary font-inherit cursor-pointer rounded-[0.4rem] justify-self-start pl-[0.4rem] pr-[0.4rem] focus-visible:([outline:0.0625rem_solid_var(--scova-primary)] [outline-offset:0.125rem]) disabled:(cursor-not-allowed opacity-55)"
            :disabled="disabled"
            @click="add()"
        >
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
