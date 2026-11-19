<template>
    <info-dialog label="查看输出示例" title="报告输出示例" wide>
        <p class="text-muted text-[0.875rem] m-0">以下为虚构内容，展示四类交付结构。</p>
        <div class="flex flex-wrap gap-[0.25rem_1.25rem]" role="group" aria-label="示例输出形式">
            <action-button
                v-for="item in formats"
                :key="item.value"
                text
                :type="format === item.value ? 'primary' : 'default'"
                :class="{ 'theme-selected rounded-2 font-semibold': format === item.value }"
                v-bind="{ 'aria-pressed': format === item.value }"
                @click="format = item.value"
                >{{ item.label }}</action-button
            >
        </div>
        <article
            class="output-example layout-grid gap-6 border-theme rounded-3 bg-surface text-default p-[clamp(0.75rem,_3vw,_1.5rem)]"
            :aria-label="`${label}布局示例`"
        >
            <header class="layout-grid gap-3">
                <span class="text-muted text-[0.8125rem]">虚构布局示例 · {{ label }}</span>
                <h2 class="text-[1.375rem] leading-[1.4] m-0">两馆自习室使用条件</h2>
            </header>
            <template v-if="format === 'brief'">
                <section class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">两馆预约要求不同，均需读者证</h3>
                    <ul class="layout-grid gap-3 pl-5 m-0">
                        <li>甲馆工作日 09:00–18:00 开放，无需预约。</li>
                        <li>乙馆周二至周日 10:00–20:00 开放，须在线预约，每次最多两小时。</li>
                        <li>两馆均免费开放，入馆需携带读者证。</li>
                    </ul>
                </section>
            </template>
            <template v-else-if="format === 'list'">
                <section v-for="library in libraries" :key="library.name" class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">{{ library.name }}</h3>
                    <dl class="layout-grid gap-3 m-0">
                        <div
                            v-for="field in library.fields"
                            :key="field.label"
                            class="layout-grid gap-1"
                        >
                            <dt class="font-semibold">{{ field.label }}</dt>
                            <dd class="m-0">{{ field.value }}</dd>
                        </div>
                    </dl>
                </section>
            </template>
            <template v-else-if="format === 'comparison'">
                <div
                    class="max-w-full min-w-0 overflow-x-auto keyboard-focus-wide"
                    role="region"
                    tabindex="0"
                    aria-labelledby="example-comparison-caption"
                >
                    <table class="w-full min-w-[36rem] [border-collapse:collapse] text-start">
                        <caption id="example-comparison-caption" class="text-start pb-3">
                            两馆的共同维度
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">比较维度</th>
                                <th scope="col">甲馆</th>
                                <th scope="col">乙馆</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(field, index) in libraries[0]!.fields" :key="field.label">
                                <th scope="row">{{ field.label }}</th>
                                <td>{{ field.value }}</td>
                                <td>{{ libraries[1]!.fields[index]!.value }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="m-0">
                    主要差异：甲馆工作日无需预约；乙馆提供周末时段，每次预约最多两小时。
                </p>
            </template>
            <template v-else>
                <section class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">摘要</h3>
                    <p class="m-0">
                        甲馆工作日免预约；乙馆可预约周末时段，每次最多两小时。两馆均需读者证。
                    </p>
                </section>
                <section class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">范围与资料依据</h3>
                    <p class="m-0">本报告依据两份虚构开放说明，比较预约、开放时段和证件要求。</p>
                </section>
                <section class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">预约与开放安排</h3>
                    <p class="m-0">
                        甲馆可在工作日 09:00–18:00 使用，无需预约；乙馆须在线预约，周二至周日
                        10:00–20:00 开放，每次最多两小时。
                    </p>
                </section>
                <section class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">使用情境</h3>
                    <p class="m-0">
                        甲馆适合工作日临时到馆使用；乙馆适合可提前预约、使用时间在两小时以内的周末使用。
                    </p>
                </section>
                <section class="layout-grid gap-3">
                    <h3 class="text-[1rem] m-0">结论</h3>
                    <p class="m-0">两馆均免费开放，入馆需读者证；可按使用日期和预约时长选择。</p>
                </section>
            </template>
            <footer
                class="layout-grid gap-3 [border-top:0.0625rem_solid_var(--scova-border)] pt-4 text-[0.875rem]"
            >
                <h3 class="text-[1rem] m-0">来源与引用</h3>
                <p class="m-0">[1] 虚构来源：甲馆开放说明</p>
                <p class="m-0">[2] 虚构来源：乙馆预约说明</p>
            </footer>
        </article>
        <p class="text-muted text-[0.875rem] m-0">
            简报突出精选发现；清单按对象列出一致字段；对比按共同维度呈现矩阵；研究报告通过主题章节解释依据与限制。历史变化在当前成果之后展示。预览不会创建任务或修改选择。
        </p>
    </info-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import ActionButton from '@/component/common/ActionButton.vue';
import InfoDialog from '@/component/common/InfoDialog.vue';
const formats = [
    { value: 'brief', label: '简报' },
    { value: 'list', label: '主题清单' },
    { value: 'comparison', label: '对比' },
    { value: 'research_report', label: '研究报告' },
];
const format = ref('brief');
const label = computed(() => formats.find((item) => item.value === format.value)?.label ?? '简报');
const libraries = [
    {
        name: '甲馆',
        fields: [
            { label: '预约方式', value: '无需预约。' },
            { label: '开放时段', value: '工作日 09:00–18:00。' },
            { label: '携带物品', value: '读者证。' },
            { label: '费用', value: '免费' },
        ],
    },
    {
        name: '乙馆',
        fields: [
            { label: '预约方式', value: '在线预约，每次最多两小时。' },
            { label: '开放时段', value: '周二至周日 10:00–20:00。' },
            { label: '携带物品', value: '读者证。' },
            { label: '费用', value: '免费' },
        ],
    },
];
</script>

<style scoped>
.output-example th,
.output-example td {
    @apply border-theme p-3 text-start [vertical-align:top];
}
</style>
