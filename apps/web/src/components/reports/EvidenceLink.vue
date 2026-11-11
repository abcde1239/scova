<template>
    <a class="evidence-link scova-citation-tools" :href="`#evidence-${evidence.id}`"
        >{{ evidence.title }} · 核对保存引用</a
    >
</template>
<script setup lang="ts">
import type { Evidence } from '@scova/models';
defineProps<{ evidence: Evidence }>();
</script>
<style scoped>
a {
    display: inline-flex;
    min-block-size: 2.75rem;
    align-items: center;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
