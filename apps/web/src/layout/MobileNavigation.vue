<template>
    <div class="mobile-navigation">
        <button
            ref="trigger"
            type="button"
            class="menu-trigger"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-controls="panelId"
            @click="show"
        >
            <app-icon name="menu" />菜单
        </button>
        <dialog
            :id="panelId"
            ref="panel"
            class="mobile-drawer"
            aria-label="工作台侧边栏"
            @cancel.prevent="close(true)"
            @keydown.tab="containFocus"
            @click="backdrop"
        >
            <div class="drawer-content">
                <div class="drawer-heading">
                    <div
                        v-if="session.user.value && session.phase.value === 'ready'"
                        class="drawer-account"
                    >
                        <span class="avatar" aria-hidden="true">{{ initial }}</span>
                        <span>{{ session.user.value.email }}</span>
                    </div>
                    <button
                        type="button"
                        class="close-trigger"
                        aria-label="关闭侧边栏"
                        @click="close(true)"
                    >
                        <app-icon name="close" />
                    </button>
                </div>
                <nav class="menu-panel" aria-label="工作台菜单">
                    <router-link
                        v-for="item in items"
                        :key="item.path"
                        :to="item.path"
                        :aria-current="route.path === item.path ? 'page' : undefined"
                        @click="select(item.path, $event)"
                    >
                        <app-icon :name="item.icon" />{{ item.label }}
                    </router-link>
                </nav>
                <div class="drawer-footer" @click="selectLogin">
                    <action-button
                        quaternary
                        v-if="session.user.value && session.phase.value === 'ready'"
                        :busy="session.logoutPending.value"
                        @click="session.logout"
                        ><app-icon name="logout" />退出登录</action-button
                    >
                    <navigation-button
                        v-else-if="session.phase.value === 'ready'"
                        to="/login"
                        icon="account"
                        >登录</navigation-button
                    >
                    <p v-if="session.logoutError.value" class="logout-error">
                        {{ session.logoutError.value }}
                    </p>
                </div>
            </div>
        </dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import NavigationButton from '@/components/common/NavigationButton.vue';
import type { IconName } from '@/components/common/icons';
import { useSession } from '@/composables/useSession';

defineProps<{ items: { path: string; label: string; icon: IconName }[] }>();
const route = useRoute();
const session = useSession();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLDialogElement>();
const open = ref(false);
const panelId = `mobile-menu-${useId()}`;
const initial = computed(() => session.user.value?.email.slice(0, 1).toUpperCase());
let media: MediaQueryList | undefined;

function show() {
    if (!media?.matches || open.value) return;
    panel.value?.showModal();
    open.value = true;
}
function close(returnFocus = false) {
    if (!open.value) return;
    open.value = false;
    panel.value?.close();
    if (returnFocus) void nextTick(() => trigger.value?.focus());
}
function select(path: string, event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
        return;
    close();
    if (route.path === path) void nextTick(() => document.getElementById('main-content')?.focus());
}
function selectLogin(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest('a')) select('/login', event);
}
function backdrop(event: MouseEvent) {
    if (event.target !== panel.value) return;
    const bounds = panel.value.getBoundingClientRect();
    if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
    )
        close(true);
}
function resize() {
    if (!media?.matches && open.value) {
        close();
        document.getElementById('main-content')?.focus();
    }
}
function containFocus(event: KeyboardEvent) {
    const controls = [
        ...(panel.value?.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), [tabindex="0"]',
        ) ?? []),
    ].filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
    }
}
watch(
    () => [route.fullPath, session.user.value?.id],
    () => close(),
);
onMounted(() => {
    media = window.matchMedia('(max-width: 53.999rem)');
    media.addEventListener('change', resize);
});
onUnmounted(() => {
    close();
    media?.removeEventListener('change', resize);
});
</script>

<style scoped>
.mobile-navigation {
    display: none;
}
:global(html:has(.mobile-drawer[open])) {
    overflow: hidden;
}
.menu-trigger,
.close-trigger,
.menu-panel a {
    display: inline-flex;
    align-items: center;
    gap: 0.625em;
    min-block-size: 2.75rem;
    min-inline-size: 2.75rem;
    padding: 0.625rem 0.875rem;
    border: 0;
    border-radius: 0.375rem;
    color: inherit;
    background: transparent;
    font: inherit;
    text-decoration: none;
    cursor: pointer;
}
.mobile-drawer {
    position: fixed;
    inset-block: 0;
    inset-inline: 0 auto;
    inline-size: min(22rem, calc(100% - 2rem));
    max-inline-size: 100%;
    block-size: 100dvh;
    max-block-size: 100dvh;
    margin: 0;
    padding: 0;
    border: 0;
    background: var(--scova-surface);
    color: var(--scova-text);
    overflow-y: auto;
    overscroll-behavior: contain;
    transform: translateX(0);
    transition: transform 0.18s ease-out;
}
@starting-style {
    .mobile-drawer[open] {
        transform: translateX(-100%);
    }
}
@media (prefers-reduced-motion: reduce) {
    .mobile-drawer {
        transition: none;
    }
}
.mobile-drawer::backdrop {
    background: rgb(0 0 0 / 28%);
}
.drawer-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-block-size: 100%;
    min-inline-size: 0;
    padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
}
.drawer-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-weight: 600;
}
.close-trigger {
    justify-content: center;
    padding: 0.625rem;
    flex-shrink: 0;
    margin-inline-start: auto;
    grid-column: 2;
    grid-row: 1;
}
.drawer-account {
    display: contents;
    overflow-wrap: anywhere;
    min-inline-size: 0;
}
.drawer-account > span:last-child {
    min-inline-size: 0;
    grid-column: 1 / -1;
    grid-row: 2;
    font-weight: 400;
}
.avatar {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    inline-size: 2.5rem;
    block-size: 2.5rem;
    border-radius: 50%;
    background: var(--scova-selected);
    color: var(--scova-primary);
}
.menu-panel {
    display: grid;
    gap: 0.25rem;
}
.drawer-footer {
    display: grid;
    gap: 0.5rem;
    padding-block-start: 0.5rem;
    border-block-start: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
}
.drawer-footer :deep(.n-button) {
    justify-content: start;
    border: 0;
    background: transparent;
}
.logout-error {
    color: var(--scova-danger);
    overflow-wrap: anywhere;
}
.menu-panel a[aria-current='page'],
.menu-panel a:hover,
.menu-trigger:hover,
.close-trigger:hover {
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
        display: block;
        margin-inline-start: auto;
    }
}
</style>
