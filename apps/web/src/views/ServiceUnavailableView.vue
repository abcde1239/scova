<template>
    <section class="service-unavailable" aria-labelledby="service-title">
        <p class="service-brand leading-[1.7] text-primary font-semibold">知巡 Scova</p>
        <h1 class="text-[clamp(1.5rem,_5vw,_2rem)] leading-[1.35] mt-6 mb-4" id="service-title">
            暂时无法连接服务
        </h1>
        <p class="leading-[1.7] text-muted">请检查网络连接，或稍后重试。</p>
        <state-panel
            :state="pending ? 'loading' : 'error'"
            :message="pending ? '正在恢复账号会话' : '账号服务暂不可达，请重试'"
            retryable
            alert
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
