<template>
    <div class="auth-switch">
        <span>{{ register ? '还没有账号？' : '已有账号？' }}</span>
        <router-link :to="register ? '/register' : '/login'">
            <app-icon :name="register ? 'register' : 'back'" />
            <span>{{ register ? '注册账号' : '返回登录' }}</span>
        </router-link>
    </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';

defineProps<{ register?: boolean }>();
</script>

<style scoped>
.auth-switch {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding-block-start: 1rem;
    border-block-start: 0.0625rem solid color-mix(in srgb, var(--scova-border) 18%, transparent);
    color: var(--scova-muted);
}
.auth-switch a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    padding: 0.375rem 0.625rem;
    border-radius: 0.5rem;
    color: var(--scova-primary);
    text-decoration: none;
    overflow-wrap: anywhere;
    cursor: pointer;
}
.auth-switch a:hover {
    background: var(--scova-selected);
    text-decoration: underline;
    text-underline-offset: 0.2em;
}
.auth-switch a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
@media (max-width: 22rem) {
    .auth-switch a {
        gap: 0.25rem;
        padding-inline: 0.25rem;
    }
    .auth-switch :deep(.app-icon) {
        font-size: 1em;
    }
}
</style>
