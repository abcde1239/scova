<template>
    <article class="source-item" :aria-labelledby="headingId">
        <div class="source-item-content">
            <source-image :image="image" />
            <div class="source-item-text">
                <h2 :id="headingId">{{ title }}</h2>
                <p>{{ summary }}</p>
                <div class="source-item-actions"><slot name="actions" /></div>
            </div>
        </div>
    </article>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import SourceImage from '@/components/source/SourceImage.vue';
import type { SourceImageInput } from '@/models/source-image';

defineProps<{ title: string; summary: string; image?: SourceImageInput }>();
defineSlots<{ actions(): unknown }>();
const headingId = useId();
</script>

<style scoped>
.source-item {
    container: source-item / inline-size;
    min-inline-size: 0;
}
.source-item-content {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    gap: 1.5rem;
}
.source-item-text {
    flex: 1 1 12rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
h2 {
    margin: 0 0 0.75rem;
    font: inherit;
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.5;
}
.source-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-block-start: 1rem;
}
</style>
