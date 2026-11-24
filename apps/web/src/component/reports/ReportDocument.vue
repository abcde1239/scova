<template>
    <div
        class="report-document layout-grid break-anywhere"
        :class="[`report-document--${format}`, format === 'research_report' ? 'gap-10' : 'gap-6']"
    >
        <slot v-if="!startsWithOverview" name="navigation" />
        <template v-for="(block, blockIndex) in blocks" :key="block.section.id">
            <section
                class="document-section report-grid [scroll-margin-block-start:6rem]"
                :class="sectionClass(block)"
                :aria-labelledby="`document-${block.section.id}`"
            >
                <h3
                    :id="`document-${block.section.id}`"
                    class="document-title scova-content-title m-0 keyboard-focus-wide [scroll-margin-block-start:6rem] flex items-baseline gap-3"
                    :class="titleClass(block)"
                    tabindex="-1"
                >
                    <span
                        v-if="numbers.get(block.section.id)"
                        class="section-number scova-interface text-primary font-semibold [font-variant-numeric:tabular-nums]"
                        aria-hidden="true"
                        >{{ numbers.get(block.section.id) }}</span
                    >
                    {{ block.section.title }}
                </h3>
                <component
                    :is="listTag(block.section)"
                    class="document-paragraphs report-grid m-0 p-0"
                    :class="listClass(block.section)"
                >
                    <component
                        :is="listTag(block.section) === 'div' ? 'div' : 'li'"
                        v-for="index in block.section.claimIndexes"
                        :key="index"
                        class="document-item min-w-0"
                    >
                        <report-claim
                            :report="report"
                            :claim="report.claims[index]!"
                            :lead="format === 'brief' && block.section.role === 'key_findings'"
                            compact
                        />
                        <p
                            v-if="
                                assessment(index)?.conditions &&
                                !claimIncludes(index, assessment(index)!.conditions)
                            "
                            class="document-condition scova-reading mt-3 mb-0 pl-4 border-subtle [border-block:0] [border-right:0]"
                        >
                            {{ assessment(index)?.conditions }}
                        </p>
                        <p
                            v-if="
                                assessment(index)?.gap &&
                                !claimIncludes(index, assessment(index)!.gap)
                            "
                            class="document-gap scova-interface text-muted mt-2 mb-0"
                        >
                            {{ assessment(index)?.gap }}
                        </p>
                    </component>
                </component>
                <div v-if="block.findings" class="summary-findings report-grid gap-3">
                    <h4
                        :id="`document-${block.findings.id}`"
                        class="scova-interface text-[0.9375rem] font-semibold m-0 keyboard-focus-wide"
                        tabindex="-1"
                    >
                        {{ block.findings.title }}
                    </h4>
                    <ul class="report-grid gap-2 m-0 pl-5">
                        <li
                            v-for="index in block.findings.claimIndexes"
                            :key="index"
                            class="min-w-0"
                        >
                            <report-claim :report="report" :claim="report.claims[index]!" compact />
                            <p
                                v-if="
                                    assessment(index)?.conditions &&
                                    !claimIncludes(index, assessment(index)!.conditions)
                                "
                                class="document-condition scova-reading mt-3 mb-0 pl-4 border-subtle [border-block:0] [border-right:0]"
                            >
                                {{ assessment(index)?.conditions }}
                            </p>
                            <p
                                v-if="
                                    assessment(index)?.gap &&
                                    !claimIncludes(index, assessment(index)!.gap)
                                "
                                class="document-gap scova-interface text-muted mt-2 mb-0"
                            >
                                {{ assessment(index)?.gap }}
                            </p>
                        </li>
                    </ul>
                </div>
            </section>
            <slot v-if="blockIndex === 0 && startsWithOverview" name="navigation" />
        </template>
        <section
            v-if="format === 'research_report' && showMethod"
            class="document-method scova-interface report-grid gap-3 pt-6 [border-top:0.0625rem_solid_var(--scova-border)]"
            aria-labelledby="document-method-title"
        >
            <h3 id="document-method-title" class="scova-content-title text-[1.125rem] m-0">方法</h3>
            <dl class="grid grid-cols-[auto_minmax(0,_1fr)] gap-x-6 gap-y-2 m-0">
                <template v-for="item in method" :key="item.label">
                    <dt class="text-muted">{{ item.label }}</dt>
                    <dd class="m-0">{{ item.value }}</dd>
                </template>
            </dl>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ArtifactDocument, Report } from '@scova/models';
