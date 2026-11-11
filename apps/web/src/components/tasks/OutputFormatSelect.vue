<template>
    <fieldset class="output-formats" :disabled="disabled">
        <legend>{{ label }}</legend>
        <div class="output-options">
            <label
                v-for="(name, format) in outputFormatLabels"
                :key="format"
                :class="{ selected: model.includes(format) }"
            >
                <input
                    type="checkbox"
                    :value="format"
                    :checked="model.includes(format)"
                    @change="toggle($event, format)"
                />
                <span
                    ><strong>{{ name }}</strong
                    ><small>{{ descriptions[format] }}</small></span
                >
            </label>
        </div>
        <p>
            {{
                allowEmpty
                    ? '可多选；留空沿用已保存配置。'
                    : '可多选。按各自采集目标生成内容，保存后用于后续执行。'
            }}
        </p>
        <p v-if="error" class="scova-warning" role="alert">{{ error }}</p>
    </fieldset>
</template>

<script setup lang="ts">
import { outputFormatLabels, type OutputFormat } from '@scova/models';
const props = withDefaults(
    defineProps<{ label?: string; disabled?: boolean; error?: string; allowEmpty?: boolean }>(),
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
.output-formats {
    margin: 0;
    padding: 0;
    border: 0;
    min-inline-size: 0;
}
legend {
    padding: 0;
    margin-block-end: 0.75rem;
    font-weight: 500;
}
.output-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    gap: 0.625rem;
}
label {
    display: flex;
    align-items: start;
    gap: 0.625rem;
    padding: 0.875rem;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 55%, transparent);
    border-radius: 0.75rem;
    cursor: pointer;
}
label.selected {
    border-color: var(--scova-primary);
    background: color-mix(in srgb, var(--scova-selected) 55%, var(--scova-surface));
}
input {
    inline-size: 1.125rem;
    block-size: 1.125rem;
    flex: none;
    margin-block-start: 0.25rem;
    accent-color: var(--scova-primary);
    cursor: pointer;
}
span {
    display: grid;
    gap: 0.25rem;
    min-inline-size: 0;
}
strong {
    font-weight: 500;
}
small,
p {
    color: var(--scova-muted);
    font-size: 0.875rem;
    line-height: 1.6;
}
p {
    margin-block: 0.625rem 0;
}
label:focus-within {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
fieldset:disabled label,
fieldset:disabled input {
    cursor: not-allowed;
}
</style>
