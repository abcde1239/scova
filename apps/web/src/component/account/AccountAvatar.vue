<template>
    <span
        class="account-avatar inline-grid place-items-center shrink-0 w-8 h-8 overflow-hidden rounded-[50%] [background:var(--scova-selected)] text-primary font-semibold"
        aria-hidden="true"
    >
        <img
            class="w-full h-full [object-fit:cover]"
            v-if="renderedSource"
            :src="renderedSource"
            alt=""
            referrerpolicy="no-referrer"
            @error="handleError"
        />
        <span v-else>{{ email?.slice(0, 1).toUpperCase() || '?' }}</span>
    </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { avatarImageUrl } from '@/api/avatar';
const props = defineProps<{ email?: string; version?: string | null; preview?: string }>();
const defaultAvatarUrl = '/default-avatar.webp';
const failed = ref(false);
const defaultFailed = ref(false);
const source = computed(
    () => props.preview || (props.version ? avatarImageUrl(props.version) : defaultAvatarUrl),
);
const renderedSource = computed(() => {
    const fallback = failed.value || source.value === defaultAvatarUrl;
    return fallback ? (defaultFailed.value ? '' : defaultAvatarUrl) : source.value;
});
function handleError(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    if (image.getAttribute('src') !== renderedSource.value) return;
    if (renderedSource.value === defaultAvatarUrl) defaultFailed.value = true;
    else failed.value = true;
}
watch(
    () => [source.value, props.email],
    () => {
        failed.value = false;
        defaultFailed.value = false;
    },
);
</script>
