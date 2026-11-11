<template>
    <main
        id="main-content"
        class="auth-layout relative [isolation:isolate] flex min-w-0 min-h-[100dvh] [background:var(--scova-canvas)] py-[5.5rem] px-5 focus:[outline:none] [@media(max-width:_30rem)]:(pl-4 pr-4 pt-[12rem])"
        tabindex="-1"
        aria-labelledby="page-title"
    >
        <auth-backdrop
            class="[@media(prefers-reduced-transparency:_reduce)]:[&&]:hidden"
            :accent="appearance.accent"
            :paused="motionPaused"
        />
        <div
            class="auth-tools absolute [top:1rem] [right:1.25rem] flex gap-2 max-w-[calc(100%_-_2.5rem)] flex-wrap justify-end items-center text-muted z-[1] [@media(max-width:_30rem)]:(max-w-[calc(100%_-_2rem)] [right:1rem])"
        >
            <button
                class="auth-motion grid place-items-center w-11 min-h-11 [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_22%,_transparent)] rounded-3 bg-surface text-muted font-inherit cursor-pointer keyboard-focus hover:([background:var(--scova-selected)] text-primary) [@media(prefers-reduced-motion:_reduce)]:hidden [@media(prefers-reduced-transparency:_reduce)]:hidden"
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
        <div class="auth-panel w-[min(100%,_28rem)] min-w-0 m-[auto]">
            <div
                class="auth-brand mb-6 text-center text-primary text-[1.75rem] [font-weight:750] [letter-spacing:-0.055em]"
            >
                Scova
            </div>
            <section
                class="auth-card [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_22%,_transparent)] rounded-6 bg-surface p-8 [&.auth-card_.n-input]:(bg-surface [box-shadow:inset_0_0_0_0.0625rem_color-mix(in_srgb,_var(--scova-border)_70%,_transparent)]) [@media(prefers-reduced-transparency:_reduce)]:(bg-surface [backdrop-filter:none] [box-shadow:none]) [@media(max-width:_30rem)]:(py-6 px-4)"
                aria-labelledby="page-title"
            >
                <header class="auth-heading mb-8 text-center">
                    <h1
                        class="[.auth-heading_&:is(h1)]:(mb-2 text-[1.75rem] leading-[1.4] [font-weight:650])"
                        id="page-title"
                    >
                        {{ title }}
                    </h1>
                    <p class="[.auth-heading_&:is(p)]:text-muted">
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
</style>
