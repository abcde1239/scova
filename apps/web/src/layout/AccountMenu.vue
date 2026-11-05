<template>
    <div
        v-if="session.user.value && session.phase.value === 'ready'"
        ref="root"
        class="account-menu"
        @pointerenter="enter"
        @pointerleave="leave"
        @focusout="blur"
        @keydown.esc.stop.prevent="close(true)"
        @keydown="keydown"
    >
        <n-button
            quaternary
            circle
            class="account-trigger"
            v-bind="triggerAccessibility"
            @click="toggle"
        >
            <span class="avatar" aria-hidden="true">{{ initial }}</span>
        </n-button>
        <nav
            v-if="open"
            :id="panelId"
            class="account-panel"
            aria-label="账号操作"
            @click="navigateInside"
        >
            <div class="account-identity">
                <span class="identity-label">当前账号</span>
                <strong>{{ session.user.value.email }}</strong>
            </div>
            <navigation-button to="/account" icon="account">账号</navigation-button>
            <navigation-button to="/account/agent" icon="settings">Agent 配置</navigation-button>
            <navigation-button to="/account/appearance" icon="appearance">外观</navigation-button>
            <action-button
                quaternary
                class="logout-action"
                :busy="session.logoutPending.value"
                @click="session.logout"
            >
                <app-icon name="logout" />退出登录
            </action-button>
        </nav>
    </div>
    <navigation-button
        v-else-if="session.phase.value === 'ready'"
        class="account-login"
        to="/login"
        icon="account"
        >登录</navigation-button
    >
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useRoute } from 'vue-router';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import NavigationButton from '@/components/common/NavigationButton.vue';
import { useSession } from '@/composables/useSession';

const session = useSession();
const route = useRoute();
const root = ref<HTMLElement>();
const open = ref(false);
const initial = computed(() => session.user.value?.email.slice(0, 1).toUpperCase());
const panelId = `account-panel-${useId()}`;
const triggerAccessibility = computed(() => ({
    'aria-label': '账号菜单',
    'aria-current': route.meta.section === 'account' ? 'true' : undefined,
    'aria-expanded': open.value,
    'aria-controls': panelId,
}));
let pinned = false;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
let media: MediaQueryList | undefined;

function cancelLeave() {
    clearTimeout(leaveTimer);
}
function close(returnFocus = false) {
    cancelLeave();
    pinned = false;
    open.value = false;
    if (returnFocus) void nextTick(() => root.value?.querySelector('button')?.focus());
}
function toggle() {
    cancelLeave();
    pinned = !pinned;
    open.value = pinned;
}
function enter(event: PointerEvent) {
    cancelLeave();
    if (event.pointerType === 'mouse' && matchMedia('(hover: hover) and (pointer: fine)').matches)
        open.value = true;
}
function leave() {
    cancelLeave();
    leaveTimer = setTimeout(() => {
        if (!pinned && !root.value?.contains(document.activeElement)) close();
    }, 150);
}
function blur(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget))
        close();
}
function outside(event: PointerEvent) {
    if (event.target instanceof Node && !root.value?.contains(event.target)) close();
}
async function openAndFocus() {
    cancelLeave();
    pinned = true;
    open.value = true;
    await nextTick();
    root.value?.querySelector<HTMLAnchorElement>('nav a')?.focus();
}
function navigateInside(event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
        return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor) return;
    const path = new URL(anchor.href).pathname;
    close();
    if (route.path === path) void nextTick(() => document.getElementById('main-content')?.focus());
}
function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' && event.target === root.value?.querySelector('button')) {
        event.preventDefault();
        void openAndFocus();
    }
}
watch(
    () => [route.fullPath, session.user.value?.id, session.phase.value],
    () => close(),
);
onMounted(() => {
    document.addEventListener('pointerdown', outside);
    media = matchMedia('(max-width: 53.999rem)');
    media.addEventListener('change', closeForResize);
});
function closeForResize() {
    const focusedInside = root.value?.contains(document.activeElement);
    close();
    if (focusedInside) document.getElementById('main-content')?.focus();
}
onUnmounted(() => {
    cancelLeave();
    document.removeEventListener('pointerdown', outside);
    media?.removeEventListener('change', closeForResize);
});
</script>

<style scoped>
.account-menu {
    position: relative;
    flex-shrink: 0;
}
.account-trigger {
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    height: auto;
}
.avatar {
    display: grid;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    border-radius: 50%;
    background: var(--scova-selected);
    color: var(--scova-primary);
    font-size: 1rem;
    font-weight: 600;
}
.account-trigger:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
.account-panel {
    position: absolute;
    inset-block-start: 100%;
    inset-inline-end: 0;
    z-index: 20;
    display: grid;
    gap: 0.25rem;
    inline-size: min(19rem, calc(100vw - 2rem));
    padding: 0.75rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    background: var(--scova-surface);
    overflow-wrap: anywhere;
}
.account-identity {
    display: grid;
    gap: 0.375rem;
    min-inline-size: 0;
    padding: 0.5rem 0.5rem 0.875rem;
}
.identity-label {
    color: var(--scova-muted);
}
.account-identity strong {
    font-size: 1rem;
    font-weight: 500;
}
.account-panel :deep(.n-button) {
    justify-content: start;
    inline-size: 100%;
    min-block-size: 2.75rem;
    height: auto;
    white-space: normal;
}
.logout-action {
    margin-block-start: 0.5rem;
    border: 0;
    background: transparent;
}
@media (max-width: 53.999rem) {
    .account-menu,
    .account-login {
        display: none;
    }
}
</style>
