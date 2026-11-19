<template>
    <div class="structured-content layout-grid gap-3 break-anywhere [container-type:inline-size]">
        <template v-if="format === 'list' && content.list">
            <div
                v-if="listColumns"
                class="list-table matrix-scroll min-w-0 max-w-full [overflow-x:auto] [overscroll-behavior-inline:contain] keyboard-focus-wide"
                tabindex="0"
                role="region"
                aria-labelledby="list-table-caption"
            >
                <table
                    class="structured-table w-full [table-layout:fixed] [border-collapse:collapse]"
                    :style="{ minInlineSize: `${listLayout.minWidth}rem` }"
                >
                    <caption id="list-table-caption" class="sr-only">
                        条目与字段
                    </caption>
                    <colgroup>
                        <col :style="{ width: `${listLayout.labelWidth}rem` }" />
                        <col
                            v-for="(width, index) in listLayout.widths"
                            :key="index"
                            :style="{ width: `${width}rem` }"
                        />
                    </colgroup>
                    <thead>
                        <tr>
                            <th scope="col" class="head-cell sticky-cell">条目</th>
                            <th
                                v-for="label in listColumns"
                                :key="label"
                                scope="col"
                                class="head-cell"
                            >
                                {{ label }}
                            </th>
                        </tr>
                    </thead>
                    <tbody v-for="run in listRuns" :key="`run-${run.group}-${run.items[0]!.id}`">
                        <tr v-if="run.group" class="group-row">
                            <th :colspan="listColumns.length + 1" scope="rowgroup">
                                {{ run.group }}
                            </th>
                        </tr>
                        <tr v-for="entry in run.items" :key="entry.id">
                            <th scope="row" class="row-head sticky-cell">{{ entry.name }}</th>
                            <td
                                v-for="field in visibleFields(entry)"
                                :key="field.id"
                                class="body-cell"
                            >
                                <report-structured-value
                                    :report="report"
                                    :value="field"
                                    :notes="footnotes.byValue.get(field) ?? []"
                                    :note-id="noteId"
                                    compact
                                />
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div
                class="list-cards layout-grid gap-5"
                :class="{ 'list-cards--tabular': listColumns }"
            >
                <template v-for="run in listRuns" :key="`cards-${run.group}-${run.items[0]!.id}`">
                    <h4
                        v-if="run.group"
                        class="group-title scova-interface text-muted text-[0.875rem] font-semibold m-0"
                    >
                        {{ run.group }}
                    </h4>
                    <ul
                        class="object-list grid gap-4 list-none m-0 p-0"
                        :style="{
                            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${cardWidth(run.items)}rem), 1fr))`,
                        }"
                        role="list"
                    >
                        <li
                            v-for="entry in run.items"
                            :key="entry.id"
                            class="object-card layout-grid gap-3 break-anywhere [align-content:start] border-theme rounded-3 p-4"
                        >
                            <h4 class="scova-content-title m-0">{{ entry.name }}</h4>
                            <dl class="grid gap-3 m-0">
                                <div
                                    v-for="field in visibleFields(entry)"
                                    :key="field.id"
                                    class="object-field layout-grid gap-1 break-anywhere"
                                >
                                    <dt class="scova-interface text-muted text-[0.875rem]">
                                        {{ field.label }}
                                    </dt>
                                    <dd class="m-0">
                                        <report-structured-value :report="report" :value="field" />
                                    </dd>
                                </div>
                            </dl>
                        </li>
                    </ul>
                </template>
            </div>
        </template>
        <div
            v-if="format === 'comparison' && content.comparison"
            class="matrix-scroll min-w-0 max-w-full [overflow-x:auto] [overscroll-behavior-inline:contain] keyboard-focus-wide"
            tabindex="0"
            role="region"
            aria-labelledby="object-comparison-caption"
        >
            <table
                class="object-matrix structured-table w-full [table-layout:fixed] [border-collapse:collapse]"
                :style="{ minInlineSize: `${comparisonLayout.minWidth}rem` }"
            >
                <caption class="sr-only" id="object-comparison-caption">
                    对象与共同维度对比
                </caption>
                <colgroup>
                    <col :style="{ width: `${comparisonLayout.labelWidth}rem` }" />
                    <col
                        v-for="(width, index) in comparisonLayout.widths"
                        :key="index"
                        :style="{ width: `${width}rem` }"
                    />
                </colgroup>
                <thead>
                    <tr>
                        <th class="head-cell sticky-cell" scope="col">维度</th>
                        <th
                            v-for="object in content.comparison.objects"
                            :key="object.id"
                            class="head-cell"
                            scope="col"
                        >
                            {{ object.name }}
                        </th>
                    </tr>
                </thead>
                <tbody v-for="run in dimensionRuns" :key="`dim-${run.group}-${run.items[0]!.id}`">
                    <tr v-if="run.group" class="group-row">
                        <th :colspan="content.comparison.objects.length + 1" scope="rowgroup">
                            {{ run.group }}
                        </th>
                    </tr>
                    <tr v-for="dimension in run.items" :key="dimension.id">
                        <th class="row-head sticky-cell" scope="row">{{ dimension.label }}</th>
                        <td
                            v-for="object in content.comparison.objects"
                            :key="object.id"
                            class="body-cell"
                        >
                            <report-structured-value
                                v-if="cell(object.id, dimension.id)"
                                :report="report"
                                :value="cell(object.id, dimension.id)!"
                                :notes="footnotes.byValue.get(cell(object.id, dimension.id)!) ?? []"
                                :note-id="noteId"
                                compact
                            />
                            <span v-else class="text-muted">未知</span>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <div
            v-if="showNotes"
            class="structured-notes scova-interface text-[0.8125rem] text-muted layout-grid gap-2"
            :class="{ '[@media(max-width:_40rem)]:hidden': format === 'list' }"
        >
            <p v-if="hasUncertain" class="m-0">
                <span class="legend-tag">未知</span> 来源未提供，不等于“无”或“不支持”；<span
                    class="legend-tag theme-partial"
                    >部分</span
                >
                仅找到部分支持，见注。
            </p>
            <ol v-if="footnotes.list.length" class="grid gap-1 m-0 pl-5">
                <li
                    v-for="(note, index) in footnotes.list"
                    :id="`${noteId}-${index + 1}`"
                    :key="note"
                    class="keyboard-focus-wide [scroll-margin-block-start:6rem]"
                    tabindex="-1"
                >
                    {{ note }}
                </li>
            </ol>
        </div>
    </div>
</template>
<script setup lang="ts">
import { computed, useId } from 'vue';
import type { Report } from '@scova/models';
import ReportStructuredValue from '@/component/reports/ReportStructuredValue.vue';
import { reportCardWidth, reportTableLayout } from '@/utils/report/widths';
import {
    groupRuns,
    structuredValueFootnotes,
    tabularList,
    visibleFields,
    type StructuredValue,
} from '@/utils/report/artifacts';
type Content = NonNullable<NonNullable<Report['coverage']['artifacts']>[number]['content']>;
const props = defineProps<{ report: Report; content: Content; format: Report['format'] }>();
const noteId = `structured-note-${useId()}`;
const cell = (objectId: string, dimensionId: string) =>
    props.content.comparison?.cells.find(
        (entry) => entry.objectId === objectId && entry.dimensionId === dimensionId,
    );
const listColumns = computed(() =>
    props.format === 'list' && props.content.list ? tabularList(props.content.list) : undefined,
);
const listRuns = computed(() => groupRuns(props.content.list?.entries ?? []));
const dimensionRuns = computed(() => groupRuns(props.content.comparison?.dimensions ?? []));
const comparisonLayout = computed(() => {
    const matrix = props.content.comparison;
    return reportTableLayout(
        matrix?.dimensions.map((dimension) => dimension.label) ?? [],
        matrix?.objects.map((object) => [
            object.name,
            ...matrix.cells
                .filter((value) => value.objectId === object.id)
                .map((value) => value.text),
        ]) ?? [],
    );
});
const listLayout = computed(() =>
    reportTableLayout(
        props.content.list?.entries.map((entry) => entry.name) ?? [],
        listColumns.value?.map((label) => [
            label,
            ...(props.content.list?.entries.flatMap((entry) =>
                visibleFields(entry)
                    .filter((field) => field.label === label)
                    .map((field) => field.text),
            ) ?? []),
        ]) ?? [],
    ),
);
const cardWidth = (entries: NonNullable<Content['list']>['entries']) =>
    reportCardWidth(entries.flatMap((entry) => visibleFields(entry).map((field) => field.text)));
// Values in reading order: row by row, so footnote numbers increase down the table.
const orderedValues = computed<StructuredValue[]>(() => {
    if (props.format === 'list' && listColumns.value)
        return listRuns.value.flatMap((run) => run.items.flatMap((entry) => visibleFields(entry)));
    const matrix = props.content.comparison;
    if (props.format !== 'comparison' || !matrix) return [];
    return dimensionRuns.value.flatMap((run) =>
        run.items.flatMap((dimension) =>
            matrix.objects.flatMap((object) => cell(object.id, dimension.id) ?? []),
        ),
    );
});
const footnotes = computed(() => {
    const list: string[] = [];
    const byValue = new Map<StructuredValue, number[]>();
    for (const value of orderedValues.value) {
        const numbers = structuredValueFootnotes(props.report, value).map((text) => {
            const existing = list.indexOf(text);
            if (existing >= 0) return existing + 1;
            list.push(text);
            return list.length;
        });
        if (numbers.length) byValue.set(value, numbers);
    }
    return { list, byValue };
});
const hasUncertain = computed(() =>
    orderedValues.value.some((value) => !['supported', 'model_answered'].includes(value.status)),
);
const showNotes = computed(() => !!footnotes.value.list.length || hasUncertain.value);
</script>

<style scoped>
.structured-table {
    @apply scova-interface text-[0.9375rem] leading-[1.6];
}
.head-cell {
    @apply text-start font-semibold [vertical-align:bottom] break-anywhere py-3 px-3.5
        [border-bottom:0.125rem_solid_var(--scova-border)];
}
.row-head {
    @apply text-start font-semibold [vertical-align:top] py-3 px-3.5
        [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_60%,_transparent)];
}
.body-cell {
    @apply text-start [vertical-align:top] py-3 px-3.5 break-anywhere
        [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_60%,_transparent)];
}
.sticky-cell {
    @apply sticky left-0 z-[1] bg-surface;
}
.group-row th {
    @apply text-start text-muted text-[0.8125rem] font-semibold tracking-[0.04em] pt-4 pb-2 px-3.5
        [background:color-mix(in_srgb,_var(--scova-border)_10%,_transparent)];
}
.legend-tag {
    @apply inline-flex items-center rounded-1 px-1.5 text-[0.75rem] [border:0.0625rem_dashed_currentColor];
}
@container (min-width: 40.0625rem) {
    .list-cards--tabular {
        @apply hidden;
    }
}
@container (max-width: 40rem) {
    .list-table {
        @apply hidden;
    }
}
@container (max-width: 32rem) {
    .sticky-cell {
        @apply static;
    }
}
</style>
