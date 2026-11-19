<template>
    <span v-if="firstSource" class="source-preview scova-interface">
        <button
            v-if="supportsPopover"
            ref="trigger"
            type="button"
            class="source-chip keyboard-focus-wide"
            v-bind="triggerAttributes"
            :aria-expanded="open"
            :aria-label="`查看引用来源：${firstSource.label}，共 ${sources.length} 个网页`"
            @keydown.esc="dismissOnEscape"
        >
            <span
                class="source-mark"
                :class="{ 'source-mark--wiki': firstSource.isWikipedia }"
                aria-hidden="true"
                >{{ firstSource.mark }}</span
            >
            <span class="source-chip-label">{{ firstSource.label }}</span>
            <span v-if="sources.length > 1">+{{ sources.length - 1 }}</span>
        </button>
        <a
            v-else
            :href="`#evidence-${firstSource.evidence[0]!.id}`"
            class="source-chip keyboard-focus-wide"
        >
            <span
                class="source-mark"
                :class="{ 'source-mark--wiki': firstSource.isWikipedia }"
                aria-hidden="true"
                >{{ firstSource.mark }}</span
            >
            <span class="source-chip-label">{{ firstSource.label }}</span>
            <span v-if="sources.length > 1">+{{ sources.length - 1 }}</span>
        </a>
        <span
            v-if="supportsPopover"
            :id="id"
            ref="panel"
            v-bind="panelAttributes"
            class="source-preview-panel"
            role="region"
            aria-label="引用来源"
            @toggle="syncOpen"
            @keydown.esc="dismissOnEscape"
        >
            <template v-if="open">
                <span class="source-preview-header">
                    <strong>引用来源 · {{ sources.length }}</strong>
                    <button
                        type="button"
                        class="source-close keyboard-focus-wide"
                        aria-label="关闭引用来源"
                        @click="dismiss()"
                    >
                        <app-icon name="close" />
                    </button>
                </span>
                <span class="source-preview-list">
                    <span v-for="source in sources" :key="source.key" class="source-preview-entry">
                        <span class="source-site">
                            <span
                                class="source-mark"
                                :class="{ 'source-mark--wiki': source.isWikipedia }"
                                aria-hidden="true"
                                >{{ source.mark }}</span
                            >
                            {{ source.label }}
                        </span>
                        <a
                            v-if="source.link"
                            class="source-title keyboard-focus-wide"
                            :href="source.link"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            {{ source.title }} <app-icon name="source" />
                            <span class="sr-only">（在新标签页打开）</span>
                        </a>
                        <strong v-else class="source-title">{{ source.title }}</strong>
                        <span class="source-excerpt">{{ source.evidence[0]!.quote }}</span>
                        <a
                            :href="`#evidence-${source.evidence[0]!.id}`"
                            class="source-jump keyboard-focus-wide"
                            @click="jumpToEvidence"
                        >
                            查看保存引用
                        </a>
                    </span>
                </span>
            </template>
        </span>
    </span>
</template>

<script setup lang="ts">
import { computed, onDeactivated, ref, useId } from 'vue';
import type { Evidence } from '@scova/models';
import AppIcon from '@/component/common/AppIcon.vue';
import { sourceLink } from '@/utils/source/link';
import { groupEvidence } from '@/utils/report/sources';

const props = defineProps<{ evidence: Evidence[] }>();
const id = `source-preview-${useId()}`;
// Vue’s HTML declarations do not yet include the native popover attributes.
const triggerAttributes = { popovertarget: id };
const panelAttributes = { popover: 'auto' };
const supportsPopover =
    typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
const open = ref(false);
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const sources = computed(() =>
    groupEvidence(props.evidence).map((group) => {
        const link = sourceLink(group.url);
        const domain = link ? new URL(link).hostname.replace(/^www\./, '') : '';
        const isWikipedia = /(?:^|\.)wikipedia\.org$/i.test(domain);
        const label = isWikipedia ? '维基百科' : domain || '来源';
        // Keep the preview local rather than requesting third-party favicons.
        const mark = isWikipedia ? 'W' : domain.charAt(0).toUpperCase() || '↗';
        return { ...group, link, label, mark, isWikipedia };
    }),
);

const firstSource = computed(() => sources.value[0]);

