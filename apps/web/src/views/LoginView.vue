<template>
    <login-form @success="router.replace('/tasks')" />
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import LoginForm from '@/components/auth/LoginForm.vue';
const router = useRouter();
</script>
