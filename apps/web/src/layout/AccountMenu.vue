<template>
    <div
        v-if="session.user.value && session.phase.value === 'ready'"
        ref="root"
        class="account-menu relative min-w-0 [@media(max-width:_53.999rem)]:hidden"
        :class="{ 'account-menu--compact': compact }"
        @pointerenter="enter"
        @pointerleave="leave"
        @focusout="blur"
        @keydown.esc.stop.prevent="close(true)"
        @keydown="keydown"
    >
        <n-button quaternary class="account-trigger" v-bind="triggerAccessibility" @click="toggle">
            <account-avatar
                :email="session.user.value.email"
                :version="session.user.value.avatarVersion"
            />
            <span v-if="!compact" class="account-email truncate">{{
                session.user.value.email
            }}</span>
            <app-icon v-if="!compact" class="account-chevron" name="expand" />
        </n-button>
        <nav
            v-if="open"
            :id="panelId"
            class="account-panel"
            :aria-label="t('shell.accountActions')"
            @click="navigateInside"
        >
            <div class="account-identity layout-grid gap-1.5 pt-2 pb-3.5 px-2">
                <span class="identity-label text-muted">{{ t('shell.currentAccount') }}</span>
                <strong class="[.account-identity_&:is(strong)]:(text-[1rem] font-medium)">{{
                    session.user.value.email
                }}</strong>
            </div>
            <navigation-button to="/account" icon="account">{{
                t('pages.account')
            }}</navigation-button>
            <navigation-button to="/account/agent" icon="settings">{{
                t('pages.agent')
            }}</navigation-button>
            <navigation-button to="/account/appearance" icon="appearance">{{
                t('pages.appearance')
            }}</navigation-button>
            <action-button
                quaternary
                class="logout-action [&&]:(mt-2 [border:0] bg-transparent)"
                :busy="session.logoutPending.value"
                @click="session.logout"
            >
                <app-icon name="logout" />{{ t('shell.logout') }}
            </action-button>
        </nav>
    </div>
    <navigation-button
        v-else-if="session.phase.value === 'ready'"
        class="account-login [@media(max-width:_53.999rem)]:[&&]:hidden"
        to="/login"
        icon="account"
        :label="t('pages.login')"
        v-bind="{ title: compact ? t('pages.login') : undefined }"
        >{{ compact ? '' : t('pages.login') }}</navigation-button
    >
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useRoute } from 'vue-router';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import NavigationButton from '@/component/common/NavigationButton.vue';
import { useSession } from '@/composable/useSession';
import AccountAvatar from '@/component/account/AccountAvatar.vue';

const session = useSession();
const route = useRoute();
const props = defineProps<{ compact?: boolean }>();
const { t } = useI18n({ useScope: 'global' });

const root = ref<HTMLElement>();
const open = ref(false);
const panelId = `account-panel-${useId()}`;
const triggerAccessibility = computed(() => ({
    'aria-label': t('shell.accountMenu'),
    'aria-current': route.meta.section === 'account' ? 'true' : undefined,
    'aria-expanded': open.value,
    'aria-controls': panelId,
    title: props.compact ? t('shell.accountMenu') : undefined,
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
.account-menu .account-trigger {
    @apply w-full min-w-0 min-h-11 h-auto justify-start py-1.5 px-2 rounded-2 text-[0.875rem]
        keyboard-focus-inset;
}
.account-trigger :deep(.n-button__content) {
    @apply grid grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-2 w-full min-w-0 text-start;
}
.account-menu--compact .account-trigger {
    @apply px-0;
}
.account-menu--compact .account-trigger :deep(.n-button__content) {
    @apply flex justify-center;
}
.account-chevron {
    @apply rotate-180 text-muted;
}
.account-panel {
    @apply absolute bottom-full [inset-inline-start:0] z-[20] grid grid-cols-[minmax(0,_1fr)] gap-1
        w-[min(19rem,_calc(100vw_-_2rem))] max-h-[calc(100dvh_-_5rem)] [overflow-y:auto]
        [overscroll-behavior:contain] border-theme rounded-3 bg-surface break-anywhere p-3
        [box-shadow:0_0.5rem_1.5rem_color-mix(in_srgb,_var(--scova-text)_12%,_transparent)];
}
.account-panel :deep(.n-button) {
    @apply justify-start w-full min-h-11 h-auto whitespace-normal;
}
</style>
