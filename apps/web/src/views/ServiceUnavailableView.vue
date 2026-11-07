<template>
    <section class="service-unavailable" aria-labelledby="service-title">
        <p class="service-brand">知巡 Scova</p>
        <h1 id="service-title">暂时无法连接服务</h1>
        <p>请检查网络连接，或稍后重试。</p>
        <state-panel
            :state="pending ? 'loading' : 'error'"
            :message="pending ? '正在恢复账号会话' : '账号服务暂不可达，请重试'"
            retryable
            centered
            @retry="retry"
        />
    </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatePanel from '@/components/common/StatePanel.vue';
import { sessionReturnTarget, useSession } from '@/composables/useSession';

const route = useRoute();
const router = useRouter();
const session = useSession();
const pending = ref(false);
async function retry() {
    if (pending.value) return;
    pending.value = true;
    const target = sessionReturnTarget(router, route.query.redirect, true);
    try {
        await session.restore();
        if (session.phase.value === 'ready') await router.replace(target);
    } finally {
        pending.value = false;
    }
}
</script>

<style scoped>
.service-brand {
    color: var(--scova-primary);
    font-weight: 600;
}
h1 {
    font-size: clamp(1.5rem, 5vw, 2rem);
    line-height: 1.35;
    margin-block: 1.5rem 1rem;
}
p {
    line-height: 1.7;
    color: var(--scova-muted);
}
</style>
