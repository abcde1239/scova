<template>
    <details
        class="tool-section min-w-0 [border-top:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)]"
    >
        <summary
            class="flex items-center gap-2 min-w-0 min-h-11 justify-between pt-2 pb-2 cursor-pointer list-none font-medium [&:is(summary)::-webkit-details-marker]:hidden focus-visible:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
        >
            <span class="[summary_&:is(span)]:(flex items-center gap-2 min-w-0)"
                ><app-icon
                    class="[summary_&:is(span)]:(flex items-center gap-2 min-w-0)"
                    :name="icon"
                />{{ label }}</span
            >
            <app-icon
                class="disclosure [summary_&:is(span)]:(flex items-center gap-2 min-w-0) [&&]:shrink-0 [.tool-section[open]_>_summary_&.disclosure]:[transform:rotate(180deg)]"
                name="expand"
            />
        </summary>
        <div class="tool-section-body min-w-0 pt-2 pb-4"><slot /></div>
    </details>
</template>

<script setup lang="ts">
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';
defineProps<{ label: string; icon: IconName }>();
</script>
