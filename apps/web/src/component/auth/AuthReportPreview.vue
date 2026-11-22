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
        <button
            v-if="interactive"
            type="button"
            class="preview-switch keyboard-focus"
            aria-controls="auth-report-sources"
            :aria-expanded="sources"
            @click="sources = !sources"
        >
            <app-icon :name="sources ? 'back' : 'source'" />{{
                t(sources ? 'auth.demo.backToReport' : 'auth.demo.seeSources')
            }}
        </button>
    </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppIcon from '@/component/common/AppIcon.vue';

const props = defineProps<{ interactive: boolean }>();
const { t } = useI18n({ useScope: 'global' });
const sourceKeys = [
    { number: 1, label: 'auth.demo.sourceRelease' },
    { number: 2, label: 'auth.demo.sourceLicense' },
    { number: 4, label: 'auth.demo.sourceDiscussion' },
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
    @apply grid gap-0 max-w-[28rem];
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
    @apply block w-[58%] h-full [background:var(--scova-primary)];
}
.preview-report {
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
.preview-switch {
    @apply inline-flex items-center gap-1.5 justify-self-end mt-1 px-2 min-h-11
        rounded-2 border-none bg-transparent text-primary text-[0.8125rem] cursor-pointer font-inherit;
}
.preview-switch:hover {
    background: var(--scova-selected);
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
    .preview-card--run {
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
}
</style>
