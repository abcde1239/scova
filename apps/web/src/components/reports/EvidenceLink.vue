<template>
    <a
        class="evidence-link scova-citation-tools source-inline-action inline-flex min-h-11 items-center min-w-0 break-anywhere internal-link keyboard-focus-wide"
        :href="`#evidence-${evidence.id}`"
        >{{ evidence.title }} · 核对保存引用</a
    >
</template>
<script setup lang="ts">
import type { Evidence } from '@scova/models';
defineProps<{ evidence: Evidence }>();
</script>
