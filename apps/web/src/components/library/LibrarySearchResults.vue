<template>
    <ul class="search-results">
        <li v-for="item in items" :key="searchHitKey(item)" class="search-result">
            <h3 class="scova-content-title">
                <router-link :to="searchTarget(item).path">{{ item.title }}</router-link>
            </h3>
            <p v-if="item.excerpt" class="search-excerpt scova-reading">{{ item.excerpt }}</p>
            <dl class="scova-interface">
                <div>
                    <dt>资料类型</dt>
                    <dd>{{ item.kind === 'source' ? '来源快照' : '纯文本笔记' }}</dd>
                </div>
                <div>
                    <dt>命中方式</dt>
                    <dd>{{ item.matchedBy === 'fts' ? '全文词项匹配' : '字面子串匹配' }}</dd>
                </div>
                <div>
                    <dt>{{ item.kind === 'source' ? '最近成功观测' : '笔记更新时间' }}</dt>
                    <dd>
                        <time :datetime="item.updatedAt">{{ item.updatedAt }}</time>
                    </dd>
                </div>
            </dl>
            <router-link :to="searchTarget(item).path" class="scova-interface">{{
                searchTarget(item).label
            }}</router-link>
        </li>
    </ul>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { searchHitKey, searchTarget, type SearchHit } from '@/api/library-search';
defineProps<{ items: SearchHit[] }>();
</script>

<style scoped>
.search-results {
    list-style: none;
    padding: 0;
    margin: 0;
    min-inline-size: 0;
}
.search-result {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    padding-block: 1.5rem;
    border-block-end: 0.0625rem solid var(--scova-border);
    overflow-wrap: anywhere;
    cursor: default;
}
h3,
p {
    margin: 0;
}
h3 {
    font-size: 1.25rem;
    font-weight: 600;
}
.search-excerpt {
    white-space: pre-wrap;
    cursor: default;
}
dl {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    justify-self: start;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
    overflow-wrap: anywhere;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
