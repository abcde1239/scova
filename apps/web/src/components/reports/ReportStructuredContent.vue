<template>
    <div class="structured-content">
        <ul v-if="format === 'list' && content.list" class="object-list" role="list">
            <li v-for="entry in content.list.entries" :key="entry.id" class="object-card">
                <h4 class="scova-content-title">{{ entry.name }}</h4>
                <dl>
                    <div v-for="field in entry.fields" :key="field.id" class="object-field">
                        <dt>{{ field.label }}</dt>
                        <dd><report-structured-value :report="report" :value="field" /></dd>
                    </div>
                </dl>
            </li>
        </ul>
        <div
            v-if="format === 'comparison' && content.comparison"
            class="matrix-scroll"
            tabindex="0"
            role="region"
            aria-labelledby="object-comparison-caption"
        >
            <table
                class="object-matrix"
                :style="{ minInlineSize: `${12 * (content.comparison.objects.length + 1)}rem` }"
            >
                <caption id="object-comparison-caption">
                    对象与共同维度对比
                </caption>
                <thead>
                    <tr>
                        <th scope="col">共同维度</th>
                        <th
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
                        <th scope="row">{{ dimension.label }}</th>
                        <td v-for="object in content.comparison.objects" :key="object.id">
                            <report-structured-value
                                v-if="cell(object.id, dimension.id)"
                                :report="report"
                                :value="cell(object.id, dimension.id)!"
                            />
                            <p v-else class="scova-warning">未知：尚未保存此项资料</p>
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
<style scoped>
.structured-content,
.object-card,
.object-field {
    display: grid;
    min-inline-size: 0;
    gap: 0.75rem;
    overflow-wrap: anywhere;
}
.object-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
    padding: 0;
    margin: 0;
    list-style: none;
}
.object-card {
    align-content: start;
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
}
h4,
p,
dl,
dd {
    margin: 0;
}
dl {
    display: grid;
    gap: 1rem;
}
dt {
    font-weight: 600;
}
.matrix-scroll {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
}
.object-matrix {
    inline-size: 100%;
    table-layout: fixed;
    border-collapse: collapse;
}
caption {
    text-align: start;
    padding-block-end: 0.75rem;
}
th,
td {
    padding: 0.875rem;
    border: 0.0625rem solid var(--scova-border);
    text-align: start;
    vertical-align: top;
    overflow-wrap: anywhere;
}
th {
    background: var(--scova-selected);
    font-weight: 600;
}
.matrix-scroll:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
@media (max-width: 40rem) {
    .object-card {
        padding-inline: 0.375rem;
    }
}
</style>
