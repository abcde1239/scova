<template>
    <section class="reading-preferences" aria-label="阅读设置">
        <fieldset>
            <legend>正文字体</legend>
            <label v-for="option in readingFamilies" :key="option.value" class="scova-action">
                <input
                    type="radio"
                    :name="`${groupId}-family`"
                    :value="option.value"
                    :checked="reading.family === option.value"
                    @change="reading.setFamily(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
        <fieldset>
            <legend>正文字号</legend>
            <label v-for="option in readingSizes" :key="option.value" class="scova-action">
                <input
                    type="radio"
                    :name="`${groupId}-size`"
                    :value="option.value"
                    :checked="reading.size === option.value"
                    @change="reading.setSize(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
        <section aria-label="阅读预览" class="reading-preview">
            <h2 class="scova-content-title">阅读预览</h2>
            <p class="scova-reading">研究资料与来源证据保持可追溯。Reading 2026</p>
        </section>
    </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { readingFamilies, readingSizes } from '@/store/reading';
import { useReadingTypography } from '@/composables/useReadingTypography';
const { reading } = useReadingTypography();
const groupId = useId();
</script>

<style scoped>
.reading-preferences {
    display: grid;
    gap: 1.25rem;
    margin-block-start: 2rem;
}
fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
}
legend {
    margin-block-end: 0.5rem;
    padding: 0;
    font-weight: 600;
}
label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    padding-inline: 0.625rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.375rem;
    cursor: pointer;
}
label:has(input:checked) {
    border-color: var(--scova-primary);
    background: var(--scova-selected);
    color: var(--scova-primary);
}
input {
    inline-size: 1.125em;
    block-size: 1.125em;
    margin: 0;
    accent-color: var(--scova-primary);
    cursor: pointer;
}
input:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
.reading-preview {
    min-inline-size: 0;
}
h2 {
    margin-block: 0 0.75rem;
}
</style>
