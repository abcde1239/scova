<template>
    <div
        class="mobile-navigation"
        @keydown.esc="close(true)"
        @focusin="focusedInside = true"
        @focusout="trackFocus"
    >
        <button
            ref="trigger"
            type="button"
            class="menu-trigger"
            :aria-expanded="open"
            :aria-controls="panelId"
            @click="open = !open"
        >
            <app-icon :name="open ? 'close' : 'menu'" />
            菜单
        </button>
        <nav v-if="open" :id="panelId" class="menu-panel" aria-label="工作台菜单">
            <router-link
                v-for="item in items"
                :key="item.path"
                :to="item.path"
                :aria-current="route.path === item.path ? 'page' : undefined"
                @click="select(item.path)"
            >
                <app-icon :name="item.icon" />
                {{ item.label }}
            </router-link>
        </nav>
    </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';

defineProps<{ items: { path: string; label: string; icon: IconName }[] }>();
const route = useRoute();
const trigger = ref<HTMLButtonElement>();
const open = ref(false);
const panelId = `mobile-menu-${useId()}`;
let media: MediaQueryList | undefined;
let focusedInside = false;

function trackFocus(event: FocusEvent) {
    // display:none 可在 matchMedia 回调前移除焦点，保留该次失焦前的位置。
    if (event.relatedTarget instanceof Node) {
        focusedInside = !!trigger.value?.parentElement?.contains(event.relatedTarget);
    }
}

function close(returnFocus = false) {
    if (!open.value) return;
    open.value = false;
    if (returnFocus) void nextTick(() => trigger.value?.focus());
}

function select(path: string) {
    close();
    // 同一路由不触发 App 的导航 watcher，仍需离开已关闭的菜单。
    if (route.path === path) void nextTick(() => document.getElementById('main-content')?.focus());
}

function resize() {
    if (!media?.matches) {
        close();
        if (focusedInside) document.getElementById('main-content')?.focus();
        focusedInside = false;
    }
}

watch(
    () => route.fullPath,
    () => close(),
);
onMounted(() => {
    media = window.matchMedia('(max-width: 53.999rem)');
    media.addEventListener('change', resize);
});
onUnmounted(() => media?.removeEventListener('change', resize));
</script>

<style scoped>
.mobile-navigation {
    display: none;
}

.menu-trigger,
.menu-panel a {
    display: inline-flex;
    align-items: center;
    gap: 0.625em;
    min-block-size: 2.75rem;
    padding: 0.625rem 0.875rem;
    border: 0;
    border-radius: 0.375rem;
    color: inherit;
    background: transparent;
    font: inherit;
    text-decoration: none;
    cursor: pointer;
}

.menu-trigger {
    margin-inline-start: auto;
}

.menu-panel {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
    gap: 0.375rem;
    inline-size: 100%;
    padding-block: 0.75rem;
    border-block-start: 0.0625rem solid var(--scova-border);
    background: var(--scova-surface);
}

.menu-panel a[aria-current='page'],
.menu-panel a:hover,
.menu-trigger:hover {
    background: var(--scova-selected);
    color: var(--scova-primary);
}

.menu-panel a[aria-current='page'] {
    text-decoration: underline;
    text-underline-offset: 0.25em;
}

a:focus-visible,
button:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}

@media (max-width: 53.999rem) {
    .mobile-navigation {
        display: flex;
        flex-wrap: wrap;
        margin-inline-start: auto;
    }

    .mobile-navigation:has(.menu-panel) {
        flex-basis: 100%;
    }
}
</style>
