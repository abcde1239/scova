<template>
    <template v-if="session.phase.value === 'ready' && (session.user.value || isPublicPage(route))">
        <p
            v-if="session.logoutError.value"
            role="alert"
            class="session-error mt-0 mb-6 text-danger break-anywhere"
        >
            {{ session.logoutError.value }}
        </p>
        <slot />
    </template>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import { isPublicPage, useSession } from '@/composables/useSession';
const route = useRoute();
const session = useSession();
</script>
