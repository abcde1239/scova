<template>
    <div class="auth-switch">
        <span>{{ t(register ? 'auth.noAccount' : 'auth.haveAccount') }}</span>
        <router-link :to="register ? '/register' : '/login'">
            <app-icon :name="register ? 'register' : 'back'" />
            <span>{{ t(register ? 'auth.createAccount' : 'auth.backToLogin') }}</span>
        </router-link>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import AppIcon from '@/component/common/AppIcon.vue';

defineProps<{ register?: boolean }>();
const { t } = useI18n({ useScope: 'global' });
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.auth-switch {
    @apply flex flex-wrap items-center justify-center gap-1 pt-4
        [border-top:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_18%,_transparent)]
        text-muted;
}
.auth-switch a {
    @apply inline-flex items-center justify-center gap-1.5 min-w-11 min-h-11 max-w-full pt-1.5 pr-2.5
        pb-1.5 pl-2.5 rounded-2 internal-link break-anywhere cursor-pointer;
}
@media (max-width: 22rem) {
    .auth-switch a {
        @apply gap-1 pl-1 pr-1;
    }
    .auth-switch :deep(.app-icon) {
        @apply text-[1em];
    }
}
</style>
