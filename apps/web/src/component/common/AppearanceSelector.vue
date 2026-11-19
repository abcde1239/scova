<template>
    <section class="appearance-selector grid gap-5 w-full text-default" aria-label="外观">
        <fieldset
            class="appearance-selector\_\_group flex flex-wrap gap-[0.5rem_1rem] min-w-0 [border:0] m-0 p-0"
        >
            <legend class="mb-2 font-semibold p-0">明暗</legend>
            <label
                class="inline-flex items-center gap-2 min-h-11 pl-2.5 pr-2.5 border-theme rounded-1.5 cursor-pointer [&:is(label):has(input:checked)]:([border-color:var(--scova-primary)] [background:var(--scova-selected)] text-primary)"
                v-for="option in modeOptions"
                :key="option.value"
            >
                <input
                    class="w-[1.125em] h-[1.125em] [accent-color:var(--scova-primary)] cursor-pointer m-0 keyboard-focus"
                    type="radio"
                    :name="`${groupId}-mode`"
                    :value="option.value"
                    :checked="appearance.mode === option.value"
                    @change="appearance.setMode(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
        <fieldset
            class="appearance-selector\_\_group flex flex-wrap gap-[0.5rem_1rem] min-w-0 [border:0] m-0 p-0"
        >
            <legend class="mb-2 font-semibold p-0">主题色</legend>
            <label
                class="inline-flex items-center gap-2 min-h-11 pl-2.5 pr-2.5 border-theme rounded-1.5 cursor-pointer [&:is(label):has(input:checked)]:([border-color:var(--scova-primary)] [background:var(--scova-selected)] text-primary)"
                v-for="option in accentOptions"
                :key="option.value"
            >
                <input
                    class="w-[1.125em] h-[1.125em] [accent-color:var(--scova-primary)] cursor-pointer m-0 keyboard-focus"
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
import { accentOptions, modeOptions } from '@/utils/theme/tokens';

const appearance = useAppearanceStore();
const groupId = useId();
</script>
