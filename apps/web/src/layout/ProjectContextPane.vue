<template>
    <aside
        v-if="layout.wide.value"
        :id="paneId"
        class="context-rail"
        :style="{ '--context-width': `${layout.width(mode)}px` }"
        :aria-label="title"
    >
        <workspace-separator :pane="mode" :label="`${title}宽度`" :controls="paneId" />
        <div class="context-content"><slot /></div>
    </aside>
    <dialog
        v-else
        :id="paneId"
        ref="drawer"
        class="context-drawer"
        :aria-label="title"
        @cancel.prevent="close"
        @click="backdrop"
    >
        <div class="flex items-center justify-between gap-2 mb-3">
            <strong>{{ title }}</strong>
            <action-button v-bind="{ autofocus: true }" quaternary @click="close"
                >关闭</action-button
            >
        </div>
        <slot />
    </dialog>
</template>

<script setup lang="ts">
import { inject, ref, watch } from 'vue';
import ActionButton from '@/component/common/ActionButton.vue';
import WorkspaceSeparator from '@/layout/WorkspaceSeparator.vue';
import {
    projectWorkspaceLayoutKey,
    type WorkspacePanelMode,
} from '@/composable/useProjectWorkspaceLayout';

defineProps<{ paneId: string; title: string; mode: WorkspacePanelMode }>();
const open = defineModel<boolean>({ required: true });
const drawer = ref<HTMLDialogElement>();
const layout = inject(projectWorkspaceLayoutKey)!;
function close() {
    open.value = false;
}
function backdrop(event: MouseEvent) {
    if (event.target !== drawer.value) return;
    const bounds = drawer.value.getBoundingClientRect();
    if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
    )
        close();
}
watch(
    [open, drawer],
    ([requested, element]) => {
        if (!element) return;
        if (requested && !element.open) element.showModal();
        else if (!requested && element.open) element.close();
    },
    { flush: 'post' },
);
watch(layout.wide, () => {
    open.value = false;
});
</script>

<style scoped>
.context-rail {
    @apply relative min-w-0 min-h-0 bg-surface [border-inline-start:1px_solid_var(--scova-border)];
    inline-size: var(--context-width);
}
.context-content {
    @apply h-full min-h-0 overflow-auto [overscroll-behavior:contain] p-4;
}
.context-drawer {
    @apply fixed inset-block-0 m-0 p-4 min-w-0 bg-surface text-default border-0 overflow-auto
        [overscroll-behavior:contain];
    box-sizing: border-box;
    inset-inline: auto 0;
    inline-size: min(25rem, 100%);
    max-inline-size: 100%;
    block-size: 100dvh;
    max-block-size: 100dvh;
}
.context-drawer::backdrop {
    background: rgb(0 0 0 / 28%);
}
</style>