import ReportClaim from '@/component/reports/ReportClaim.vue';
import { documentSectionNumbers } from '@/utils/report/artifacts';
import { groupEvidence } from '@/utils/report/sources';

type Section = ArtifactDocument['sections'][number];
type Block = { section: Section; findings?: Section };

const props = withDefaults(
    defineProps<{
        report: Report;
        document: ArtifactDocument;
        format: Report['format'];
        showMethod?: boolean;
    }>(),
    { showMethod: true },
);
const startsWithOverview = computed(() => props.document.sections[0]?.role === 'overview');
const numbers = computed(() => documentSectionNumbers(props.document, props.format));
// A research abstract carries its main conclusions in the same box.
const blocks = computed<Block[]>(() => {
    const sections = props.document.sections;
    const result: Block[] = [];
    for (let index = 0; index < sections.length; index++) {
        const section = sections[index]!;
        const next = sections[index + 1];
        if (
            props.format === 'research_report' &&
            section.role === 'overview' &&
            next?.role === 'key_findings'
        ) {
            result.push({ section, findings: next });
            index++;
        } else result.push({ section });
    }
    return result;
});
const leadCard = (block: Block) =>
    block.section.role === 'overview' && props.format !== 'research_report';
function sectionClass(block: Block) {
    const role = block.section.role;
    if (leadCard(block))
        return 'document-lead gap-2 rounded-3 [border-left:0.25rem_solid_var(--scova-primary)] [background:var(--scova-selected)] py-5 px-6 [@media(max-width:_40rem)]:(py-4 px-4)';
    if (role === 'overview')
        return 'document-abstract gap-4 rounded-3 border-theme [background:color-mix(in_srgb,_var(--scova-selected)_35%,_var(--scova-surface))] py-6 px-6 [@media(max-width:_40rem)]:(py-4 px-4)';
    if (role === 'limitations' && props.format !== 'research_report')
        return 'document-caution gap-2 rounded-3 border-theme py-4 px-5';
    return '';
}
function titleClass(block: Block) {
    if (
        leadCard(block) ||
        (block.section.role === 'limitations' && props.format !== 'research_report')
    )
        return 'scova-interface text-[0.875rem] text-primary font-semibold tracking-[0.04em]';
    return props.format === 'research_report' ? 'text-[1.375rem]' : 'text-[1.25rem] font-semibold';
}
const numbered = (section: Section) => props.format === 'brief' && section.role === 'key_findings';
const bulleted = (section: Section) =>
    props.format !== 'research_report' &&
    section.role !== 'key_findings' &&
    section.role !== 'overview' &&
    section.claimIndexes.length > 1;
const listTag = (section: Section) =>
    numbered(section)
        ? 'ol'
        : bulleted(section) ||
            (section.role === 'key_findings' && props.format !== 'research_report')
          ? 'ul'
          : 'div';
function listClass(section: Section) {
    if (numbered(section)) return 'finding-list gap-0 list-none';
    if (listTag(section) === 'ul') return 'gap-3 pl-5';
    return '';
}
const assessment = (index: number) =>
    props.report.coverage.reportValue?.selections.find((entry) => entry.claimIndex === index)
        ?.assessment;
const claimIncludes = (index: number, text: string) =>
    props.report.claims[index]?.text.includes(text.trim()) ?? false;
// Method facts come only from saved metadata, never from generated prose.
const method = computed(() => {
    const items = [
        { label: '查询', value: `${props.report.coverage.searchedQueries.length} 次` },
        { label: '来源', value: `${groupEvidence(props.report.evidence).length} 个网页` },
        { label: '交付', value: props.report.publishedAt.slice(0, 10) },
    ];
    return items;
});
</script>

<style scoped>
.finding-list {
    counter-reset: finding;
}
.finding-list > li {
    @apply relative py-4 [border-bottom:0.0625rem_solid_var(--scova-border)];
    padding-inline-start: min(2.5rem, 10vw);
    counter-increment: finding;
}
.finding-list > li:first-child {
    @apply pt-1;
}
.finding-list > li:last-child {
    @apply [border-bottom:0] pb-0;
}
.finding-list > li::before {
    @apply absolute left-0 text-primary font-semibold [font-family:var(--scova-font-interface)]
        [font-variant-numeric:tabular-nums] text-[1.125rem];
    content: counter(finding);
    top: 1rem;
}
.finding-list > li:first-child::before {
    top: 0.25rem;
}
</style>
