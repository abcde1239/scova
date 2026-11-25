<template>
    <div class="auth-preview" :aria-hidden="interactive ? undefined : true">
        <div class="preview-report">
            <div class="preview-flip" :class="{ 'preview-flip--sources': sources }">
                <div class="preview-card preview-face" :aria-hidden="sources">
                    <div class="preview-row">
                        <span class="preview-status preview-status--done">{{
                            t('auth.showcase.reportStatus')
                        }}</span>
                        <span class="preview-meta">{{ t('auth.showcase.reportMeta') }}</span>
                    </div>
                    <strong class="preview-title">{{ t('auth.showcase.reportTitle') }}</strong>
                    <div class="preview-claim">
                        <span class="preview-label">{{ t('auth.showcase.fact') }}</span>
                        <span
                            >{{ t('auth.showcase.factText') }}<span class="preview-cite">1</span
                            ><span class="preview-cite">2</span></span
                        >
                    </div>
                    <div class="preview-claim">
                        <span class="preview-label preview-label--inference">{{
                            t('auth.showcase.inference')
                        }}</span>
                        <span
                            >{{ t('auth.showcase.inferenceText')
                            }}<span class="preview-cite">4</span></span
                        >
                    </div>
                </div>
                <div
                    v-if="interactive"
                    id="auth-report-sources"
                    class="preview-card preview-face preview-face--back"
                    :aria-hidden="!sources"
                >
                    <strong class="preview-title">{{ t('auth.demo.sources') }}</strong>
                    <ul class="preview-sources" role="list">
                        <li v-for="source in sourceKeys" :key="source.label">
                            <span class="preview-cite">{{ source.number }}</span
                            >{{ t(source.label) }}
                        </li>
                    </ul>
                </div>
            </div>
            <button
                v-if="interactive"
                type="button"
                class="preview-toggle keyboard-focus"
                aria-controls="auth-report-sources"
                :aria-label="t(sources ? 'auth.demo.backToReport' : 'auth.demo.seeSources')"
                :aria-expanded="sources"
                @click="sources = !sources"
            />
        </div>
        <div class="preview-card preview-card--run" aria-hidden="true">
            <div class="preview-row">
                <span class="preview-status">{{ t('auth.showcase.runStatus') }}</span>
                <span class="preview-meta preview-meta--end">{{
                    t('auth.showcase.runProgress')
                }}</span>
            </div>
            <span class="preview-progress"><i /></span>
        </div>
        <div class="preview-card preview-card--watch" aria-hidden="true">
            <div class="preview-row">
                <strong class="preview-title">{{ t('auth.showcase.watchTitle') }}</strong>
                <span class="preview-meta preview-meta--end">{{
                    t('auth.showcase.watchCount')
                }}</span>
            </div>
            <ul class="preview-watch" role="list">
                <li v-for="item in watchItems" :key="item.label">
                    <span>{{ t(item.label) }}</span>
                    <span
                        class="preview-change"
                        :class="{ 'preview-change--quiet': !item.changed }"
                        >{{
                            t(item.changed ? 'auth.showcase.changed' : 'auth.showcase.unchanged')
                        }}</span
                    >
                </li>
            </ul>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ interactive: boolean }>();
const { t } = useI18n({ useScope: 'global' });
const sourceKeys = [
    { number: 1, label: 'auth.demo.sourceRelease' },
    { number: 2, label: 'auth.demo.sourceLicense' },
    { number: 4, label: 'auth.demo.sourceDiscussion' },
] as const;
const watchItems = [
    { label: 'auth.showcase.watchUpstream', changed: true },
    { label: 'auth.showcase.watchRegistry', changed: true },
    { label: 'auth.showcase.watchAdvisory', changed: false },
] as const;
const sources = ref(false);
watch(
    () => props.interactive,
    () => {
        sources.value = false;
    },
);
</script>

