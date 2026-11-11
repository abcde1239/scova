<template>
    <section
        v-if="effects.length"
        class="feedback-effects scova-interface layout-stack break-anywhere w-[min(100%,_45rem)] [border-top:0.0625rem_solid_var(--scova-border)] pt-8"
        aria-labelledby="feedback-effects-title"
    >
        <h2 class="text-[1.25rem] m-0" id="feedback-effects-title">本报告的反馈作用</h2>
        <p class="m-0">
            以下为本报告保存的实际作用与未执行原因；当前反馈的修改或撤销不会改写这些记录。
        </p>
        <ul class="effect-list list-none min-w-0 m-0 p-0">
            <li
                v-for="item in effects"
                :key="item.key"
                class="effect-item layout-stack break-anywhere pt-6 pb-6 [.effect-item_+_&.effect-item]:[border-top:0.0625rem_solid_var(--scova-border)]"
            >
                <h3
                    class="text-[1.125rem] font-semibold m-0"
                    :class="{ 'scova-partial': item.limited }"
                >
                    {{ item.label }}
                </h3>
                <p class="m-0">反馈意图：{{ item.kindLabel }}</p>
                <p class="effect-text whitespace-pre-wrap break-anywhere m-0">
                    {{ item.entry.reason }}
                </p>
                <details>
                    <summary
                        class="min-h-11 box-border pt-2 pb-2 cursor-pointer [align-content:center] keyboard-focus-wide"
                    >
                        {{ item.targetLabel }}目标与执行详情
                    </summary>
                    <dl class="effect-details layout-stack break-anywhere pt-4 m-0">
                        <div v-if="item.targetName !== undefined">
                            <dt class="text-muted">{{ item.targetLabel }}内容</dt>
                            <dd class="effect-text whitespace-pre-wrap break-anywhere m-0">
                                {{ item.targetName }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-muted">{{ item.targetLabel }}标识</dt>
                            <dd class="m-0">{{ item.entry.targetId }}</dd>
                        </div>
                        <div v-if="item.entry.query !== undefined">
                            <dt class="text-muted">本条记录的查询</dt>
                            <dd class="effect-text whitespace-pre-wrap break-anywhere m-0">
                                {{ item.entry.query }}
                            </dd>
                        </div>
                        <div v-if="item.entry.url !== undefined">
                            <dt class="text-muted">本条记录的来源网址</dt>
                            <dd class="m-0">
                                <a
                                    class="min-h-11 box-border pt-2 pb-2 cursor-pointer block text-primary underline-offset-[0.2em] keyboard-focus-wide"
                                    v-if="sourceLink(item.entry.url)"
                                    :href="sourceLink(item.entry.url)"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    >{{ item.entry.url }}（在新窗口打开）</a
                                >
                                <p
                                    v-else
                                    class="effect-text whitespace-pre-wrap break-anywhere m-0"
                                >
                                    {{ item.entry.url }}
                                </p>
                            </dd>
                        </div>
                        <div>
                            <dt class="text-muted">反馈标识</dt>
                            <dd class="m-0">{{ item.entry.feedbackId }}</dd>
                        </div>
                    </dl>
                </details>
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { sourceLink } from '@/composables/useReport';
import { reportFeedbackEffects } from '@/utils/feedback-effects';
const props = defineProps<{ report: Report }>();
const effects = computed(() => reportFeedbackEffects(props.report));
</script>
