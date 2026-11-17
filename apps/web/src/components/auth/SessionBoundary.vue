<template>
    <template v-if="session.phase.value === 'ready' && (session.user.value || isPublicPage(route))">
        <slot />
    </template>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import { isPublicPage, useSession } from '@/composables/useSession';
import { useActionNotification } from '@/composables/useActionNotification';
const route = useRoute();
const session = useSession();
useActionNotification().watch(session.logoutError, 'error');
</script>
