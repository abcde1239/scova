<template>
    <article
        ref="root"
        class="research-report layout-stack break-anywhere w-[min(100%,_68.75rem)] [&.research-report_.report-header]:(pb-5 [border-bottom:0.1875rem_double_var(--scova-border)]) [&.research-report_.report-summary]:(pt-3 pb-3)"
        aria-labelledby="report-title"
    >
        <report-frame :report="report" format="research_report" summary-title="报告概述">
            <template #format-notice
                ><report-format-banner format="research_report" :report="report"
            /></template>
            <template #after-summary>
                <nav
                    class="report-directory scova-interface layout-grid gap-3.5 break-anywhere border-theme rounded-1 [background:color-mix(in_srgb,_var(--scova-selected)_20%,_var(--scova-surface))] p-4 [&.report-directory_.n-button]:(min-h-11 h-auto text-[1rem] text-primary cursor-pointer pl-1 pr-1 justify-start text-start underline-offset-[0.2em]) [&.report-directory_.n-button\_\_content]:(min-w-0 whitespace-normal)"
                    aria-label="报告目录"
                >
                    <h2
                        class="[.report-directory_&:is(h2)]:([font-family:var(--scova-font-interface)] text-[1rem] font-semibold m-0)"
                    >
                        报告目录
                    </h2>
                    <ol
                        class="[.report-directory_&:is(ol)]:(grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_16rem),_1fr))] gap-[0.5rem_1rem] list-none [counter-reset:chapter] m-0 p-0)"
                    >
                        <li
                            class="[.report-directory_&:is(li)]:(flex gap-2 items-baseline min-w-0 [counter-increment:chapter]) [.report-directory_&:is(li)::before]:([content:counter(chapter,_decimal-leading-zero)] text-muted [font-variant-numeric:tabular-nums])"
                            v-for="question in report.coverage.reportValue?.questions ?? []"
                            :key="question.id"
                        >
                            <a
                                class="[.report-directory_li_>_&:is(a)]:([flex:1_1_0] min-w-0 max-w-full break-anywhere) [.report-directory_&:is(a):focus-visible]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem])"
                                :href="`#question-${question.id}`"
                                @click="jump($event, `question-${question.id}`)"
                                >{{ question.text }}</a
                            >
                        </li>
                        <li
                            class="[.report-directory_&:is(li)]:(flex gap-2 items-baseline min-w-0 [counter-increment:chapter]) [.report-directory_&:is(li)::before]:([content:counter(chapter,_decimal-leading-zero)] text-muted [font-variant-numeric:tabular-nums])"
                        >
                            <n-button
                                class="report-directory-link"
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#summary-title' }"
                                @click="jump($event, 'summary-title')"
                                >报告概述</n-button
                            >
                        </li>
                        <li
                            class="[.report-directory_&:is(li)]:(flex gap-2 items-baseline min-w-0 [counter-increment:chapter]) [.report-directory_&:is(li)::before]:([content:counter(chapter,_decimal-leading-zero)] text-muted [font-variant-numeric:tabular-nums])"
                        >
                            <n-button
                                class="report-directory-link"
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#coverage-title' }"
                                @click="jump($event, 'coverage-title')"
                                >查阅与核验详情</n-button
                            >
                        </li>
                        <li
                            class="[.report-directory_&:is(li)]:(flex gap-2 items-baseline min-w-0 [counter-increment:chapter]) [.report-directory_&:is(li)::before]:([content:counter(chapter,_decimal-leading-zero)] text-muted [font-variant-numeric:tabular-nums])"
                            v-if="showChanges"
                        >
                            <n-button
                                class="report-directory-link"
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#report-changes-title' }"
                                @click="jump($event, 'report-changes-title')"
                                >变化与基线</n-button
                            >
                        </li>
                        <li
                            class="[.report-directory_&:is(li)]:(flex gap-2 items-baseline min-w-0 [counter-increment:chapter]) [.report-directory_&:is(li)::before]:([content:counter(chapter,_decimal-leading-zero)] text-muted [font-variant-numeric:tabular-nums])"
                            v-for="section in sections"
                            :key="section.kind"
                        >
                            <n-button
                                class="report-directory-link"
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: `#claims-${section.kind}` }"
                                @click="jump($event, `claims-${section.kind}`)"
                                >{{ section.title }}</n-button
                            >
                        </li>
                        <li
                            class="[.report-directory_&:is(li)]:(flex gap-2 items-baseline min-w-0 [counter-increment:chapter]) [.report-directory_&:is(li)::before]:([content:counter(chapter,_decimal-leading-zero)] text-muted [font-variant-numeric:tabular-nums])"
                        >
                            <n-button
                                class="report-directory-link"
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
                class="claim-section layout-grid gap-3.5 break-anywhere [scroll-margin-block-start:6rem]"
                :aria-labelledby="`claims-${section.kind}`"
            >
                <header
                    class="chapter-heading flex items-baseline gap-3 pt-3 pb-3 [border-bottom:0.0625rem_solid_var(--scova-border)]"
                >
                    <span
                        class="chapter-number scova-interface text-primary text-[1.25rem] font-semibold"
                        aria-hidden="true"
                        >{{ String(sectionIndex + 1).padStart(2, '0') }}</span
                    >
                    <h3
                        :id="`claims-${section.kind}`"
                        class="scova-content-title keyboard-focus-wide [.chapter-heading_&:is(h3)]:(text-[1.375rem] m-0) [.claim-section_>_&:is(h3)]:[scroll-margin-block-start:6rem]"
                    >
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
