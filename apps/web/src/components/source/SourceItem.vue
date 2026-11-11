<template>
    <article
        class="source-item [container:source-item_/_inline-size] min-w-0"
        :aria-labelledby="headingId"
    >
        <div class="source-item-content flex flex-wrap items-start gap-6">
            <source-image :image="image" />
            <div class="source-item-text [flex:1_1_12rem] min-w-0 break-anywhere">
                <h2
                    class="mt-0 mb-3 [font-family:inherit] text-[1.25rem] font-semibold [font-style:inherit] leading-[1.5] [font-variant:inherit] mx-0"
                    :id="headingId"
                >
                    {{ title }}
                </h2>
                <p>{{ summary }}</p>
                <div class="source-item-actions action-group mt-4"><slot name="actions" /></div>
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
