<template>
    <div class="image-examples">
        <p>受控展示样例 · 非真实来源或报告</p>
        <div v-for="item in items" :key="item.id" :class="`image-case-${item.id}`">
            <source-item :title="item.title" :summary="summary" :image="item.image">
                <template #actions>
                    <action-button @click="selected = item.title">查看文字</action-button>
                </template>
            </source-item>
        </div>
        <p role="status">{{ selected ? `已打开：${selected}` : '选择条目查看文字。' }}</p>
        <section aria-labelledby="report-image-title">
            <h2 id="report-image-title">报告图示</h2>
            <source-image :image="map" variant="report" />
        </section>
        <section aria-labelledby="replace-image-title">
            <h2 id="replace-image-title">图片更新</h2>
            <source-item title="替换加载失败的图片" :summary="summary" :image="replacement">
                <template #actions>
                    <action-button @click="replacement = map">换用同源图</action-button>
                    <action-button @click="replacement = undefined">移除图片</action-button>
                </template>
            </source-item>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import ActionButton from '@/components/common/ActionButton.vue';
import SourceItem from '@/components/source/SourceItem.vue';
import SourceImage from '@/components/source/SourceImage.vue';
import type { SourceImageInput } from '@/models/source-image';
import mapUrl from './source-map.svg?url&no-inline';

const map: SourceImageInput = {
    src: mapUrl,
    alt: '自制流域分区概念图：左侧蓝色流域与河道、右侧绿色观测区；底部保留流域与观测区图例，以及零、五、十公里示意比例尺，不代表真实地理测量。',
    attribution: 'Scova 自制',
    concept: true,
};
const failed = { ...map, src: '/__samples/missing-source-image.svg' };
const items = [
    { id: 'image', title: '有图条目：流域资料摘录', image: map },
    { id: 'text', title: '纯文字条目：流域资料摘录', image: undefined },
    { id: 'failed', title: '失败回退条目：流域资料摘录', image: failed },
];
const summary =
    '这里仅演示资料摘要与操作。图片不是真实性证明；未接入媒体的资料仍使用完整的纯文字布局。';
const selected = ref('');
const replacement = ref<SourceImageInput | undefined>(failed);
</script>

<style scoped>
.image-examples {
    display: grid;
    gap: 2.5rem;
    min-inline-size: 0;
}
h2 {
    margin: 0 0 1rem;
    font-size: 1.25rem;
    line-height: 1.5;
}
</style>