<style scoped>
.auth-preview {
    @apply grid gap-0 max-w-[30rem];
}
.preview-card--watch {
    @apply hidden;
}
/* Room beside the report: show the watched sources as a third card. */
@container auth-showcase (min-width: 50rem) {
    .auth-preview {
        @apply [grid-template-columns:minmax(0,_30rem)_14rem] max-w-none;
    }
    .preview-report,
    .preview-card--run {
        grid-column: 1;
    }
    .preview-card--watch {
        @apply grid relative z-1 self-start mt-10 ml-[-1.5rem] [grid-column:2] [grid-row:1_/_span_2];
        rotate: 2deg;
    }
}
.preview-watch {
    @apply grid gap-2 m-0 p-0 list-none text-muted;
}
.preview-watch li {
    @apply flex items-center justify-between gap-2 min-w-0;
}
.preview-watch li > span:first-child {
    @apply min-w-0 truncate;
}
.preview-change {
    @apply shrink-0 rounded-1 px-1.5 text-[0.6875rem] font-bold [color:var(--scova-success)]
        [background:color-mix(in_srgb,_var(--scova-success)_12%,_transparent)];
}
.preview-change--quiet {
    @apply text-muted [background:var(--scova-selected)];
}
.preview-card {
    @apply grid gap-2.5 border-subtle rounded-3.5 bg-surface py-4 px-4.5 text-[0.8125rem]
        [box-shadow:0_0.0625rem_0.125rem_color-mix(in_srgb,_var(--auth-shadow-ink)_6%,_transparent),0_1rem_2.5rem_-0.75rem_color-mix(in_srgb,_var(--auth-shadow-ink)_18%,_transparent)];
}
.preview-card--run {
    @apply relative max-w-[19rem] ml-10 mt-[-0.5rem];
    rotate: 1deg;
}
.preview-row {
    @apply flex items-center gap-2 min-w-0;
}
.preview-status {
    @apply inline-flex items-center gap-1.5 text-[0.75rem] font-semibold text-primary;
}
.preview-status::before {
    @apply content-[''] w-1.75 h-1.75 rounded-full [background:currentColor];
}
.preview-status--done {
    @apply [color:var(--scova-success)];
}
.preview-meta {
    @apply text-muted text-[0.75rem] overflow-hidden text-ellipsis whitespace-nowrap;
}
.preview-meta--end {
    @apply ml-auto;
}
.preview-title {
    @apply text-default text-[0.9375rem] font-semibold;
}
.preview-claim {
    @apply grid [grid-template-columns:auto_1fr] gap-2 leading-[1.6];
}
.preview-label {
    @apply self-start rounded-1 px-1.5 text-[0.6875rem] font-bold whitespace-nowrap
        [color:var(--scova-success)]
        [background:color-mix(in_srgb,_var(--scova-success)_12%,_transparent)];
}
.preview-label--inference {
    @apply [color:var(--scova-partial)]
        [background:color-mix(in_srgb,_var(--scova-partial)_12%,_transparent)];
}
.preview-cite {
    @apply inline-grid place-items-center min-w-4.25 h-4.25 ml-0.5 rounded-1 text-[0.625rem]
        font-bold text-muted [vertical-align:0.1em] [background:var(--scova-selected)];
}
.preview-progress {
    @apply block h-1 rounded-full overflow-hidden [background:var(--scova-selected)];
}
.preview-progress i {
    @apply block w-full h-full origin-left [background:var(--scova-primary)];
    transform: scaleX(0.58);
}
/* On the login tour the run keeps reading sources as the showcase scrolls. */
@media (prefers-reduced-motion: no-preference) {
    @supports (animation-timeline: scroll()) {
        .preview-progress i {
            animation: preview-progress linear both;
            animation-timeline: --auth-tour;
            animation-range: 0% 60%;
        }
    }
}
@keyframes preview-progress {
    to {
        transform: scaleX(1);
    }
}
.preview-report {
    position: relative;
    perspective: 52rem;
    rotate: -1deg;
}
.preview-flip {
    display: grid;
}
.preview-face {
    grid-area: 1 / 1;
    align-content: center;
}
.preview-face[aria-hidden='true'] {
    visibility: hidden;
}
.preview-sources {
    @apply grid gap-2 m-0 p-0 list-none text-muted;
}
.preview-sources li {
    @apply flex items-start gap-2;
}
.preview-sources .preview-cite {
    @apply shrink-0 text-primary;
}
.preview-toggle {
    @apply absolute inset-0 w-full h-full p-0 rounded-3.5 border-none bg-transparent cursor-pointer;
}
@media (prefers-reduced-motion: no-preference) {
    .preview-flip {
        transform-style: preserve-3d;
        transition: transform 440ms cubic-bezier(0.25, 0.75, 0.25, 1);
    }
    .preview-face,
    .preview-face[aria-hidden='true'] {
        visibility: visible;
        backface-visibility: hidden;
    }
    .preview-face--back,
    .preview-flip--sources {
        transform: rotateY(180deg);
    }
}
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
    .preview-report,
    .preview-card--run,
    .preview-card--watch {
        transition:
            translate 240ms ease-out,
            rotate 240ms ease-out;
    }
    .auth-preview:not([aria-hidden='true']):hover .preview-report {
        translate: 0 -0.35rem;
        rotate: -3deg;
    }
    .auth-preview:not([aria-hidden='true']):hover .preview-card--run {
        translate: 0 -0.1rem;
        rotate: 2.75deg;
    }
    .auth-preview:not([aria-hidden='true']):hover .preview-card--watch {
        translate: 0.25rem -0.3rem;
        rotate: 3deg;
    }
}
</style>
