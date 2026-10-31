<template>
    <article ref="root" class="research-report" aria-labelledby="report-title">
        <nav class="report-directory scova-interface" aria-label="报告目录">
            <h2>报告目录</h2>
            <ol>
                <li>
                    <a href="#summary-title" @click="jump($event, 'summary-title')">报告概述</a>
                </li>
                <li>
                    <a href="#coverage-title" @click="jump($event, 'coverage-title')"
                        >查阅范围与限制</a
                    >
                </li>
                <li>
                    <a href="#report-changes-title" @click="jump($event, 'report-changes-title')"
                        >变化与基线</a
                    >
                </li>
                <li v-for="section in sections" :key="section.kind">
                    <a
                        :href="`#claims-${section.kind}`"
                        @click="jump($event, `claims-${section.kind}`)"
                        >{{ section.title }}</a
                    >
                </li>
                <li>
                    <a href="#saved-evidence-title" @click="jump($event, 'saved-evidence-title')"
                        >来源与保存引用</a
                    >
                </li>
            </ol>
        </nav>
        <report-frame :report="report" summary-title="报告概述">
            <template #format-notice>
                <p v-if="report.format !== 'brief'" class="format-notice scova-interface">
                    当前以研究报告阅读结构展示已保存内容；报告格式选择属于后续能力。
                </p>
            </template>
            <report-changes :report="report" />
            <section
                v-for="section in sections"
                :key="section.kind"
                :id="`section-${section.kind}`"
                class="claim-section"
                :aria-labelledby="`claims-${section.kind}`"
            >
                <h3 :id="`claims-${section.kind}`" class="scova-content-title">
                    {{ section.title }}
                </h3>
                <report-claim
                    v-for="claim in section.claims"
                    :key="claim.id"
                    :report="report"
                    :claim="claim"
                />
            </section>
            <section
                id="saved-evidence"
                class="evidence-appendix"
                aria-labelledby="saved-evidence-title"
            >
                <h3 id="saved-evidence-title" class="scova-content-title">来源与保存引用</h3>
                <p class="scova-interface">
                    以下按报告保存顺序列出可访问证据；孤立来源不会被猜测归入某条结论。
                </p>
                <div
                    v-for="evidence in report.evidence"
                    :id="`evidence-${evidence.id}`"
                    :key="evidence.id"
                    class="evidence-entry"
                >
                    <evidence-citation :evidence="evidence" />
                </div>
            </section>
        </report-frame>
    </article>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Report } from '@scova/models';
import ReportFrame from '@/components/reports/ReportFrame.vue';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import ReportChanges from '@/components/reports/ReportChanges.vue';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import { reportSections } from '@/composables/useReport';
const props = defineProps<{ report: Report }>();
const sections = computed(() => reportSections(props.report));
const root = ref<HTMLElement>();
function jump(event: MouseEvent, id: string) {
    event.preventDefault();
    const target = root.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    target.tabIndex = -1;
    target.style.scrollMarginBlockStart = '6rem';
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
}
onMounted(() => {
    for (const id of [
        'summary-title',
        'coverage-title',
        'report-changes-title',
        'saved-evidence-title',
        ...sections.value.map((section) => `claims-${section.kind}`),
    ])
        root.value
            ?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
            ?.setAttribute('tabindex', '-1');
});
</script>

<style scoped>
.research-report,
.report-directory,
.claim-section,
.evidence-appendix {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.research-report {
    inline-size: min(100%, 68.75rem);
    gap: 2rem;
}
.report-directory {
    padding: 1rem 1.25rem;
    border-block: 0.0625rem solid var(--scova-border);
}
.report-directory h2 {
    margin: 0;
    font-family: var(--scova-font-interface);
    font-size: 1rem;
    font-weight: 600;
}
.report-directory ol {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    margin: 0;
    padding-inline-start: 1.25rem;
}
.report-directory a {
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
.report-directory a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.format-notice {
    margin: 0;
}
.claim-section,
.evidence-appendix {
    scroll-margin-block-start: 6rem;
}
.claim-section > h3,
.evidence-appendix > h3 {
    scroll-margin-block-start: 6rem;
}
.evidence-appendix {
    padding-block: 2rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
.evidence-entry {
    min-inline-size: 0;
    scroll-margin-block-start: 6rem;
}
h3:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
@media (max-width: 40rem) {
    .evidence-entry :deep(summary),
    .evidence-entry :deep(.evidence-body),
    .evidence-entry :deep(blockquote) {
        padding-inline: 0.5rem;
    }
}
</style>
