<template>
    <article ref="root" class="research-report" aria-labelledby="report-title">
        <report-frame :report="report" format="research_report" summary-title="报告概述">
            <template #format-notice
                ><report-format-banner format="research_report" :report="report"
            /></template>
            <template #after-summary>
                <nav class="report-directory scova-interface" aria-label="报告目录">
                    <h2>报告目录</h2>
                    <ol>
                        <li
                            v-for="question in report.coverage.reportValue?.questions ?? []"
                            :key="question.id"
                        >
                            <a
                                :href="`#question-${question.id}`"
                                @click="jump($event, `question-${question.id}`)"
                                >{{ question.text }}</a
                            >
                        </li>
                        <li>
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#summary-title' }"
                                @click="jump($event, 'summary-title')"
                                >报告概述</n-button
                            >
                        </li>
                        <li>
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#coverage-title' }"
                                @click="jump($event, 'coverage-title')"
                                >查阅范围与限制</n-button
                            >
                        </li>
                        <li v-if="showChanges">
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#report-changes-title' }"
                                @click="jump($event, 'report-changes-title')"
                                >变化与基线</n-button
                            >
                        </li>
                        <li v-for="section in sections" :key="section.kind">
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: `#claims-${section.kind}` }"
                                @click="jump($event, `claims-${section.kind}`)"
                                >{{ section.title }}</n-button
                            >
                        </li>
                        <li>
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#saved-evidence-title' }"
                                @click="jump($event, 'saved-evidence-title')"
                                >来源与保存引用</n-button
                            >
                        </li>
                    </ol>
                </nav>
            </template>
            <report-changes v-if="showChanges" :report="report" />
            <section
                v-for="(section, sectionIndex) in sections"
                :key="section.kind"
                :id="`section-${section.kind}`"
                class="claim-section"
                :aria-labelledby="`claims-${section.kind}`"
            >
                <header class="chapter-heading">
                    <span class="chapter-number scova-interface" aria-hidden="true">{{
                        String(sectionIndex + 1).padStart(2, '0')
                    }}</span>
                    <h3 :id="`claims-${section.kind}`" class="scova-content-title">
                        {{ section.title }}
                    </h3>
                </header>
                <report-claim
                    v-for="claim in section.claims"
                    :key="claim.id"
                    :report="report"
                    :claim="claim"
                />
            </section>
        </report-frame>
    </article>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import type { Report } from '@scova/models';
import ReportFrame from '@/components/reports/ReportFrame.vue';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import ReportChanges from '@/components/reports/ReportChanges.vue';
import ReportFormatBanner from '@/components/reports/ReportFormatBanner.vue';
import { reportSections } from '@/composables/useReport';
const props = withDefaults(defineProps<{ report: Report; showChanges?: boolean }>(), {
    showChanges: true,
});
const sections = computed(() => reportSections(props.report));
const root = ref<HTMLElement>();
function jump(event: MouseEvent, id: string) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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
.claim-section {
    display: grid;
    gap: 0.875rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.research-report {
    inline-size: min(100%, 68.75rem);
    gap: 1rem;
}
.report-directory {
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--scova-selected) 20%, var(--scova-surface));
}
.report-directory h2 {
    margin: 0;
    font-family: var(--scova-font-interface);
    font-size: 1rem;
    font-weight: 600;
}
.report-directory ol {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 0.5rem 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: chapter;
}
.report-directory li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    min-inline-size: 0;
    counter-increment: chapter;
}
.report-directory li::before {
    content: counter(chapter, decimal-leading-zero);
    color: var(--scova-muted);
    font-variant-numeric: tabular-nums;
}
.report-directory li > a {
    flex: 1 1 0;
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-wrap: anywhere;
}
.chapter-heading {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding-block: 0.75rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
.chapter-heading h3 {
    margin: 0;
    font-size: 1.375rem;
}
.chapter-number {
    color: var(--scova-primary);
    font-size: 1.25rem;
    font-weight: 600;
}
.research-report :deep(.report-header) {
    padding-block-end: 1.25rem;
    border-block-end: 0.1875rem double var(--scova-border);
}
.research-report :deep(.report-summary) {
    padding-block: 0.75rem;
}
.report-directory :deep(.n-button) {
    min-block-size: 2.75rem;
    height: auto;
    font-size: 1rem;
    color: var(--scova-primary);
    cursor: pointer;
    padding-inline: 0.25rem;
    justify-content: start;
    text-align: start;
    text-underline-offset: 0.2em;
}
.report-directory :deep(.n-button__content) {
    min-inline-size: 0;
    white-space: normal;
}
.report-directory a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.claim-section {
    scroll-margin-block-start: 6rem;
}
.claim-section > h3 {
    scroll-margin-block-start: 6rem;
}
h3:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
