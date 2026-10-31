<template>
    <login-form @success="router.replace(sessionReturnTarget(router, route.query.redirect))" />
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import LoginForm from '@/components/auth/LoginForm.vue';
import { sessionReturnTarget } from '@/composables/useSession';
const router = useRouter();
const route = useRoute();
</script>
