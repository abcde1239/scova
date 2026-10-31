<template>
    <state-panel
        v-if="session.phase.value === 'initial' || session.phase.value === 'recovering'"
        state="loading"
        message="正在恢复账号会话"
    />
    <state-panel
        v-else-if="session.phase.value === 'unavailable' && !isPublicPage(route)"
        state="error"
        message="账号服务暂不可达，请重试"
        retryable
        @retry="retry"
    />
    <template v-else-if="session.user.value || isPublicPage(route)">
        <p v-if="session.logoutError.value" role="alert" class="session-error">
            {{ session.logoutError.value }}
        </p>
        <slot />
    </template>
</template>

<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute } from 'vue-router';
import StatePanel from '@/components/common/StatePanel.vue';
import { isPublicPage, useSession } from '@/composables/useSession';
const route = useRoute();
const session = useSession();
async function retry() {
    const previous = document.activeElement;
    await session.restore();
    await nextTick();
    if (previous && !previous.isConnected && document.activeElement === document.body)
        document.getElementById('main-content')?.focus();
}
</script>

<style scoped>
.session-error {
    margin-block: 0 1.5rem;
    color: var(--scova-danger);
    overflow-wrap: anywhere;
}
</style>
