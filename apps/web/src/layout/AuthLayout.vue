<template>
    <main id="main-content" class="auth-layout" tabindex="-1" aria-labelledby="page-title">
        <aside class="auth-showcase" :aria-label="t('auth.highlights.label')">
            <div class="auth-wordmark">
                <span class="auth-mark" aria-hidden="true">S</span>
                <span lang="en">Scova</span>
            </div>
            <div class="auth-pitch">
                <p class="auth-headline">
                    {{ t('auth.showcase.lead') }}<br /><em>{{ t('auth.showcase.emphasis') }}</em>
                </p>
                <div class="auth-preview" aria-hidden="true">
                    <div class="preview-card">
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
                    <div class="preview-card preview-card--run">
                        <div class="preview-row">
                            <span class="preview-status">{{ t('auth.showcase.runStatus') }}</span>
                            <span class="preview-meta preview-meta--end">{{
                                t('auth.showcase.runProgress')
                            }}</span>
                        </div>
                        <span class="preview-progress"><i /></span>
                    </div>
                </div>
            </div>
            <ul class="auth-highlights">
                <li v-for="item in highlights" :key="item.label">
                    <app-icon :name="item.icon" />{{ t(item.label) }}
                </li>
            </ul>
        </aside>
        <div class="auth-form-column">
            <div class="auth-tools">
                <app-select
                    id="auth-accent"
                    v-model="accent"
                    :label="t('auth.theme')"
                    :options="themes"
                    compact
                />
                <app-select
                    id="auth-appearance"
                    v-model="mode"
                    :label="t('pages.appearance')"
                    :options="modes"
                    compact
                />
                <interface-language-select />
            </div>
            <div class="auth-panel">
                <div class="auth-brand">
                    <div class="auth-wordmark">
                        <span class="auth-mark" aria-hidden="true">S</span>
                        <span lang="en">Scova</span>
                    </div>
                    <p>{{ t('auth.tagline') }}</p>
                </div>
                <header class="auth-heading">
                    <h1 id="page-title">{{ title }}</h1>
                    <p>{{ t(register ? 'auth.start' : 'auth.resume') }}</p>
                </header>
                <section class="auth-form" aria-labelledby="page-title">
                    <slot />
                </section>
            </div>
        </div>
    </main>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed } from 'vue';
import InterfaceLanguageSelect from '@/component/common/InterfaceLanguageSelect.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import AppSelect from '@/component/common/AppSelect.vue';
import { useAppearanceStore } from '@/store/appearance';
import { accentOptions, modeOptions, themeTokens } from '@/utils/theme/tokens';

defineProps<{ title: string; register: boolean }>();
const appearance = useAppearanceStore();
const { t } = useI18n({ useScope: 'global' });

const highlights = [
    { label: 'auth.highlights.track', icon: 'search' },
    { label: 'auth.highlights.research', icon: 'report' },
    { label: 'auth.highlights.trace', icon: 'workflows' },
] as const;
const themes = computed(() =>
    accentOptions.map((option) => ({
        ...option,
        label: t(`colors.${option.value}`),
        color: themeTokens(option.value, appearance.scheme).primary,
    })),
);
const modes = computed(() =>
    modeOptions.map((option) => ({
        ...option,
        label: t(`modes.${option.value}`),
        icon: option.value,
    })),
);
const accent = computed({
    get: () => appearance.accent,
    set: (value: string) => {
        if (accentOptions.some((option) => option.value === value))
            appearance.setAccent(value as typeof appearance.accent);
    },
});
const mode = computed({
    get: () => appearance.mode,
    set: (value: string) => {
        if (modeOptions.some((option) => option.value === value))
            appearance.setMode(value as typeof appearance.mode);
    },
});
</script>

