<template>
    <section
        id="saved-evidence"
        class="evidence-appendix layout-grid gap-3.5 break-anywhere pt-4 pb-0 [border-top:0.0625rem_solid_var(--scova-border)] [scroll-margin-block-start:6rem]"
        aria-labelledby="saved-evidence-title"
    >
        <h3
            id="saved-evidence-title"
            class="scova-content-title text-[1.25rem] font-semibold m-0 keyboard-focus-wide [.evidence-appendix_>_&:is(h3)]:[scroll-margin-block-start:6rem]"
        >
            来源与保存引用
        </h3>
        <p class="scova-interface m-0">
            每份来源集中保存引用，展开即可核对原文；不同保存版本分别列出。
        </p>
        <evidence-source-group
            v-for="group in groups"
            :key="group.key"
            :evidence="group.evidence"
        />
    </section>
</template>

<script setup lang="ts">
import type { Report } from '@scova/models';
import { computed } from 'vue';
import EvidenceSourceGroup from '@/components/reports/EvidenceSourceGroup.vue';
import { groupEvidence } from '@/utils/evidence-groups';
const props = defineProps<{ report: Report }>();
const groups = computed(() => groupEvidence(props.report.evidence));
</script>
