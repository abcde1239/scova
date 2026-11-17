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
            <account-avatar
                v-if="signedIn"
                class="trigger-avatar"
                :email="session.user.value?.email"
                :version="session.user.value?.avatarVersion"
            />
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
                        <account-avatar
                            class="avatar"
                            :email="session.user.value?.email"
                            :version="session.user.value?.avatarVersion"
                        />
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
import AccountAvatar from '@/components/account/AccountAvatar.vue';

defineProps<{ items: { path: string; label: string; icon: IconName }[] }>();
const route = useRoute();
const session = useSession();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLDialogElement>();
const open = ref(false);
const panelId = `mobile-menu-${useId()}`;
const signedIn = computed(() => !!session.user.value && session.phase.value === 'ready');
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
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.mobile-navigation {
    @apply hidden;
}

.menu-trigger,
.close-trigger,
.menu-panel a {
    @apply font-inherit inline-flex items-center gap-[0.625em] min-h-11 min-w-11 pt-2.5 pr-3.5 pb-2.5
        pl-3.5 [border:0] rounded-1.5 text-inherit bg-transparent no-underline cursor-pointer;
}
.menu-trigger {
    @apply justify-center rounded-[50%] p-1.5;
}
.mobile-drawer {
    @apply fixed [inset-block:0] [inset-inline:0_auto] w-[min(22rem,_calc(100%_-_2rem))] max-w-full
        h-[100dvh] max-h-[100dvh] [border:0] bg-surface text-default [overflow-y:auto]
        [overscroll-behavior:contain] [transform:translateX(0)] [transition:transform_0.18s_ease-out]
        m-0 p-0;
}
@starting-style {
    .mobile-drawer[open] {
        @apply [transform:translateX(-100%)];
    }
}
@media (prefers-reduced-motion: reduce) {
    .mobile-drawer {
        @apply [transition:none];
    }
}
.mobile-drawer::backdrop {
    @apply [background:rgb(0_0_0_/_28%)];
}
.drawer-content {
    @apply flex flex-col gap-4 min-h-full min-w-0 pt-[max(1rem,_env(safe-area-inset-top))] pr-4
        pb-[max(1rem,_env(safe-area-inset-bottom))] pl-4;
}
.drawer-heading {
    @apply grid grid-cols-[minmax(0,_1fr)_auto] items-center gap-3 font-semibold;
}
.close-trigger {
    @apply justify-center shrink-0 ml-auto [grid-column:2] [grid-row:1] [align-self:start] p-2.5;
}
.drawer-account {
    @apply layout-grid grid-cols-[minmax(0,_1fr)_auto] gap-[0.75rem_0.5rem] col-span-full [grid-row:1]
        text-inherit no-underline rounded-2 cursor-pointer;
}
.drawer-identity {
    @apply layout-grid gap-1.5 break-anywhere [grid-column:1] [grid-row:2];
}
.drawer-identity strong {
    @apply text-[1rem] font-semibold;
}
.account-email {
    @apply text-muted text-[0.875rem] font-normal;
}
.drawer-account > .app-icon {
    @apply [grid-column:2] [grid-row:2] [align-self:center] text-muted;
}
.drawer-account:hover .drawer-identity strong {
    @apply text-primary;
}
.avatar {
    @apply grid place-items-center shrink-0 w-[3.25rem] h-[3.25rem] rounded-[50%]
        [background:var(--scova-selected)] text-primary;
}
.trigger-avatar {
    @apply w-8 h-8 font-semibold;
}
.menu-panel {
    @apply grid gap-1;
}
.drawer-footer {
    @apply grid gap-2 pt-2
        [border-top:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)];
}
.drawer-footer :deep(.n-button) {
    @apply justify-start [border:0] bg-transparent;
}
.logout-error {
    @apply text-danger break-anywhere;
}
.menu-panel a[aria-current='page'],
.menu-panel a:hover,
.menu-trigger:hover,
.close-trigger:hover {
    @apply [background:var(--scova-selected)] text-primary;
}
.menu-panel a[aria-current='page'] {
    @apply font-semibold;
}
a:focus-visible,
button:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem];
}
@media (max-width: 53.999rem) {
    .mobile-navigation {
        @apply block;
    }
}
</style>
