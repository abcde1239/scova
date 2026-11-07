<template>
    <login-form @success="router.replace(sessionReturnTarget(router, route.query.redirect))" />
    <auth-switch-link class="register-link" register />
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import LoginForm from '@/components/auth/LoginForm.vue';
import AuthSwitchLink from '@/components/auth/AuthSwitchLink.vue';
import { sessionReturnTarget } from '@/composables/useSession';
const router = useRouter();
const route = useRoute();
</script>

<style scoped>
.register-link {
    margin-block-start: 1.5rem;
}
</style>