<style scoped>
/* Static split layout: product showcase on wide screens, a single form column otherwise. */
.auth-layout {
    --auth-line: color-mix(in srgb, var(--scova-border) 24%, transparent);
    --auth-shadow-ink: var(--scova-text);
    @apply grid min-w-0 min-h-[100dvh] [background:var(--scova-surface)] focus:[outline:none];
}
.scova-theme--dark .auth-layout {
    --auth-shadow-ink: var(--scova-canvas);
}
.auth-showcase {
    @apply hidden;
}
.auth-form-column {
    @apply relative flex flex-col min-w-0 py-6 px-5 [@media(max-width:_30rem)]:px-4;
}
.auth-tools {
    @apply flex flex-wrap justify-end items-center gap-2 text-muted;
}
.auth-panel {
    @apply grid gap-8 w-[min(100%,_24rem)] min-w-0 m-auto pt-10 pb-6;
}
.auth-wordmark {
    @apply inline-flex items-center gap-2.5 text-default text-[1.25rem] [font-weight:700]
        [letter-spacing:-0.03em];
}
.auth-mark {
    @apply grid place-items-center w-8 h-8 rounded-2.5 [background:var(--scova-primary)]
        [color:var(--scova-on-primary)] text-[1rem] [font-weight:800] [letter-spacing:0];
}
.auth-brand {
    @apply grid gap-2;
}
.auth-brand p,
.auth-heading p {
    @apply m-0 text-muted text-[0.9375rem] leading-[1.6];
}
.auth-heading h1 {
    @apply mb-1.5 text-[1.625rem] leading-[1.35] [font-weight:650] [letter-spacing:-0.02em];
}
.auth-form :deep(.n-input) {
    @apply bg-surface rounded-2.5
        [box-shadow:inset_0_0_0_0.0625rem_color-mix(in_srgb,_var(--scova-border)_70%,_transparent)];
}

@media (min-width: 54rem) {
    .auth-layout {
        @apply [grid-template-columns:minmax(0,_1.1fr)_minmax(0,_1fr)];
    }
    .auth-showcase {
        @apply relative [isolation:isolate] grid [grid-template-rows:auto_1fr_auto] gap-8 min-w-0
            overflow-hidden py-10 px-[clamp(2rem,_4vw,_4rem)]
            [background:color-mix(in_srgb,_var(--scova-primary)_6%,_var(--scova-canvas))]
            [border-right:0.0625rem_solid_var(--auth-line)];
    }
    /* Static grid that fades toward the lower right; purely decorative. */
    .auth-showcase::before {
        @apply content-[''] absolute [inset:0] z-[-1] opacity-70
            [background-image:linear-gradient(var(--auth-line)_1px,_transparent_1px),linear-gradient(90deg,_var(--auth-line)_1px,_transparent_1px)]
            [background-size:2.5rem_2.5rem]
            [mask-image:linear-gradient(160deg,_#000,_transparent_70%)];
    }
    .auth-brand {
        @apply hidden;
    }
}

.auth-pitch {
    @apply grid content-center gap-8 max-w-[32rem];
}
.auth-headline {
    @apply m-0 text-default text-[clamp(1.75rem,_2.6vw,_2.25rem)] leading-[1.3] [font-weight:650]
        [letter-spacing:-0.02em];
}
.auth-headline em {
    @apply not-italic text-primary;
}
.auth-preview {
    @apply grid gap-0 max-w-[28rem];
}
.preview-card {
    @apply grid gap-2.5 border-subtle rounded-3.5 bg-surface py-4 px-4.5 text-[0.8125rem]
        [transform:rotate(-1deg)]
        [box-shadow:0_0.0625rem_0.125rem_color-mix(in_srgb,_var(--auth-shadow-ink)_6%,_transparent),0_1rem_2.5rem_-0.75rem_color-mix(in_srgb,_var(--auth-shadow-ink)_18%,_transparent)];
}
.preview-card--run {
    @apply max-w-[19rem] ml-10 mt-[-0.5rem] [transform:rotate(1deg)];
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
.auth-highlights {
    @apply flex flex-wrap gap-x-5 gap-y-2 m-0 p-0 [list-style:none] text-muted text-[0.8125rem];
}
.auth-highlights li {
    @apply inline-flex items-center gap-1.5;
}
.auth-highlights :deep(svg) {
    @apply text-primary;
}

@media (prefers-reduced-transparency: reduce) {
    .auth-showcase::before {
        @apply hidden;
    }
}
</style>
