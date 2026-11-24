<template>
    <header class="workspace-heading scova-interface">
        <p class="workspace-eyebrow">
            <router-link :to="inboxDestination">收件箱</router-link>
            <span aria-hidden="true">/</span><span>{{ report?.title ?? '报告' }}</span>
        </p>
        <nav class="report-tools" aria-label="报告阅读工具">
            <button
                v-if="report"
                type="button"
                class="open-current-artifact"
                @click="emit('openArtifact')"
            >
                <app-icon name="report" />成果
            </button>
        </nav>
    </header>
</template>
<script setup lang="ts">
import type { Report } from '@scova/models';
import { computed } from 'vue';
import type { inboxReturn } from '@/composable/useInbox';
import AppIcon from '@/component/common/AppIcon.vue';
const props = defineProps<{ report?: Report; returnTo?: ReturnType<typeof inboxReturn> }>();
const inboxDestination = computed(() =>
    props.returnTo
        ? { path: props.returnTo.path, state: { inboxRestore: { ...props.returnTo } } }
        : '/inbox',
);
const emit = defineEmits<{ openArtifact: [] }>();
</script>
<style scoped>
.workspace-heading {
    @apply flex flex-wrap items-center gap-x-3 justify-between min-w-0 px-4 py-1;
    min-height: 3.25rem;
    border-block-end: 1px solid color-mix(in srgb, var(--scova-border) 60%, transparent);
}
.workspace-eyebrow {
    @apply flex items-center gap-2 min-w-0 text-muted text-sm m-0;
    flex: 1;
}
.workspace-eyebrow a {
    @apply inline-flex items-center min-h-11 flex-none internal-link;
}
.workspace-eyebrow span:last-child {
    @apply truncate text-default;
}
.report-tools {
    @apply flex-none;
}
.open-current-artifact {
    @apply inline-flex items-center gap-1.5 min-h-9 border-0 rounded-2 py-1 px-2.5 text-sm text-default [background:var(--scova-selected)] cursor-pointer;
    transition:
        scale 140ms ease,
        background-color 140ms ease;
}
.open-current-artifact:hover {
    background: color-mix(in srgb, var(--scova-selected) 85%, var(--scova-text));
}
.open-current-artifact:active {
    scale: 0.96;
}
.open-current-artifact:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -2px;
}
@media (pointer: coarse) {
    .open-current-artifact {
        @apply min-h-11;
    }
}
@media (prefers-reduced-motion: reduce) {
    .open-current-artifact {
        transition: none;
        scale: none;
    }
}
</style>
