<template>
    <section class="appearance-selector" aria-label="外观">
        <fieldset class="appearance-selector__group">
            <legend>明暗</legend>
            <label v-for="option in modeOptions" :key="option.value">
                <input
                    type="radio"
                    :name="`${groupId}-mode`"
                    :value="option.value"
                    :checked="appearance.mode === option.value"
                    @change="appearance.setMode(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
        <fieldset class="appearance-selector__group">
            <legend>主题色</legend>
            <label v-for="option in accentOptions" :key="option.value">
                <input
                    type="radio"
                    :name="`${groupId}-accent`"
                    :value="option.value"
                    :checked="appearance.accent === option.value"
                    @change="appearance.setAccent(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
    </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { useAppearanceStore } from '@/store/appearance';
import { accentOptions, modeOptions } from '@/theme/tokens';

const appearance = useAppearanceStore();
const groupId = useId();
</script>

<style scoped>
.appearance-selector {
    display: grid;
    gap: 1.25rem;
    inline-size: 100%;
    color: var(--scova-text);
}

.appearance-selector__group {
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
</style>
