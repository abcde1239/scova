<template>
    <div
        class="auth-backdrop"
        :class="[`auth-backdrop--${accent}`, { 'is-paused': paused }]"
        aria-hidden="true"
    >
        <svg viewBox="0 0 1440 1000" preserveAspectRatio="none" focusable="false">
            <defs>
                <linearGradient :id="`${id}-front`" x1="0" y1="0" x2="1" y2="1">
                    <stop stop-color="var(--ribbon-light)" />
                    <stop offset="0.35" stop-color="var(--scova-primary)" />
                    <stop offset="0.68" stop-color="var(--ribbon-deep)" />
                    <stop offset="1" stop-color="var(--ribbon-light)" />
                </linearGradient>
                <linearGradient :id="`${id}-back`" x1="1" y1="0" x2="0" y2="1">
                    <stop stop-color="var(--ribbon-light)" />
                    <stop offset="0.48" stop-color="var(--ribbon-accent)" />
                    <stop offset="1" stop-color="var(--scova-primary)" />
                </linearGradient>
                <linearGradient :id="`${id}-edge`" x1="0" y1="0" x2="1" y2="1">
                    <stop stop-color="white" stop-opacity="0.7" />
                    <stop offset="0.55" stop-color="white" stop-opacity="0.08" />
                    <stop offset="1" stop-color="white" stop-opacity="0.45" />
                </linearGradient>
            </defs>
            <g class="ribbon ribbon-back">
                <path :fill="`url(#${id}-back)`" :d="preset.back" />
                <path
                    :stroke="`url(#${id}-edge)`"
                    :d="preset.backEdge"
                    fill="none"
                    stroke-width="2"
                />
            </g>
            <g class="ribbon ribbon-front">
                <path :fill="`url(#${id}-front)`" :d="preset.front" />
                <path
                    :stroke="`url(#${id}-edge)`"
                    :d="preset.frontEdge"
                    fill="none"
                    stroke-width="2"
                />
                <path :fill="`url(#${id}-edge)`" :d="preset.sheen" opacity="0.5" />
            </g>
        </svg>
    </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import { authBackdropPresets } from '@/utils/auth/backdrop';
import type { Accent } from '@/utils/theme/tokens';

const props = defineProps<{ accent: Accent; paused: boolean }>();
const preset = computed(() => authBackdropPresets[props.accent]);
const id = useId();
</script>

<style scoped>
.auth-backdrop {
    --ribbon-light: color-mix(in srgb, var(--scova-primary) 30%, var(--scova-surface));
    --ribbon-deep: color-mix(in srgb, var(--scova-primary) 65%, #29234c);
    --ribbon-accent: color-mix(in srgb, var(--scova-primary) 60%, #c7baff);
    position: absolute;
    z-index: -1;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
}
svg {
    display: block;
    inline-size: 100%;
    block-size: 100%;
    opacity: 0.8;
}
.ribbon {
    transform-box: fill-box;
    transform-origin: center;
    animation: ribbon-drift var(--ribbon-front-duration, 18s) ease-in-out infinite alternate;
}
.ribbon-back {
    opacity: 0.65;
    animation-duration: var(--ribbon-back-duration, 23s);
    animation-delay: -8s;
    animation-direction: alternate-reverse;
}
.is-paused .ribbon {
    animation-play-state: paused;
}
.auth-backdrop--pine {
    --ribbon-front-duration: 26s;
    --ribbon-back-duration: 31s;
    --ribbon-deep: color-mix(in srgb, var(--scova-primary) 72%, #143f3a);
    --ribbon-accent: color-mix(in srgb, var(--scova-primary) 60%, #b2d8c1);
}
.auth-backdrop--iris {
    --ribbon-front-duration: 20s;
    --ribbon-back-duration: 27s;
    --ribbon-accent: color-mix(in srgb, var(--scova-primary) 55%, #e0bdf2);
}
.auth-backdrop--amber {
    --ribbon-front-duration: 24s;
    --ribbon-back-duration: 30s;
    --ribbon-deep: color-mix(in srgb, var(--scova-primary) 70%, #633d26);
    --ribbon-accent: color-mix(in srgb, var(--scova-primary) 48%, #efcc9b);
}
.auth-backdrop--pine .ribbon {
    animation-name: wave-drift;
}
.auth-backdrop--iris .ribbon {
    animation-name: silk-drift;
}
.auth-backdrop--amber .ribbon {
    animation-name: fold-drift;
}
@keyframes ribbon-drift {
    from {
        transform: translate(0, 0) rotate(-3deg);
    }
    to {
        transform: translate(2rem, -2.5rem) rotate(4deg);
    }
}
@keyframes wave-drift {
    from {
        transform: translate(-0.75rem, -1rem) rotate(-1deg);
    }
    to {
        transform: translate(1rem, 2rem) rotate(2deg);
    }
}
@keyframes silk-drift {
    from {
        transform: translate(-0.5rem, 1rem) rotate(-4deg);
    }
    to {
        transform: translate(1.5rem, -1.5rem) rotate(3deg);
    }
}
@keyframes fold-drift {
    from {
        transform: translate(-1rem, 0.5rem) rotate(-2deg);
    }
    to {
        transform: translate(1.5rem, -1rem) rotate(1deg);
    }
}
@media (max-width: 48rem) {
    svg {
        opacity: 0.34;
    }
}
@media (prefers-reduced-motion: reduce) {
    .ribbon {
        animation: none;
    }
}
</style>
