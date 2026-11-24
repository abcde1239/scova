<template>
    <register-form @success="router.replace('/')" />
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import RegisterForm from '@/component/auth/RegisterForm.vue';
const router = useRouter();
</script>
