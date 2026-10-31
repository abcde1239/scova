<template>
    <register-form @success="router.replace('/tasks')" />
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import RegisterForm from '@/components/auth/RegisterForm.vue';
const router = useRouter();
</script>
