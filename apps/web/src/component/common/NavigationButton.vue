<template>
    <router-link v-slot="{ href, navigate }" :to="to" custom>
        <n-button
            tag="a"
            v-bind="{ ...$attrs, href, 'aria-label': label }"
            class="navigation-button navigation-control"
            quaternary
            type="primary"
            @click="navigate"
        >
            <app-icon v-if="icon" :name="icon" />
            <slot />
        </n-button>
    </router-link>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { RouteLocationRaw } from 'vue-router';
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';

defineOptions({ inheritAttrs: false });
defineProps<{ to: RouteLocationRaw; icon?: IconName; label?: string }>();
</script>
