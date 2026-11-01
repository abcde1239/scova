<template>
    <figure
        v-if="image && !failed"
        v-show="loaded"
        class="source-image"
        :class="{ 'source-image--report': variant === 'report' }"
    >
        <img
            :key="image.src"
            :src="image.src"
            :alt="image.alt"
            decoding="async"
            @load="loaded = true"
            @error="failed = true"
        />
        <figcaption>{{ image.concept ? '概念图 · ' : '' }}{{ image.attribution }}</figcaption>
    </figure>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { displayImage } from '@/models/source-image';
import type { SourceImageInput } from '@/models/source-image';

const props = withDefaults(
    defineProps<{ image?: SourceImageInput; variant?: 'thumbnail' | 'report' }>(),
    {
        variant: 'thumbnail',
    },
);
const image = computed(() => displayImage(props.image));
const failed = ref(false);
const loaded = ref(false);
watch(
    () => image.value?.src,
    () => {
        failed.value = false;
        loaded.value = false;
    },
    { flush: 'sync' },
);
</script>

<style scoped>
.source-image {
    flex: 0 1 auto;
    inline-size: min(9.375rem, 100%);
    max-inline-size: 100%;
    margin: 0;
}
img {
    display: block;
    inline-size: 100%;
    aspect-ratio: 3 / 2;
    object-fit: cover;
    border-radius: 0.5rem;
}
figcaption {
    margin-block-start: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
    color: var(--scova-muted);
}
.source-image--report {
    inline-size: min(100%, 42.5rem);
}
.source-image--report img {
    aspect-ratio: auto;
    block-size: auto;
    object-fit: contain;
}
@container source-item (max-width: 30rem) {
    .source-image:not(.source-image--report) {
        inline-size: min(5.5rem, 100%);
    }
    .source-image:not(.source-image--report) img {
        aspect-ratio: 1;
    }
}
@container source-item (max-width: 20rem) {
    .source-image:not(.source-image--report) {
        inline-size: min(4.5rem, 100%);
    }
}
</style>
