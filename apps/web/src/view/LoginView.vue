<template>
    <login-form @success="router.replace(sessionReturnTarget(router, route.query.redirect))" />
    <auth-switch-link class="register-link [&&]:mt-6" register />
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import LoginForm from '@/component/auth/LoginForm.vue';
import AuthSwitchLink from '@/component/auth/AuthSwitchLink.vue';
import { sessionReturnTarget } from '@/composable/useSession';
const router = useRouter();
const route = useRoute();
</script>
