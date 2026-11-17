<template>
    <ul class="search-results list-none min-w-0 m-0 p-0">
        <li
            v-for="item in items"
            :key="searchHitKey(item)"
            class="search-result report-grid pt-6 pb-6 [border-bottom:0.0625rem_solid_var(--scova-border)] cursor-default"
        >
            <h3 class="scova-content-title text-[1.25rem] font-semibold m-0">
                <router-link
                    class="inline-flex items-center min-h-11 max-w-full justify-self-start scova-link cursor-pointer break-anywhere keyboard-focus-wide"
                    :to="searchTarget(item).path"
                    >{{ item.title }}</router-link
                >
            </h3>
            <p
                v-if="item.excerpt"
                class="search-excerpt scova-reading whitespace-pre-wrap cursor-default m-0"
            >
                {{ item.excerpt }}
            </p>
            <dl class="scova-interface flex flex-wrap gap-[1rem_2rem] m-0">
                <div>
                    <dt class="text-muted">资料类型</dt>
                    <dd class="m-0">{{ item.kind === 'source' ? '来源快照' : '纯文本笔记' }}</dd>
                </div>
                <div>
                    <dt class="text-muted">命中方式</dt>
                    <dd class="m-0">
                        {{ item.matchedBy === 'fts' ? '全文词项匹配' : '字面子串匹配' }}
                    </dd>
                </div>
                <div>
                    <dt class="text-muted">
                        {{ item.kind === 'source' ? '最近成功观测' : '笔记更新时间' }}
                    </dt>
                    <dd class="m-0">
                        <time :datetime="item.updatedAt">{{ item.updatedAt }}</time>
                    </dd>
                </div>
            </dl>
            <router-link
                :to="searchTarget(item).path"
                class="scova-interface inline-flex items-center min-h-11 max-w-full justify-self-start scova-link cursor-pointer break-anywhere keyboard-focus-wide"
                >{{ searchTarget(item).label }}</router-link
            >
        </li>
    </ul>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { searchHitKey, searchTarget, type SearchHit } from '@/api/library-search';
defineProps<{ items: SearchHit[] }>();
</script>
