<template>
    <article
        ref="root"
        class="research-report layout-stack break-anywhere w-[min(100%,_68.75rem)]"
        aria-labelledby="report-title"
    >
        <report-frame
            :report="report"
            :show-sources="showSources"
            :show-changes="showChanges"
            format="research_report"
            summary-title="报告概述"
        >
            <template #format-notice>
                <report-format-banner format="research_report" :report="report" />
            </template>
            <template #after-summary>
                <nav
                    class="report-directory scova-interface layout-grid gap-2 p-4 rounded-3 border-theme [background:color-mix(in_srgb,_var(--scova-selected)_22%,_var(--scova-surface))] [@media(max-width:_40rem)]:p-3"
                    aria-label="报告目录"
                >
                    <h2 class="text-[0.8125rem] text-muted font-semibold tracking-[0.06em] m-0">
                        报告目录
                    </h2>
                    <ol class="directory-items grid gap-x-6 list-none m-0 p-0">
                        <li v-for="(entry, index) in directory" :key="entry.id" class="min-w-0">
                            <a
                                class="directory-link title-link"
                                :href="`#${entry.id}`"
                                @click="jump($event, entry.id)"
                            >
                                <span
                                    class="directory-number flex-none text-muted text-[0.75rem] font-normal w-[1.5rem] [font-variant-numeric:tabular-nums]"
                                    aria-hidden="true"
                                    >{{
                                        entry.number ??
                                        (document ? '' : String(index + 1).padStart(2, '0'))
                                    }}</span
                                >
                                <span class="min-w-0 break-anywhere">{{ entry.title }}</span>
                            </a>
                        </li>
                    </ol>
                </nav>
            </template>
            <section
                v-for="(section, sectionIndex) in sections"
                :key="section.kind"
                :id="`section-${section.kind}`"
                class="claim-section layout-grid gap-3.5 break-anywhere [scroll-margin-block-start:6rem]"
                :aria-labelledby="`claims-${section.kind}`"
            >
                <header
                    class="flex items-baseline gap-3 pt-3 pb-3 [border-bottom:0.0625rem_solid_var(--scova-border)]"
                >
                    <span
                        class="scova-interface text-primary text-[1.25rem] font-semibold"
                        aria-hidden="true"
                    >
                        {{ String(sectionIndex + 1).padStart(2, '0') }}
                    </span>
                    <h3
                        :id="`claims-${section.kind}`"
                        class="scova-content-title keyboard-focus-wide text-[1.375rem] m-0"
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
import { computed, ref } from 'vue';
import type { Report } from '@scova/models';
import ReportFrame from '@/component/reports/ReportFrame.vue';
import ReportClaim from '@/component/reports/ReportClaim.vue';
import ReportFormatBanner from '@/component/reports/ReportFormatBanner.vue';
import { reportSections } from '@/utils/report/summary';
import { documentSectionNumbers, savedArtifactDocument } from '@/utils/report/artifacts';
const props = withDefaults(
    defineProps<{ report: Report; showChanges?: boolean; showSources?: boolean }>(),
    {
        showChanges: true,
        showSources: true,
    },
);
const sections = computed(() => reportSections(props.report));
const document = computed(() => savedArtifactDocument(props.report, 'research_report'));
const directory = computed<{ id: string; title: string; number?: number }[]>(() => [
    ...(document.value
        ? document.value.sections.map((section) => ({
              id: `document-${section.id}`,
              title: section.title,
              number: documentSectionNumbers(document.value!, 'research_report').get(section.id),
          }))
        : [
              { id: 'summary-title', title: '报告概述' },
              ...(props.report.coverage.reportValue?.questions.map((question) => ({
                  id: `question-${question.id}`,
                  title: question.text,
              })) ?? []),
              ...sections.value.map((section) => ({
                  id: `claims-${section.kind}`,
                  title: section.title,
              })),
          ]),
    ...(document.value ? [{ id: 'answers-title', title: '问题覆盖' }] : []),
    ...(props.showChanges ? [{ id: 'report-changes-title', title: '变化' }] : []),
    { id: 'coverage-title', title: '查阅与核验详情' },
    ...(props.showSources ? [{ id: 'saved-evidence-title', title: '来源与保存引用' }] : []),
]);
const root = ref<HTMLElement>();
function jump(event: MouseEvent, id: string) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = root.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    let parent = target.parentElement;
    while (parent && parent !== root.value) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
    }
    target.tabIndex = -1;
    target.style.scrollMarginBlockStart = '6rem';
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
}
</script>

<style scoped>
.directory-items {
    @apply grid-cols-[repeat(auto-fit,_minmax(min(100%,_22rem),_1fr))];
}
.directory-link {
    @apply flex items-baseline gap-3 min-h-11 min-w-0 py-2 px-2 rounded-2 text-[0.875rem] font-medium leading-[1.6]
        [@media(max-width:_40rem)]:(gap-2 px-0);
}
</style>
