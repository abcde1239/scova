<template>
    <main id="main-content" class="auth-layout" tabindex="-1" aria-labelledby="page-title">
        <div class="auth-hero">
            <aside
                ref="showcase"
                class="auth-showcase"
                :class="{ 'auth-showcase--tour': !register }"
                :tabindex="register ? undefined : 0"
                :aria-label="t('auth.highlights.label')"
            >
                <div id="auth-start" class="auth-showcase-intro">
                    <div class="auth-wordmark">
                        <span class="auth-mark" aria-hidden="true">S</span>
                        <span lang="en">Scova</span>
                    </div>
                    <div class="auth-pitch">
                        <p class="auth-headline">
                            {{ t('auth.showcase.lead') }}<br /><em>{{
                                t('auth.showcase.emphasis')
                            }}</em>
                        </p>
                        <auth-report-preview :interactive="!register" />
                    </div>
                    <div class="auth-showcase-footer">
                        <ul class="auth-highlights">
                            <li v-for="item in highlights" :key="item.label">
                                <app-icon :name="item.icon" />{{ t(item.label) }}
                            </li>
                        </ul>
                        <a
                            v-if="!register"
                            ref="explore"
                            class="auth-explore keyboard-focus"
                            href="#auth-demo-title"
                            @click.prevent="showDemo"
                        >
                            {{ t('auth.demo.explore') }} <app-icon name="expand" />
                        </a>
                    </div>
                </div>
                <auth-product-demo v-if="!register" @back="showIntro" />
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
        </div>
    </main>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed, ref, watch } from 'vue';
import InterfaceLanguageSelect from '@/component/common/InterfaceLanguageSelect.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import AppSelect from '@/component/common/AppSelect.vue';
import AuthReportPreview from '@/component/auth/AuthReportPreview.vue';
import AuthProductDemo from '@/component/auth/AuthProductDemo.vue';
import { useAppearanceStore } from '@/store/appearance';
import { accentOptions, modeOptions, themeTokens } from '@/utils/theme/tokens';

const props = defineProps<{ title: string; register: boolean }>();
const appearance = useAppearanceStore();
const { t } = useI18n({ useScope: 'global' });

const showcase = ref<HTMLElement>();
const explore = ref<HTMLAnchorElement>();

function scrollShowcase(top: number) {
    showcase.value?.scrollTo({
        top,
        behavior: window.matchMedia('(prefers-reduced-motion: no-preference)').matches
            ? 'smooth'
            : 'instant',
    });
}
function showDemo() {
    const scroller = showcase.value;
    const demo = scroller?.querySelector<HTMLElement>('#auth-demo');
    const title = demo?.querySelector<HTMLElement>('#auth-demo-title');
    if (!scroller || !demo || !title) return;
    title.focus({ preventScroll: true });
    scrollShowcase(
        demo.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop,
    );
}
function showIntro() {
    explore.value?.focus({ preventScroll: true });
    scrollShowcase(0);
}
watch(
    () => props.register,
    () => showcase.value?.scrollTo(0, 0),
);

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
.auth-layout {
    --auth-line: color-mix(in srgb, var(--scova-border) 24%, transparent);
    --auth-shadow-ink: var(--scova-text);
    @apply min-w-0 [background:var(--scova-surface)] focus:[outline:none];
}
.auth-hero {
    @apply grid min-w-0 min-h-[100dvh];
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

.auth-showcase-footer {
    @apply grid gap-3;
}
.auth-explore {
    @apply inline-flex items-center gap-2 min-h-11 justify-self-start rounded-2
        text-primary text-[0.875rem] font-medium underline underline-offset-4;
}

@media (min-width: 54rem) {
    .auth-hero {
        @apply [grid-template-columns:minmax(0,_1.1fr)_minmax(0,_1fr)];
    }
    .auth-showcase {
        @apply block min-w-0 overflow-hidden
            [background:color-mix(in_srgb,_var(--scova-primary)_6%,_var(--scova-canvas))]
            [border-inline-end:0.0625rem_solid_var(--auth-line)];
    }
    .auth-showcase--tour {
        @apply h-[100dvh] [overflow-y:auto] [overscroll-behavior-y:contain] keyboard-focus-inset;
    }
    .auth-showcase-intro {
        @apply relative [isolation:isolate] grid [grid-template-rows:auto_1fr_auto] gap-8 min-w-0 min-h-[100dvh]
            overflow-hidden py-8 px-[clamp(2rem,_4vw,_4rem)];
    }
    /* Static grid that fades toward the lower right; purely decorative. */
    .auth-showcase-intro::before {
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
    .auth-showcase-intro::before {
        @apply hidden;
    }
}
</style>
