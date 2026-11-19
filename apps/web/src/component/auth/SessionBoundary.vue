<template>
    <template v-if="session.phase.value === 'ready' && (session.user.value || isPublicPage(route))">
        <slot />
    </template>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import { isPublicPage, useSession } from '@/composable/useSession';
import { useActionNotification } from '@/composable/useActionNotification';
const route = useRoute();
const session = useSession();
useActionNotification().watch(session.logoutError, 'error');
</script>
