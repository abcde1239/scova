<template>
    <login-form @success="router.replace(sessionReturnTarget(router, route.query.redirect))" />
    <router-link class="register-link" to="/register">注册账号</router-link>
</template>

<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router';
import LoginForm from '@/components/auth/LoginForm.vue';
import { sessionReturnTarget } from '@/composables/useSession';
const router = useRouter();
const route = useRoute();
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
