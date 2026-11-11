<template>
    <info-dialog label="查看输出示例" title="报告输出示例" wide>
        <p class="example-note text-muted text-[0.875rem] m-0">
            以下为虚构内容，仅展示大概布局；实际报告由查阅结果决定。
        </p>
        <div
            class="example-formats flex flex-wrap gap-[0.25rem_1.25rem] [&.example-formats_[aria-pressed='true']]:(underline underline-offset-[0.3em])"
            role="group"
            aria-label="示例输出形式"
        >
            <action-button
                v-for="item in formats"
                :key="item.value"
                text
                :type="format === item.value ? 'primary' : 'default'"
                v-bind="{ 'aria-pressed': format === item.value }"
                @click="format = item.value"
                >{{ item.label }}</action-button
            >
        </div>
        <article
            class="output-example layout-grid gap-6 border-theme rounded-3 bg-surface text-default p-[clamp(0.75rem,_3vw,_1.5rem)]"
            :aria-label="`${label}布局示例`"
        >
            <header class="layout-grid gap-[0.65rem]">
                <span class="example-kicker text-muted text-[0.8125rem]"
                    >布局示例 · {{ label }}</span
                >
                <h2 class="text-[1.375rem] leading-[1.4] m-0">秋季课程申请动态</h2>
                <p class="m-0">概述：申请截止日期延后，费用暂未确认；建议优先核对官方安排。</p>
            </header>
            <template v-if="format === 'brief'">
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">主要发现</h3>
                    <p class="m-0">
                        申请截止日期从 4 月 15 日延后至 4 月 30 日。<span
                            class="example-ref text-primary"
                            >[1]</span
                        >
                    </p>
                    <p class="m-0">
                        新增线上说明会，开放时间仍待公布。<span class="example-ref text-primary"
                            >[2]</span
                        >
                    </p>
                </section>
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">需要关注</h3>
                    <p class="m-0">报名费用尚未核实，不能据此判断费用不变。</p>
                </section>
            </template>
            <template v-else-if="format === 'list'">
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">申请时间</h3>
                    <ul class="pl-5 m-0">
                        <li>
                            截止日期：4 月 30 日 <span class="example-ref text-primary">[1]</span>
                        </li>
                        <li>
                            说明会：日期待公布 <span class="example-ref text-primary">[2]</span>
                        </li>
                    </ul>
                </section>
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">费用与材料</h3>
                    <ul class="pl-5 m-0">
                        <li>报名费用：待核验</li>
                        <li>材料清单：以当期官网说明为准</li>
                    </ul>
                </section>
            </template>
            <template v-else-if="format === 'comparison'">
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">与上次查阅对比</h3>
                    <div class="comparison-example grid gap-4">
                        <div>
                            <strong>申请截止日期 · 已变化</strong>
                            <dl
                                class="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-3 [@media(max-width:_30rem)]:grid-cols-[1fr]"
                            >
                                <div>
                                    <dt class="text-muted text-[0.875rem]">上次</dt>
                                    <dd class="mt-1 mb-0 mx-0">4 月 15 日</dd>
                                </div>
                                <div>
                                    <dt class="text-muted text-[0.875rem]">本次</dt>
                                    <dd class="mt-1 mb-0 mx-0">
                                        4 月 30 日 <span class="example-ref text-primary">[1]</span>
                                    </dd>
                                </div>
                            </dl>
                        </div>
                        <div>
                            <strong>报名费用 · 待核验</strong>
                            <dl
                                class="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-3 [@media(max-width:_30rem)]:grid-cols-[1fr]"
                            >
                                <div>
                                    <dt class="text-muted text-[0.875rem]">上次</dt>
                                    <dd class="mt-1 mb-0 mx-0">未确认</dd>
                                </div>
                                <div>
                                    <dt class="text-muted text-[0.875rem]">本次</dt>
                                    <dd class="mt-1 mb-0 mx-0">未确认，不能判定不变</dd>
                                </div>
                            </dl>
                        </div>
                    </div>
                </section>
            </template>
            <template v-else>
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">报告目录</h3>
                    <p class="m-0">概述 → 变化与基线 → 事实与分析 → 查阅限制 → 来源</p>
                </section>
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">事实与分析</h3>
                    <p class="m-0">
                        官方公告调整了申请截止日期。<span class="example-ref text-primary"
                            >[1]</span
                        >
                        延长的时间可用于准备材料，这是基于已知安排的建议。
                    </p>
                </section>
                <section class="layout-grid gap-[0.65rem]">
                    <h3 class="text-[1rem] m-0">查阅范围与限制</h3>
                    <p class="m-0">本例仅展示结构；费用与说明会日期仍需更多证据。</p>
                </section>
            </template>
            <footer
                class="layout-grid gap-[0.65rem] [border-top:0.0625rem_solid_var(--scova-border)] pt-4 text-[0.875rem]"
            >
                <h3 class="text-[1rem] m-0">来源与引用</h3>
                <p class="m-0">
                    <span class="example-ref text-primary">[1]</span> 示例来源：课程申请公告
                </p>
                <p class="m-0">
                    <span class="example-ref text-primary">[2]</span> 示例来源：线上说明会安排
                </p>
            </footer>
        </article>
        <p class="example-note text-muted text-[0.875rem] m-0">
            简报突出重点；主题清单按主题列项；对比展示前后变化；研究报告展开事实、分析和限制。预览不会修改当前选择或创建任务。
        </p>
    </info-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import ActionButton from '@/components/common/ActionButton.vue';
import InfoDialog from '@/components/common/InfoDialog.vue';
const formats = [
    { value: 'brief', label: '简报' },
    { value: 'list', label: '主题清单' },
    { value: 'comparison', label: '对比' },
    { value: 'research_report', label: '研究报告' },
];
const format = ref('brief');
const label = computed(() => formats.find((item) => item.value === format.value)?.label ?? '简报');
</script>
