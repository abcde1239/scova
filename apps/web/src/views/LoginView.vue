<template>
    <login-form @success="router.replace('/tasks')" />
    <router-link class="register-link" to="/register">注册账号</router-link>
</template>

<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router';
import LoginForm from '@/components/auth/LoginForm.vue';
const router = useRouter();
</script>

<style scoped>
.register-link {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    margin-block-start: 1rem;
    color: var(--scova-primary);
    cursor: pointer;
}
.register-link:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
