<template>
    <fieldset
        class="output-formats [border:0] min-w-0 m-0 p-0"
        :class="{ 'output-formats--compact': compact }"
        :disabled="disabled"
    >
        <legend class="mb-3 font-medium p-0">{{ label }}</legend>
        <div
            class="output-options grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_13rem),_1fr))] gap-2.5"
        >
            <label
                class="flex items-start gap-2.5 [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_55%,_transparent)] rounded-3 cursor-pointer p-3.5 [&:is(label).selected]:([border-color:var(--scova-primary)] [background:color-mix(in_srgb,_var(--scova-selected)_55%,_var(--scova-surface))]) focus-within:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem]) [fieldset:disabled_&:is(label)]:cursor-not-allowed"
                v-for="(name, format) in outputFormatLabels"
                :key="format"
                :class="{ selected: model.includes(format) }"
            >
                <input
                    class="w-[1.125rem] h-[1.125rem] flex-none mt-1 [accent-color:var(--scova-primary)] cursor-pointer [fieldset:disabled_&:is(input)]:cursor-not-allowed"
                    type="checkbox"
                    :value="format"
                    :checked="model.includes(format)"
                    @change="toggle($event, format)"
                />
                <span class="layout-grid gap-1"
                    ><strong class="font-medium">{{ name }}</strong
                    ><small v-if="!compact" class="text-muted text-[0.875rem] leading-[1.6]">{{
                        descriptions[format]
                    }}</small></span
                >
            </label>
        </div>
        <p class="text-muted text-[0.875rem] leading-[1.6] mt-2.5 mb-0">
            {{
                allowEmpty
                    ? '可多选；留空沿用已保存配置。'
                    : '可多选。按各自采集目标生成内容，保存后用于后续执行。'
            }}
        </p>
        <p
            v-if="error"
            class="scova-warning text-muted text-[0.875rem] leading-[1.6] mt-2.5 mb-0"
            role="alert"
        >
            {{ error }}
        </p>
    </fieldset>
</template>

<script setup lang="ts">
import { outputFormatLabels, type OutputFormat } from '@scova/models';
const props = withDefaults(
    defineProps<{
        label?: string;
        disabled?: boolean;
        error?: string;
        allowEmpty?: boolean;
        compact?: boolean;
    }>(),
    { label: '输出形式' },
);
const model = defineModel<OutputFormat[]>({ required: true });
const descriptions: Record<OutputFormat, string> = {
    brief: '核心答案与重要发现',
    list: '对象条目与所需字段',
    comparison: '共同维度与差异依据',
    research_report: '完整论点、证据与解释',
};
function toggle(event: Event, format: OutputFormat) {
    const next = model.value.includes(format)
        ? model.value.filter((value) => value !== format)
        : [...model.value, format];
    if (next.length || props.allowEmpty) model.value = next;
    else if (event.currentTarget instanceof HTMLInputElement)
        event.currentTarget.checked = model.value.includes(format);
}
</script>

<style scoped>
.output-formats--compact .output-options {
    @apply flex flex-wrap gap-2;
}
.output-formats--compact label {
    @apply py-2 px-3 rounded-2;
}
.output-formats--compact > p {
    @apply hidden;
}
.output-formats--compact legend {
    @apply mb-2 text-sm;
}
</style>
