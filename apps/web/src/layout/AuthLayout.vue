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
                <div v-if="!register" class="auth-ambient" aria-hidden="true">
                    <span class="auth-grid" />
                    <span class="auth-glow auth-glow--a" />
                    <span class="auth-glow auth-glow--b" />
                    <span
                        v-for="chip in ambientChips"
                        :key="chip.text"
                        class="auth-chip"
                        lang="en"
                        :style="{ '--x': chip.x, '--y': chip.y, '--rise': chip.rise }"
                        >{{ chip.text }}</span
                    >
                    <span class="auth-rail"><i /></span>
                </div>
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
                            <span class="auth-explore-icon"><app-icon name="expand" /></span>
                            {{ t('auth.demo.explore') }}
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
                        icon="appearance"
                        compact
                        icon-only
                    />
                    <app-select
                        id="auth-appearance"
                        v-model="mode"
                        :label="t('pages.appearance')"
                        :options="modes"
                        compact
                        icon-only
                    />
                    <interface-language-select icon-only />
                </div>
                <div class="auth-panel">
                    <div class="auth-brand">
                        <div class="auth-wordmark">
                            <span class="auth-mark" aria-hidden="true">S</span>
                            <span lang="en">Scova</span>
                        </div>
                        <p>{{ t('auth.tagline') }}</p>
                    </div>
                    <header class="auth-heading" :class="{ 'auth-heading--login': !register }">
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

// Decorative source fragments; each rises at its own speed while the showcase scrolls.
const ambientChips = [
    { text: 'CHANGELOG.md', x: '78%', y: '14%', rise: '-35dvh' },
    { text: 'LICENSE', x: '88%', y: '56%', rise: '-70dvh' },
    { text: 'issue #482', x: '80%', y: '88%', rise: '-100dvh' },
    { text: 'v3.2.0', x: '90%', y: '122%', rise: '-140dvh' },
    { text: 'RFC 0042', x: '82%', y: '156%', rise: '-175dvh' },
    { text: 'SECURITY.md', x: '86%', y: '196%', rise: '-215dvh' },
] as const;
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
    @apply flex flex-wrap justify-end items-center gap-1 text-muted;
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
    @apply inline-flex items-center gap-3 min-h-11 justify-self-start rounded-2
        text-muted text-[0.8125rem] font-medium no-underline hover:text-default;
}
.auth-explore-icon {
    @apply inline-grid place-items-center w-8 h-8 shrink-0 rounded-full border-subtle;
}
.auth-explore:is(:hover, :focus-visible) .auth-explore-icon {
    @apply [border-color:var(--scova-primary)] text-primary;
}
@media (prefers-reduced-motion: no-preference) {
    .auth-heading--login {
        animation: auth-heading-in 220ms ease-out;
    }
    .auth-explore-icon :deep(.app-icon) {
        transition: translate 160ms ease-out;
    }
    .auth-explore:focus-visible .auth-explore-icon :deep(.app-icon) {
        translate: 0 0.1875rem;
    }
    @media (hover: hover) {
        .auth-explore:hover .auth-explore-icon :deep(.app-icon) {
            translate: 0 0.1875rem;
        }
    }
}
@keyframes auth-heading-in {
    from {
        opacity: 0.72;
        transform: translateY(0.25rem);
    }
}

@media (min-width: 54rem) {
    .auth-hero {
        @apply [grid-template-columns:minmax(0,_1fr)_minmax(26rem,_min(42%,_36rem))];
    }
    .auth-form-column {
        @apply grid [grid-template-rows:2.75rem_1fr_2.75rem] px-8;
    }
    .auth-tools {
        @apply self-start;
    }
    .auth-panel {
        @apply w-[min(100%,_28rem)] py-6;
    }
    .auth-showcase {
        --auth-grid-line: color-mix(in srgb, var(--scova-border) 12%, transparent);
        container: auth-showcase / inline-size;
        @apply block min-w-0 overflow-hidden
            [background:color-mix(in_srgb,_var(--scova-primary)_6%,_var(--scova-canvas))]
            [border-inline-end:0.0625rem_solid_var(--auth-line)];
    }
    .auth-showcase,
    .auth-grid {
        background-image:
            linear-gradient(var(--auth-grid-line) 1px, transparent 1px),
            linear-gradient(90deg, var(--auth-grid-line) 1px, transparent 1px);
        background-size: 2.5rem 2.5rem;
    }
    .auth-showcase--tour {
        @apply h-[100dvh] [overflow-y:auto] [overscroll-behavior-y:contain] [scrollbar-width:none] keyboard-focus-inset;
    }
    .auth-showcase-intro {
        @apply relative [isolation:isolate] grid [grid-template-rows:auto_1fr_auto] gap-8 min-w-0 min-h-[100dvh]
            overflow-hidden py-8 px-[clamp(2rem,_4vw,_4rem)];
    }
    .auth-brand {
        @apply hidden;
    }
}