function syncOpen() {
    open.value = panel.value?.matches(':popover-open') ?? false;
}
function dismiss(restoreFocus = true) {
    if (!panel.value?.matches(':popover-open')) return;
    panel.value.hidePopover();
    if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function dismissOnEscape(event: KeyboardEvent) {
    if (event.isComposing || !panel.value?.matches(':popover-open')) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
}
function jumpToEvidence(event: MouseEvent) {
    if (!event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
        dismiss(false);
}
onDeactivated(() => dismiss(false));
</script>

<style scoped>
.source-preview {
    font-weight: 400;
    white-space: normal;
}
.source-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    max-inline-size: min(calc(100% - 0.35rem), 16rem);
    min-block-size: 1.5rem;
    margin-inline-start: 0.35rem;
    padding: 0.18em 0.64em 0.18em 0.31em;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--scova-muted) 17%, var(--scova-surface));
    color: var(--scova-muted);
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.25;
    text-decoration: none;
    vertical-align: 0.08em;
    cursor: pointer;
}
.source-chip:hover,
.source-chip[aria-expanded='true'] {
    color: var(--scova-text);
    background: color-mix(in srgb, var(--scova-muted) 26%, var(--scova-surface));
}
.source-chip-label {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.source-mark {
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 1.4em;
    block-size: 1.4em;
    border-radius: 50%;
    background: var(--scova-selected);
    color: var(--scova-text);
    font-weight: 650;
    line-height: 1;
}
.source-mark--wiki {
    background: #f8f9fa;
    color: #202122;
    font-family: Georgia, serif;
    font-weight: 700;
}
.source-preview-panel {
    box-sizing: border-box;
    inline-size: min(28rem, calc(100vw - 2rem));
    max-block-size: min(26rem, calc(100dvh - 2rem));
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--scova-border) 34%, transparent);
    border-radius: 1.4rem;
    padding: 0.5rem;
    color: var(--scova-text);
    background: color-mix(in srgb, var(--scova-surface) 94%, var(--scova-text));
    box-shadow: 0 0.35rem 1.25rem rgb(0 0 0 / 23%);
    text-align: start;
    white-space: normal;
    overflow-wrap: anywhere;
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.45;
}
.source-preview-panel:popover-open {
    display: flex;
    flex-direction: column;
}
@supports (position-area: block-end) and (position-try-fallbacks: flip-block) {
    .source-preview-panel {
        inset: auto;
        margin: 0.45rem 0;
        max-block-size: min(26rem, 44dvh);
        position-area: block-end span-inline-end;
        position-try-fallbacks:
            flip-inline,
            flip-block,
            flip-block flip-inline;
    }
}
.source-preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-inline: 0.65rem 0.25rem;
    color: var(--scova-muted);
    font-size: 0.75rem;
}
.source-close {
    display: grid;
    place-items: center;
    flex: none;
    min-inline-size: 2rem;
    min-block-size: 2rem;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;
}
.source-close:hover {
    background: var(--scova-selected);
    color: var(--scova-text);
}
.source-preview-list {
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding-inline: 0.65rem;
}
.source-preview-entry {
    display: grid;
    gap: 0.25rem;
    padding-block: 0.55rem 0.7rem;
}
.source-preview-entry + .source-preview-entry {
    padding-block-start: 0.75rem;
    border-block-start: 1px solid color-mix(in srgb, var(--scova-border) 45%, transparent);
}
.source-site {
    display: flex;
    align-items: center;
    gap: 0.45em;
    color: var(--scova-muted);
    font-size: 0.8125rem;
    font-weight: 500;
}
.source-site .source-mark {
    inline-size: 1.55em;
    block-size: 1.55em;
}
.source-title {
    justify-self: start;
    color: inherit;
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.35;
}
.source-title > :deep(.app-icon) {
    color: var(--scova-muted);
    font-size: 0.83em;
}
.source-excerpt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.source-jump {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    min-block-size: 1.5rem;
    color: var(--scova-muted);
    font-size: 0.75rem;
}
:is(a.source-title, .source-jump):hover {
    color: var(--scova-primary);
    text-decoration: underline;
}
@media (max-width: 40rem) {
    .source-preview-panel {
        inset: auto 0 max(1rem, env(safe-area-inset-bottom));
        margin: 0 auto;
        /* Leave more of the claim visible while the list scrolls. */
        max-block-size: min(26rem, 38dvh);
        position-area: none;
        position-try-fallbacks: none;
    }
    .source-preview-entry {
        gap: 0.1875rem;
        padding-block: 0.4rem 0.45rem;
    }
    .source-preview-entry + .source-preview-entry {
        padding-block-start: 0.55rem;
    }
}
</style>
