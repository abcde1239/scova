<template>
    <article ref="root" class="research-report" aria-labelledby="report-title">
        <report-frame :report="report" summary-title="报告概述">
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
                        <li>
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
import { reportSections } from '@/composables/useReport';
const props = defineProps<{ report: Report }>();
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
    padding: 0.5rem 0;
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
    padding: 0;
    list-style: none;
}
.report-directory :deep(.n-button) {
    min-block-size: 2.75rem;
    height: auto;
    font-size: 1rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
.report-directory :deep(.n-button__content) {
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
