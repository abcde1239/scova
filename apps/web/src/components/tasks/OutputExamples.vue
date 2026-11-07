<template>
    <info-dialog label="查看输出示例" title="报告输出示例" wide>
        <p class="example-note">以下为虚构内容，仅展示大概布局；实际报告由查阅结果决定。</p>
        <div class="example-formats" role="group" aria-label="示例输出形式">
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
        <article class="output-example" :aria-label="`${label}布局示例`">
            <header>
                <span class="example-kicker">布局示例 · {{ label }}</span>
                <h2>秋季课程申请动态</h2>
                <p>概述：申请截止日期延后，费用暂未确认；建议优先核对官方安排。</p>
            </header>
            <template v-if="format === 'brief'">
                <section>
                    <h3>主要发现</h3>
                    <p>
                        申请截止日期从 4 月 15 日延后至 4 月 30 日。<span class="example-ref"
                            >[1]</span
                        >
                    </p>
                    <p>新增线上说明会，开放时间仍待公布。<span class="example-ref">[2]</span></p>
                </section>
                <section>
                    <h3>需要关注</h3>
                    <p>报名费用尚未核实，不能据此判断费用不变。</p>
                </section>
            </template>
            <template v-else-if="format === 'list'">
                <section>
                    <h3>申请时间</h3>
                    <ul>
                        <li>截止日期：4 月 30 日 <span class="example-ref">[1]</span></li>
                        <li>说明会：日期待公布 <span class="example-ref">[2]</span></li>
                    </ul>
                </section>
                <section>
                    <h3>费用与材料</h3>
                    <ul>
                        <li>报名费用：待核验</li>
                        <li>材料清单：以当期官网说明为准</li>
                    </ul>
                </section>
            </template>
            <template v-else-if="format === 'comparison'">
                <section>
                    <h3>与上次查阅对比</h3>
                    <div class="comparison-example">
                        <div>
                            <strong>申请截止日期 · 已变化</strong>
                            <dl>
                                <div>
                                    <dt>上次</dt>
                                    <dd>4 月 15 日</dd>
                                </div>
                                <div>
                                    <dt>本次</dt>
                                    <dd>4 月 30 日 <span class="example-ref">[1]</span></dd>
                                </div>
                            </dl>
                        </div>
                        <div>
                            <strong>报名费用 · 待核验</strong>
                            <dl>
                                <div>
                                    <dt>上次</dt>
                                    <dd>未确认</dd>
                                </div>
                                <div>
                                    <dt>本次</dt>
                                    <dd>未确认，不能判定不变</dd>
                                </div>
                            </dl>
                        </div>
                    </div>
                </section>
            </template>
            <template v-else>
                <section>
                    <h3>报告目录</h3>
                    <p>概述 → 变化与基线 → 事实与分析 → 查阅限制 → 来源</p>
                </section>
                <section>
                    <h3>事实与分析</h3>
                    <p>
                        官方公告调整了申请截止日期。<span class="example-ref">[1]</span>
                        延长的时间可用于准备材料，这是基于已知安排的建议。
                    </p>
                </section>
                <section>
                    <h3>查阅范围与限制</h3>
                    <p>本例仅展示结构；费用与说明会日期仍需更多证据。</p>
                </section>
            </template>
            <footer>
                <h3>来源与引用</h3>
                <p><span class="example-ref">[1]</span> 示例来源：课程申请公告</p>
                <p><span class="example-ref">[2]</span> 示例来源：线上说明会安排</p>
            </footer>
        </article>
        <p class="example-note">
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

<style scoped>
.example-formats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
}
.example-formats :deep([aria-pressed='true']) {
    text-decoration: underline;
    text-underline-offset: 0.3em;
}
.example-note {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.output-example {
    display: grid;
    gap: 1.5rem;
    padding: clamp(0.75rem, 3vw, 1.5rem);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    min-inline-size: 0;
    background: var(--scova-surface);
    color: var(--scova-text);
}
header,
section,
footer {
    display: grid;
    gap: 0.65rem;
    min-inline-size: 0;
}
h2,
h3,
p {
    margin: 0;
}
h2 {
    font-size: 1.375rem;
    line-height: 1.4;
}
h3 {
    font-size: 1rem;
}
.example-kicker {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.example-ref {
    color: var(--scova-primary);
}
ul {
    margin: 0;
    padding-inline-start: 1.25rem;
}
footer {
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 1rem;
    font-size: 0.875rem;
}
.comparison-example {
    display: grid;
    gap: 1rem;
}
dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
}
dt {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
dd {
    margin: 0.25rem 0 0;
}
@media (max-width: 30rem) {
    dl {
        grid-template-columns: 1fr;
    }
}
</style>
