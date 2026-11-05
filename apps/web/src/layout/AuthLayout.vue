<template>
    <main id="main-content" class="auth-layout" tabindex="-1" aria-labelledby="page-title">
        <auth-backdrop :accent="appearance.accent" :paused="motionPaused" />
        <div class="auth-tools">
            <button
                class="auth-motion"
                type="button"
                :aria-label="motionPaused ? '播放背景动画' : '暂停背景动画'"
                :aria-pressed="motionPaused"
                :title="motionPaused ? '播放背景动画' : '暂停背景动画'"
                @click="motionPaused = !motionPaused"
            >
                <app-icon :name="motionPaused ? 'run' : 'pause'" />
            </button>
            <app-select id="auth-accent" v-model="accent" label="主题" :options="themes" compact />
            <app-select id="auth-appearance" v-model="mode" label="外观" :options="modes" compact />
        </div>
        <div class="auth-panel">
            <div class="auth-brand">Scova</div>
            <section class="auth-card" aria-labelledby="page-title">
                <header class="auth-heading">
                    <h1 id="page-title">{{ title }}</h1>
                    <p>
                        {{
                            title === '注册'
                                ? '创建账号，开始持续追踪与研究。'
                                : '继续你的追踪与研究。'
                        }}
                    </p>
                </header>
                <slot />
            </section>
        </div>
    </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AuthBackdrop from '@/components/auth/AuthBackdrop.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import AppSelect from '@/components/common/AppSelect.vue';
import { useAppearanceStore } from '@/store/appearance';
import { accentOptions, modeOptions, themeTokens } from '@/theme/tokens';

defineProps<{ title: string }>();
const appearance = useAppearanceStore();
const motionPaused = ref(false);
const themes = computed(() =>
    accentOptions.map((option) => ({
        ...option,
        color: themeTokens(option.value, appearance.scheme).primary,
    })),
);
const modes = modeOptions.map((option) => ({ ...option, icon: option.value }));
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
    position: relative;
    isolation: isolate;
    display: flex;
    min-inline-size: 0;
    min-block-size: 100vh;
    min-block-size: 100dvh;
    padding: 5.5rem 1.25rem;
    background: var(--scova-canvas);
}
.auth-layout:focus {
    outline: none;
}
.auth-tools {
    position: absolute;
    inset-block-start: 1rem;
    inset-inline-end: 1.25rem;
    display: flex;
    gap: 0.5rem;
    max-inline-size: calc(100% - 2.5rem);
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    color: var(--scova-muted);
    z-index: 1;
}
.auth-motion {
    display: grid;
    place-items: center;
    inline-size: 2.75rem;
    min-block-size: 2.75rem;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 22%, transparent);
    border-radius: 0.75rem;
    background: var(--scova-surface);
    color: var(--scova-muted);
    font: inherit;
    cursor: pointer;
}
.auth-motion:hover {
    background: var(--scova-selected);
    color: var(--scova-primary);
}
.auth-motion:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
.auth-panel {
    inline-size: min(100%, 28rem);
    min-inline-size: 0;
    margin: auto;
}
.auth-brand {
    margin-block-end: 1.5rem;
    text-align: center;
    color: var(--scova-primary);
    font-size: 1.75rem;
    font-weight: 750;
    letter-spacing: -0.055em;
}
.auth-card {
    padding: 2rem;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 22%, transparent);
    border-radius: 1.5rem;
    background: var(--scova-surface);
}
@supports ((backdrop-filter: blur(1rem)) and (color: color-mix(in srgb, white, transparent))) {
    .auth-card {
        background: linear-gradient(
            145deg,
            color-mix(in srgb, var(--scova-surface) 94%, transparent),
            color-mix(in srgb, var(--scova-surface) 86%, transparent)
        );
        backdrop-filter: blur(1.25rem) saturate(115%);
        box-shadow:
            0 1.5rem 4rem -2rem color-mix(in srgb, var(--scova-text) 16%, transparent),
            inset 0 0.0625rem 0 color-mix(in srgb, var(--scova-surface) 85%, transparent);
    }
}
.auth-card :deep(.n-input) {
    background: var(--scova-surface);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--scova-border) 70%, transparent);
}
:global([data-reduced-transparency='true'] .auth-layout .auth-card) {
    background: var(--scova-surface);
    backdrop-filter: none;
    box-shadow: none;
}
:global([data-reduced-transparency='true'] .auth-layout .auth-backdrop) {
    display: none;
}
:global([data-reduced-transparency='true'] .auth-layout .auth-motion) {
    display: none;
}
@media (prefers-reduced-motion: reduce) {
    .auth-motion {
        display: none;
    }
}
@media (prefers-reduced-transparency: reduce) {
    .auth-card {
        background: var(--scova-surface);
        backdrop-filter: none;
        box-shadow: none;
    }
    .auth-backdrop,
    .auth-motion {
        display: none;
    }
}
.auth-heading {
    margin-block-end: 2rem;
    text-align: center;
}
.auth-heading h1 {
    margin-block-end: 0.5rem;
    font-size: 1.75rem;
    line-height: 1.4;
    font-weight: 650;
}
.auth-heading p {
    color: var(--scova-muted);
}
@media (max-width: 30rem) {
    .auth-tools {
        max-inline-size: calc(100% - 2rem);
        inset-inline-end: 1rem;
    }
    .auth-layout {
        padding-inline: 1rem;
        padding-block-start: 12rem;
    }
    .auth-card {
        padding: 1.5rem 1rem;
    }
}
</style>
