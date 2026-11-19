<template>
    <section class="service-unavailable" aria-labelledby="service-title">
        <p class="service-brand leading-[1.7] text-primary font-semibold">{{ t('shell.brand') }}</p>
        <h1 class="text-[clamp(1.5rem,_5vw,_2rem)] leading-[1.35] mt-6 mb-4" id="service-title">
            {{ t('pages.unavailable') }}
        </h1>
        <p class="leading-[1.7] text-muted">{{ t('status.checkNetwork') }}</p>
        <state-panel
            :state="pending ? 'loading' : 'error'"
            :message="t(pending ? 'status.restoring' : 'status.accountUnavailable')"
            :retry-label="t(pending ? 'status.retrying' : 'status.retry')"
            hide-error-prefix
            retryable
            alert
            @retry="retry"
        />
        <interface-language-select class="mt-4" />
    </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import InterfaceLanguageSelect from '@/component/common/InterfaceLanguageSelect.vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatePanel from '@/component/common/StatePanel.vue';
import { sessionReturnTarget, useSession } from '@/composable/useSession';

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
const { t } = useI18n({ useScope: 'global' });
</script>
