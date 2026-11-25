<template>
    <div
        class="workspace-separator"
        :class="pane === 'sidebar' ? 'workspace-separator--left' : 'workspace-separator--right'"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="label"
        :aria-controls="controls"
        :aria-valuemin="layout.min(pane)"
        :aria-valuemax="layout.max(pane)"
        :aria-valuenow="layout.width(pane)"
        :aria-valuetext="`${layout.width(pane)} 像素`"
        @keydown="layout.keyboard(pane, $event)"
        @dblclick="layout.reset(pane)"
        @pointerdown="start"
        @pointermove="move"
        @lostpointercapture="drag = undefined"
    ></div>
</template>

<script setup lang="ts">
import { inject } from 'vue';
import {
    projectWorkspaceLayoutKey,
    type WorkspacePane,
} from '@/composable/useProjectWorkspaceLayout';

const props = defineProps<{ pane: WorkspacePane; label: string; controls: string }>();
const layout = inject(projectWorkspaceLayoutKey)!;
let drag: { pointer: number; x: number; width: number } | undefined;
function start(event: PointerEvent) {
    if (event.button !== 0 || drag) return;
    const handle = event.currentTarget as HTMLElement;
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, x: event.clientX, width: layout.width(props.pane) };
    event.preventDefault();
}
function move(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const shift = (event.clientX - drag.x) * (props.pane === 'sidebar' ? 1 : -1);
    layout.resize(props.pane, drag.width + shift);
}
</script>

<style scoped>
.workspace-separator {
    position: absolute;
    inset-block: 0;
    inline-size: 0.625rem;
    cursor: col-resize;
    touch-action: none;
    z-index: 2;
}
.workspace-separator--left {
    inset-inline-end: -0.3125rem;
}
.workspace-separator--right {
    inset-inline-start: -0.3125rem;
}
.workspace-separator::after {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-start: calc(50% - 1px);
    inline-size: 2px;
}
.workspace-separator:is(:hover, :focus-visible)::after {
    background: var(--scova-primary);
}
.workspace-separator:focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: -2px;
}
</style>
