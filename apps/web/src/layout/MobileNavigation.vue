<template>
    <div class="mobile-navigation">
        <button
            ref="trigger"
            type="button"
            class="menu-trigger"
            :aria-label="signedIn ? '打开个人侧栏' : '打开导航菜单'"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-controls="panelId"
            @click="show"
        >
            <span v-if="signedIn" class="avatar trigger-avatar" aria-hidden="true">{{
                initial
            }}</span>
            <app-icon v-else name="account" />
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
                    <router-link
                        v-if="signedIn"
                        class="drawer-account"
                        to="/account"
                        aria-label="打开账号页面"
                        :aria-current="route.path === '/account' ? 'page' : undefined"
                        @click="select('/account', $event)"
                    >
                        <span class="avatar" aria-hidden="true">{{ initial }}</span>
                        <span class="drawer-identity">
                            <strong>我的账号</strong>
                            <span class="account-email">{{ session.user.value?.email }}</span>
                        </span>
                        <app-icon name="chevron" />
                    </router-link>
                    <button
                        type="button"
                        class="close-trigger"
                        aria-label="关闭侧边栏"
                        autofocus
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
const signedIn = computed(() => !!session.user.value && session.phase.value === 'ready');
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
    () => [route.fullPath, session.user.value?.id, session.phase.value],
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
.menu-trigger {
    justify-content: center;
    padding: 0.375rem;
    border-radius: 50%;
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
    gap: 0.75rem;
    font-weight: 600;
}
.close-trigger {
    justify-content: center;
    padding: 0.625rem;
    flex-shrink: 0;
    margin-inline-start: auto;
    grid-column: 2;
    grid-row: 1;
    align-self: start;
}
.drawer-account {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem 0.5rem;
    grid-column: 1 / -1;
    grid-row: 1;
    min-inline-size: 0;
    color: inherit;
    text-decoration: none;
    border-radius: 0.5rem;
    cursor: pointer;
}
.drawer-identity {
    display: grid;
    gap: 0.375rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    grid-column: 1;
    grid-row: 2;
}
.drawer-identity strong {
    font-size: 1rem;
    font-weight: 600;
}
.account-email {
    color: var(--scova-muted);
    font-size: 0.875rem;
    font-weight: 400;
}
.drawer-account > .app-icon {
    grid-column: 2;
    grid-row: 2;
    align-self: center;
    color: var(--scova-muted);
}
.drawer-account:hover .drawer-identity strong {
    color: var(--scova-primary);
}
.avatar {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    inline-size: 3.25rem;
    block-size: 3.25rem;
    border-radius: 50%;
    background: var(--scova-selected);
    color: var(--scova-primary);
}
.trigger-avatar {
    inline-size: 2rem;
    block-size: 2rem;
    font-weight: 600;
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
    }
}
</style>
