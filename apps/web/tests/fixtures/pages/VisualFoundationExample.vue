<template>
    <section class="visual-foundation" aria-label="基础视觉样例">
        <div class="scova-surface sample-surface">
            <h2 class="scova-report-title contrast-sample large-sample">资料与报告 · Research</h2>
            <p class="contrast-sample">
                <span class="font-interface">知巡中文界面</span>
                <span class="font-latin">Scova Research 2026</span>
            </p>
            <article class="scova-reading">
                <p class="contrast-sample">
                    <span class="font-reading">来源事实、引用与研究结论应保持清晰。</span>
                </p>
                <a class="scova-reference contrast-sample" href="#source">查看原始引用</a>
            </article>
            <p class="scova-caption muted contrast-sample">来源：受控本地样例</p>
            <p class="scova-selected sample-selected contrast-sample">选中的资料</p>
            <div class="sample-actions">
                <n-button type="primary" class="contrast-sample"
                    ><app-icon name="confirm" />确认操作</n-button
                >
                <action-button class="contrast-sample">普通操作</action-button>
                <icon-button icon="appearance" label="调整样例外观" />
            </div>
            <p class="scova-partial contrast-sample">部分完成：仍有来源缺口</p>
            <p class="scova-failure contrast-sample">失败：暂时无法读取</p>
            <p class="success contrast-sample">成功：资料已保存</p>
            <div class="state-sample"><state-panel state="empty" message="暂无已保存资料" /></div>
        </div>
        <div class="glass-stage" :style="{ background: backdrop }">
            <div
                v-for="kind in ['navigation', 'tools', 'report', 'menu']"
                :key="kind"
                :class="[
                    'scova-glass',
                    'glass-sample',
                    `scova-glass--${kind}`,
                    { 'scova-glass--solid': rendering === 'solid' },
                ]"
            >
                <p class="contrast-sample">玻璃层上的正文与来源</p>
                <a class="scova-reference contrast-sample" href="#source">查看引用</a>
                <p class="scova-partial contrast-sample">部分完成</p>
                <p class="scova-failure contrast-sample">读取失败</p>
                <n-button type="primary" class="contrast-sample">确认操作</n-button>
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import { NButton } from 'naive-ui';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import IconButton from '@/components/common/IconButton.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import { useAppearanceStore } from '@/store/appearance';
import { accentOptions } from '@/theme/tokens';
import '@/styles/reading-fonts.css';

const query = useRoute().query;
const appearance = useAppearanceStore();
const accent = accentOptions.find((option) => option.value === query.accent)?.value ?? 'blue';
appearance.setAccent(accent);
appearance.setMode(query.scheme === 'dark' ? 'dark' : 'light');
const backdrop =
    query.backdrop === 'black' ? '#000000' : query.backdrop === 'blue' ? '#0649b7' : '#ffffff';
const rendering = query.rendering === 'solid' ? 'solid' : 'native';
</script>

<style scoped>
.visual-foundation {
    display: grid;
    gap: 2rem;
    max-inline-size: 52rem;
    min-inline-size: 0;
}
.sample-surface,
.glass-stage,
.scova-glass {
    padding: 1.5rem;
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
.sample-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
}
.muted {
    color: var(--scova-muted);
}
.success {
    color: var(--scova-success);
}
.sample-selected {
    padding: 0.5rem;
}
</style>
