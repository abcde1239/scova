<template>
    <a
        class="evidence-link scova-citation-tools inline-flex min-h-11 items-center min-w-0 break-anywhere text-primary underline-offset-[0.2em] keyboard-focus-wide"
        :href="`#evidence-${evidence.id}`"
        >{{ evidence.title }} · 核对保存引用</a
    >
</template>
<script setup lang="ts">
import type { Evidence } from '@scova/models';
defineProps<{ evidence: Evidence }>();
</script>