@supports not (scrollbar-width: none) {
    .auth-showcase--tour::-webkit-scrollbar {
        display: none;
    }
}

@media (min-width: 54rem) and (prefers-reduced-motion: no-preference) {
    @supports ((animation-timeline: view()) and (animation-range: exit)) {
        .auth-showcase--tour .auth-showcase-intro {
            view-timeline: --auth-intro block;
        }
        .auth-showcase--tour .auth-pitch {
            animation: auth-pitch-depth linear both;
            animation-timeline: --auth-intro;
            animation-range: exit 0% exit 100%;
        }
        .auth-showcase--tour .auth-showcase-footer {
            animation: auth-footer-out linear both;
            animation-timeline: --auth-intro;
            animation-range: exit 0% exit 70%;
        }
    }
}
@keyframes auth-footer-out {
    to {
        opacity: 0.2;
        transform: translateY(2rem);
    }
}
@keyframes auth-pitch-depth {
    to {
        transform: translateY(3rem);
    }
}

/* Ambient layer: fills the empty strips; under motion it keeps every part moving while scrolling. */
.auth-ambient,
.auth-grid {
    @apply hidden;
}
@media (min-width: 54rem) {
    .auth-showcase--tour > :not(.auth-ambient) {
        @apply relative z-1;
    }
    .auth-ambient {
        @apply block sticky top-0 z-0 h-[100dvh] mb-[-100dvh] overflow-hidden pointer-events-none;
    }
    .auth-glow {
        @apply absolute w-[32rem] h-[32rem] rounded-full
            [background:radial-gradient(closest-side,_color-mix(in_srgb,_var(--scova-primary)_14%,_transparent),_transparent)];
    }
    .auth-glow--a {
        @apply top-[-8rem] right-[-10rem];
    }
    .auth-glow--b {
        @apply bottom-[-12rem] left-[-8rem];
    }
    .auth-chip {
        @apply absolute left-[var(--x)] top-[var(--y)] rounded-2 px-2 py-1 border-subtle text-muted
            text-[0.6875rem] font-medium whitespace-nowrap opacity-70
            [background:color-mix(in_srgb,_var(--scova-surface)_70%,_transparent)];
    }
    /* Progress only means something when it follows the scroll. */
    .auth-rail {
        @apply hidden;
    }
}
@media (min-width: 54rem) and (prefers-reduced-motion: no-preference) {
    @supports (animation-timeline: scroll()) {
        .auth-showcase--tour {
            --auth-grid-travel: 30rem;
            scroll-timeline: --auth-tour block;
            background-image: none;
        }
        .auth-grid {
            /* Overscan by the travel distance so the clipped grid always covers the showcase. */
            @apply block absolute inset-0;
            inset-block-end: calc(-1 * var(--auth-grid-travel));
        }
        .auth-grid,
        .auth-glow,
        .auth-chip,
        .auth-rail i {
            animation: linear both;
            animation-timeline: --auth-tour;
        }
        .auth-grid {
            animation-name: auth-grid-drift;
        }
        .auth-glow--a {
            animation-name: auth-glow-a;
        }
        .auth-glow--b {
            animation-name: auth-glow-b;
        }
        .auth-chip {
            animation-name: auth-chip-rise;
        }
        .auth-rail {
            @apply block absolute top-[18%] bottom-[18%] right-4 w-0.5 rounded-full
                [background:color-mix(in_srgb,_var(--scova-border)_30%,_transparent)];
        }
        .auth-rail i {
            @apply block h-full rounded-full origin-top [background:var(--scova-primary)];
            animation-name: auth-rail-fill;
        }
    }
}
@keyframes auth-grid-drift {
    to {
        transform: translateY(calc(-1 * var(--auth-grid-travel)));
    }
}
@keyframes auth-glow-a {
    to {
        transform: translate(-24rem, 60dvh);
    }
}
@keyframes auth-glow-b {
    to {
        transform: translate(20rem, -50dvh);
    }
}
@keyframes auth-chip-rise {
    to {
        transform: translateY(var(--rise));
    }
}
@keyframes auth-rail-fill {
    from {
        transform: scaleY(0.04);
    }
}
@media (prefers-reduced-motion: reduce) {
    .auth-showcase {
        background-attachment: local;
    }
}

.auth-pitch {
    @apply grid content-center gap-8 max-w-[34rem];
}
/* The showcase grows with the viewport while the form column stays capped; fill it in steps. */
@container auth-showcase (min-width: 50rem) {
    .auth-pitch {
        @apply max-w-[46rem];
    }
}
@container auth-showcase (min-width: 76rem) {
    .auth-pitch {
        @apply [grid-template-columns:minmax(0,_1fr)_auto] items-center gap-16 max-w-[80rem];
    }
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
    .auth-showcase {
        background-image: none;
    }
}
</style>
