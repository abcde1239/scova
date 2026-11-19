<script setup lang="ts">
import { onScopeDispose, watch } from 'vue';
import { useNotification } from 'naive-ui';
import { useSessionLifecycle } from '@/composable/useSessionQuery';

const notification = useNotification();
const lifecycle = useSessionLifecycle();
watch(
    () => lifecycle.session.epoch,
    () => notification.destroyAll(),
    { flush: 'sync' },
);
onScopeDispose(() => notification.destroyAll());
</script>

<template><slot /></template>
