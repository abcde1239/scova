<template>
    <span
        class="app-icon inline-flex flex-none text-[1.25em] [color:currentColor] cursor-inherit [vertical-align:middle]"
        aria-hidden="true"
    >
        <n-icon :component="icons[name]" />
    </span>
</template>

<script setup lang="ts">
import { NIcon } from 'naive-ui';
import { icons, type IconName } from '@/components/common/icons';

defineProps<{ name: IconName }>();
</script>
