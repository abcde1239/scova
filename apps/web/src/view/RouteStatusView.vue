<template>
    <template v-if="route.name === 'appearance'">
        <appearance-selector />
        <reading-preferences />
    </template>
    <div v-else class="route-status grid [justify-items:start] gap-6 text-muted">
        <p v-if="route.name === 'not-found'">{{ t('status.notFound') }}</p>
        <p v-else>{{ t('status.pendingPage', { page: routeTitle(route, t) }) }}</p>
        <navigation-button v-if="route.name === 'account'" to="/account/appearance">
            {{ t('status.appearance') }}
        </navigation-button>
        <navigation-button v-if="route.name === 'not-found'" to="/tasks">{{
            t('status.backToTasks')
        }}</navigation-button>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { routeTitle } from '@/router';
import NavigationButton from '@/component/common/NavigationButton.vue';
import { useRoute } from 'vue-router';
import AppearanceSelector from '@/component/common/AppearanceSelector.vue';
import ReadingPreferences from '@/component/common/ReadingPreferences.vue';

const route = useRoute();
const { t } = useI18n({ useScope: 'global' });
</script>
