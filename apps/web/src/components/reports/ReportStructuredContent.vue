<template>
    <div class="structured-content layout-grid gap-3 break-anywhere">
        <ul
            v-if="format === 'list' && content.list"
            class="object-list grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_20rem),_1fr))] gap-4 list-none m-0 p-0"
            role="list"
        >
            <li
                v-for="entry in content.list.entries"
                :key="entry.id"
                class="object-card layout-grid gap-3 break-anywhere [align-content:start] border-theme rounded-3 p-4 [@media(max-width:_40rem)]:(pl-1.5 pr-1.5)"
            >
                <h4 class="scova-content-title m-0">{{ entry.name }}</h4>
                <dl class="grid gap-4 m-0">
                    <div
                        v-for="field in entry.fields"
                        :key="field.id"
                        class="object-field layout-grid gap-3 break-anywhere"
                    >
                        <dt class="font-semibold">{{ field.label }}</dt>
                        <dd class="m-0">
                            <report-structured-value :report="report" :value="field" />
                        </dd>
                    </div>
                </dl>
            </li>
        </ul>
        <div
            v-if="format === 'comparison' && content.comparison"
            class="matrix-scroll min-w-0 max-w-full [overflow-x:auto] [overscroll-behavior-inline:contain] keyboard-focus-wide"
            tabindex="0"
            role="region"
            aria-labelledby="object-comparison-caption"
        >
            <table
                class="object-matrix w-full [table-layout:fixed] [border-collapse:collapse]"
                :style="{ minInlineSize: `${12 * (content.comparison.objects.length + 1)}rem` }"
            >
                <caption class="text-start pb-3" id="object-comparison-caption">
                    对象与共同维度对比
                </caption>
                <thead>
                    <tr>
                        <th
                            class="border-theme text-start [vertical-align:top] break-anywhere [background:var(--scova-selected)] font-semibold p-3.5"
                            scope="col"
                        >
                            共同维度
                        </th>
                        <th
                            class="border-theme text-start [vertical-align:top] break-anywhere [background:var(--scova-selected)] font-semibold p-3.5"
                            v-for="object in content.comparison.objects"
                            :key="object.id"
                            scope="col"
                        >
                            {{ object.name }}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="dimension in content.comparison.dimensions" :key="dimension.id">
                        <th
                            class="border-theme text-start [vertical-align:top] break-anywhere [background:var(--scova-selected)] font-semibold p-3.5"
                            scope="row"
                        >
                            {{ dimension.label }}
                        </th>
                        <td
                            class="border-theme text-start [vertical-align:top] break-anywhere p-3.5"
                            v-for="object in content.comparison.objects"
                            :key="object.id"
                        >
                            <report-structured-value
                                v-if="cell(object.id, dimension.id)"
                                :report="report"
                                :value="cell(object.id, dimension.id)!"
                            />
                            <p v-else class="scova-warning m-0">未知：尚未保存此项资料</p>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>
<script setup lang="ts">
import type { Report } from '@scova/models';
import ReportStructuredValue from '@/components/reports/ReportStructuredValue.vue';
type Content = NonNullable<NonNullable<Report['coverage']['artifacts']>[number]['content']>;
const props = defineProps<{ report: Report; content: Content; format: Report['format'] }>();
const cell = (objectId: string, dimensionId: string) =>
    props.content.comparison?.cells.find(
        (entry) => entry.objectId === objectId && entry.dimensionId === dimensionId,
    );
</script>
