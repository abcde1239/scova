<template>
    <section class="reading-preferences grid gap-5 mt-8" aria-label="阅读设置">
        <fieldset class="flex flex-wrap gap-[0.5rem_1rem] min-w-0 [border:0] m-0 p-0">
            <legend class="mb-2 font-semibold p-0">正文字体</legend>
            <label
                v-for="option in readingFamilies"
                :key="option.value"
                class="scova-action inline-flex items-center gap-2 min-h-11 pl-2.5 pr-2.5 border-theme rounded-1.5 cursor-pointer [&:is(label):has(input:checked)]:([border-color:var(--scova-primary)] [background:var(--scova-selected)] text-primary)"
            >
                <input
                    class="w-[1.125em] h-[1.125em] [accent-color:var(--scova-primary)] cursor-pointer m-0 keyboard-focus"
                    type="radio"
                    :name="`${groupId}-family`"
                    :value="option.value"
                    :checked="reading.family === option.value"
                    @change="reading.setFamily(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
        <fieldset class="flex flex-wrap gap-[0.5rem_1rem] min-w-0 [border:0] m-0 p-0">
            <legend class="mb-2 font-semibold p-0">正文字号</legend>
            <label
                v-for="option in readingSizes"
                :key="option.value"
                class="scova-action inline-flex items-center gap-2 min-h-11 pl-2.5 pr-2.5 border-theme rounded-1.5 cursor-pointer [&:is(label):has(input:checked)]:([border-color:var(--scova-primary)] [background:var(--scova-selected)] text-primary)"
            >
                <input
                    class="w-[1.125em] h-[1.125em] [accent-color:var(--scova-primary)] cursor-pointer m-0 keyboard-focus"
                    type="radio"
                    :name="`${groupId}-size`"
                    :value="option.value"
                    :checked="reading.size === option.value"
                    @change="reading.setSize(option.value)"
                />
                {{ option.label }}
            </label>
        </fieldset>
        <section aria-label="阅读预览" class="reading-preview min-w-0">
            <h2 class="scova-content-title mt-0 mb-3">阅读预览</h2>
            <p class="scova-reading">研究资料与来源证据保持可追溯。Reading 2026</p>
        </section>
    </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { readingFamilies, readingSizes } from '@/store/reading';
import { useReadingTypography } from '@/composable/useReadingTypography';
const { reading } = useReadingTypography();
const groupId = useId();
</script>
