<template>
    <figure
        v-if="image && !failed"
        v-show="loaded"
        class="source-image [@container_source-item_(max-width:30rem)]:[&:not(.source-image--report)]:w-[min(5.5rem,100%)] [@container_source-item_(max-width:20rem)]:[&:not(.source-image--report)]:w-[min(4.5rem,100%)] [flex:0_1_auto] w-[min(9.375rem,_100%)] max-w-full m-0 [&.source-image--report]:w-[min(100%,_42.5rem)]"
        :class="{ 'source-image--report': variant === 'report' }"
    >
        <img
            class="[@container_source-item_(max-width:30rem)]:[.source-image:not(.source-image--report)_&]:[aspect-ratio:1] block w-full [aspect-ratio:3_/_2] [object-fit:cover] rounded-2 [.source-image--report_&:is(img)]:([aspect-ratio:auto] h-auto [object-fit:contain])"
            :key="image.src"
            :src="image.src"
            :alt="image.alt"
            decoding="async"
            @load="loaded = true"
            @error="failed = true"
        />
        <figcaption class="mt-2 text-[0.875rem] leading-[1.6] break-anywhere text-muted">
            {{ image.concept ? '概念图 · ' : '' }}{{ image.attribution }}
        </figcaption>
    </figure>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { displayImage } from '@/utils/source/image';
import type { SourceImageInput } from '@/utils/source/image';

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
