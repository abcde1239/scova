<template>
    <section id="auth-demo" class="product-demo" aria-labelledby="auth-demo-title">
        <div class="demo-content">
            <header class="demo-heading">
                <p class="demo-kicker">{{ t('auth.demo.sample') }}</p>
                <h2 id="auth-demo-title" tabindex="-1">{{ t('auth.demo.title') }}</h2>
            </header>
            <article class="demo-section" aria-labelledby="auth-conversation-title">
                <div class="demo-copy">
                    <h3 id="auth-conversation-title">
                        <span class="demo-step" aria-hidden="true">1</span
                        >{{ t('auth.demo.conversation') }}
                    </h3>
                    <p>{{ t('auth.demo.conversationDescription') }}</p>
                </div>
                <div class="demo-window demo-conversation">
                    <header class="demo-bar">
                        <app-icon name="projects" />
                        <span class="demo-bar-title">{{ t('auth.demo.project') }}</span>
                    </header>
                    <div class="demo-messages">
                        <p class="demo-prompt">{{ t('auth.demo.prompt') }}</p>
                        <div class="demo-reply">
                            <span class="demo-avatar" aria-hidden="true">S</span>
                            <div class="demo-reply-body">
                                <p>{{ t('auth.demo.reply') }}</p>
                                <section class="demo-draft" aria-labelledby="auth-draft-title">
                                    <div class="demo-draft-header">
                                        <h4 id="auth-draft-title">{{ t('auth.demo.draft') }}</h4>
                                        <span class="demo-badge">{{ t('auth.demo.pending') }}</span>
                                    </div>
                                    <ul class="demo-chips" role="list">
                                        <li v-for="key in scopeKeys" :key="key">{{ t(key) }}</li>
                                    </ul>
                                    <div class="demo-actions" aria-hidden="true">
                                        <span>{{ t('auth.demo.saveTask') }}</span>
                                        <span class="demo-actions-primary">
                                            <app-icon name="run" />{{ t('auth.demo.runNow') }}
                                        </span>
                                    </div>
                                </section>
                            </div>
                        </div>
                    </div>
                    <div class="demo-composer" aria-hidden="true">
                        {{ t('auth.demo.composer') }}
                    </div>
                </div>
            </article>
            <article class="demo-section" aria-labelledby="auth-workflow-title">
                <div class="demo-copy">
                    <h3 id="auth-workflow-title">
                        <span class="demo-step" aria-hidden="true">2</span
                        >{{ t('auth.demo.workflow') }}
                    </h3>
                    <p>{{ t('auth.demo.workflowDescription') }}</p>
                </div>
                <div class="demo-window demo-workflow">
                    <header class="demo-bar">
                        <app-icon name="workflows" />
                        <span class="demo-bar-title">{{ t('auth.demo.workflowName') }}</span>
                        <span class="demo-badge demo-badge--muted">{{
                            t('auth.demo.draftStatus')
                        }}</span>
                        <span class="demo-publish" aria-hidden="true">{{
                            t('auth.demo.publish')
                        }}</span>
                    </header>
                    <div class="demo-editor">
                        <ol class="demo-steps" role="list" :aria-label="t('auth.demo.stepOrder')">
                            <li class="demo-boundary">{{ t('auth.demo.start') }}</li>
                            <li v-for="node in nodes" :key="node.label" class="demo-node">
                                <button
                                    type="button"
                                    class="demo-node-button keyboard-focus-inset"
                                    aria-controls="auth-demo-inspector"
                                    :aria-pressed="selectedNode === node"
                                    @click="selectedNode = node"
                                >
                                    <span class="demo-node-text">
                                        <small>{{ t(node.label) }}</small
                                        >{{ t(node.task) }}
                                    </span>
                                    <app-icon class="demo-node-arrow" name="chevron" />
                                </button>
                            </li>
                            <li class="demo-boundary">{{ t('auth.demo.finish') }}</li>
                        </ol>
                        <section
                            id="auth-demo-inspector"
                            class="demo-inspector"
                            aria-labelledby="auth-demo-inspector-title"
                        >
                            <div class="demo-inspector-header">
                                <h4 id="auth-demo-inspector-title">
                                    {{ t('auth.demo.inspector') }}
                                </h4>
                                <span class="demo-badge">{{ t(selectedNode.label) }}</span>
                            </div>
                            <div class="demo-inspector-details">
                                <dl
                                    v-for="node in nodes"
                                    :key="node.label"
                                    :aria-hidden="selectedNode !== node"
                                >
                                    <dt>{{ t('auth.demo.task') }}</dt>
                                    <dd>{{ t(node.task) }}</dd>
                                    <dt>{{ t('auth.demo.output') }}</dt>
                                    <dd>{{ t('auth.demo.brief') }}</dd>
                                </dl>
                            </div>
                        </section>
                    </div>
                </div>
            </article>
            <a class="demo-back keyboard-focus" href="#auth-start" @click.prevent="$emit('back')">
                <span class="demo-back-icon"><app-icon name="expand" /></span>
                {{ t('auth.demo.backToIntro') }}
            </a>
        </div>
    </section>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import AppIcon from '@/component/common/AppIcon.vue';

const { t } = useI18n({ useScope: 'global' });
defineEmits<{ back: [] }>();

const scopeKeys = ['auth.demo.scopeRange', 'auth.demo.scopeSources', 'auth.demo.scopeOutput'];
const nodes = [
    { label: 'auth.demo.studyOne', task: 'auth.demo.compareVersions' },
    { label: 'auth.demo.studyTwo', task: 'auth.demo.verifyChanges' },
] as const;
const selectedNode = shallowRef<(typeof nodes)[number]>(nodes[0]);
</script>

<style scoped>
.product-demo {
    @apply px-[clamp(2rem,_4vw,_4rem)] py-10;
}
.demo-content {
    @apply grid min-w-0 max-w-[36rem] gap-12;
}
.demo-heading {
    @apply grid gap-2;
}
.demo-heading h2 {
    @apply m-0 text-[clamp(1.5rem,_2.2vw,_2rem)] leading-tight [letter-spacing:-0.02em]
        [font-weight:650] [scroll-margin-block-start:1rem];
}
.demo-kicker {
    @apply m-0 text-primary text-sm font-semibold;
}
.demo-section {
    @apply grid min-w-0 gap-5;
}
/* Wide showcase: copy beside each preview window. */
@container auth-showcase (min-width: 50rem) {
    .demo-content {
        @apply max-w-[46rem];
    }
}
@container auth-showcase (min-width: 76rem) {
    .demo-content {
        @apply max-w-[80rem];
    }
    .demo-section {
        @apply [grid-template-columns:minmax(14rem,_0.7fr)_minmax(0,_1.3fr)] items-center gap-12;
    }
}
.demo-copy {
    @apply grid gap-2 min-w-0;
}
.demo-copy h3 {
    @apply flex items-center gap-2.5 m-0 text-[1.125rem] leading-snug font-semibold
        break-anywhere;
}
.demo-step {
    @apply grid place-items-center shrink-0 w-6 h-6 rounded-full text-[0.75rem] font-bold
        [background:var(--scova-primary)] [color:var(--scova-on-primary)];
}
.demo-copy p {
    @apply m-0 text-muted text-sm leading-relaxed break-anywhere;
}
.demo-window {
    @apply min-w-0 overflow-hidden border-subtle rounded-4 bg-surface text-sm
        [box-shadow:0_1.125rem_3rem_-1.5rem_color-mix(in_srgb,_var(--auth-shadow-ink)_24%,_transparent)];
}
.demo-window h4 {
    @apply m-0 text-sm font-semibold break-anywhere;
}
.demo-bar {
    @apply flex items-center gap-2 min-w-0 px-4 py-3 [border-bottom:0.0625rem_solid_var(--auth-line)];
}
.demo-bar svg {
    @apply shrink-0 text-primary;
}
.demo-bar-title {
    @apply flex-1 min-w-0 font-semibold truncate;
}
.demo-badge {
    @apply shrink-0 rounded-full px-2 py-0.5 text-xs text-primary [background:var(--scova-selected)];
}
.demo-badge--muted {
    @apply text-muted;
}
.demo-publish {
    @apply shrink-0 rounded-2 px-3 py-1 text-xs font-medium [background:var(--scova-primary)]
        [color:var(--scova-on-primary)];
}

/* Conversation */
.demo-messages {
    @apply grid gap-4 p-4;
}
.demo-messages p {
    @apply m-0 leading-relaxed break-anywhere;
}
.demo-prompt {
    @apply justify-self-end max-w-[85%] rounded-3 rounded-br-1 py-2 px-3 text-default
        [background:color-mix(in_srgb,_var(--scova-primary)_12%,_var(--scova-surface))];
}
.demo-reply {
    @apply grid [grid-template-columns:auto_minmax(0,_1fr)] gap-2.5 items-start;
}
.demo-avatar {
    @apply grid place-items-center w-6 h-6 rounded-2 text-xs font-bold
        [background:var(--scova-primary)] [color:var(--scova-on-primary)];
}
.demo-reply-body {
    @apply grid gap-3 min-w-0 text-muted;
}
.demo-draft {
    @apply grid gap-3 p-3 border-subtle rounded-3 text-default [background:var(--scova-canvas)];
}
.demo-draft-header {
    @apply flex flex-wrap items-center justify-between gap-2;
}
.demo-chips {
    @apply flex flex-wrap gap-1.5 m-0 p-0 list-none;
}
.demo-chips li {
    @apply rounded-1.5 px-2 py-0.5 text-xs text-muted border-subtle bg-surface;
}
.demo-actions {
    @apply flex flex-wrap justify-end gap-2 text-xs font-medium;
}
.demo-actions > span {
    @apply inline-flex items-center gap-1 rounded-2 px-3 py-1.5 border-subtle bg-surface;
}
.demo-actions .demo-actions-primary {
    @apply [border-color:var(--scova-primary)] [background:var(--scova-primary)]
        [color:var(--scova-on-primary)];
}
.demo-composer {
    @apply mx-4 mb-4 rounded-3 px-3 py-2.5 text-muted border-subtle [background:var(--scova-canvas)];
}

/* Workflow editor */
.demo-workflow {
    container-type: inline-size;
}
.demo-editor {
    @apply grid gap-4 p-4;
}
@container (min-width: 26rem) {
    .demo-editor {
        @apply [grid-template-columns:minmax(0,_1.15fr)_minmax(0,_1fr)];
    }
}
.demo-steps {
    @apply relative [isolation:isolate] grid gap-2.5 justify-items-center content-start min-w-0
        m-0 p-0 list-none;
}
.demo-steps::before {
    @apply content-[''] absolute top-3 bottom-3 left-1/2 z-[-1] w-px [background:var(--scova-border)];
}
.demo-boundary {
    @apply rounded-full border-subtle bg-surface px-3 py-0.5 text-xs text-muted;
}
.demo-node {
    @apply w-full min-w-0;
}
.demo-node-button {
    @apply flex items-center gap-2 w-full min-h-11 px-3 py-2 rounded-2.5 border-subtle bg-surface
        text-default text-left font-inherit cursor-pointer;
}
.demo-node-text {
    @apply flex-1 min-w-0 break-anywhere;
}
.demo-node small {
    @apply block text-xs text-muted;
}
.demo-node-arrow {
    @apply shrink-0 text-muted;
}
.demo-node-button[aria-pressed='true'] {
    @apply [border-color:var(--scova-primary)]
        [box-shadow:0_0_0_0.1875rem_color-mix(in_srgb,_var(--scova-primary)_18%,_transparent)];
}
.demo-node-button:is(:hover, :focus-visible, [aria-pressed='true']) .demo-node-arrow {
    @apply text-primary;
}
.demo-inspector {
    @apply grid content-start gap-3 min-w-0 p-3 rounded-3 [background:var(--scova-canvas)];
}
.demo-inspector-header {
    @apply flex flex-wrap items-center justify-between gap-2;
}
.demo-inspector-details {
    display: grid;
}
.demo-inspector dl {
    @apply grid content-start gap-1.5 m-0;
    grid-area: 1 / 1;
}
.demo-inspector dl[aria-hidden='true'] {
    visibility: hidden;
}
.demo-inspector dt {
    @apply text-xs text-muted;
}
.demo-inspector dd {
    @apply m-0 mb-1 rounded-2 px-2.5 py-1.5 border-subtle bg-surface break-anywhere;
}

.demo-back {
    @apply inline-flex items-center gap-3 min-h-11 justify-self-start rounded-2
        text-muted text-[0.8125rem] font-medium no-underline hover:text-default;
}
.demo-back-icon {
    @apply inline-grid place-items-center w-8 h-8 shrink-0 rounded-full border-subtle rotate-180;
}
.demo-back:is(:hover, :focus-visible) .demo-back-icon {
    @apply [border-color:var(--scova-primary)] text-primary;
}
@media (prefers-reduced-motion: no-preference) {
    .demo-inspector dl[aria-hidden='false'] {
        animation: demo-inspect 220ms ease-out both;
    }
    .demo-node-arrow {
        transition: translate 180ms ease-out;
    }
    .demo-node-button[aria-pressed='true'] .demo-node-arrow {
        translate: 0.1875rem;
    }
    .demo-back-icon :deep(.app-icon) {
        transition: translate 160ms ease-out;
    }
    .demo-back:focus-visible .demo-back-icon :deep(.app-icon) {
        translate: 0 0.1875rem;
    }
    @media (hover: hover) {
        .demo-back:hover .demo-back-icon :deep(.app-icon) {
            translate: 0 0.1875rem;
        }
    }
    @media (hover: hover) and (pointer: fine) {
        .demo-window {
            transition: translate 240ms ease-out;
        }
        .demo-section:hover .demo-window {
            translate: 0 -0.25rem;
        }
        .demo-conversation :is(.demo-prompt, .demo-reply, .demo-draft) {
            transition: transform 240ms ease-out;
        }
        .demo-conversation:hover .demo-prompt {
            transform: translateX(-0.25rem);
        }
        .demo-conversation:hover .demo-reply {
            transform: translateX(0.125rem);
            transition-delay: 45ms;
        }
        .demo-conversation:hover .demo-draft {
            transform: translateY(-0.25rem);
            transition-delay: 90ms;
        }
    }
    @supports ((animation-timeline: view()) and (animation-range: entry)) {
        .demo-window {
            animation:
                demo-enter linear both,
                demo-exit linear both;
            animation-timeline: view(), view();
            animation-range:
                entry 0% entry 80%,
                exit 0% exit 100%;
        }
        /* Each piece reveals as it enters, so the window fills in step by step. */
        .demo-heading,
        .demo-copy,
        .demo-prompt,
        .demo-reply,
        .demo-chips li,
        .demo-actions,
        .demo-composer,
        .demo-node,
        .demo-boundary,
        .demo-inspector dd {
            animation: demo-reveal linear both;
            animation-timeline: view();
            animation-range: entry 0% entry 100%;
        }
        .demo-node:focus-within {
            animation: none;
        }
        .demo-copy {
            --demo-from: -2rem 0;
        }
        .demo-prompt {
            --demo-from: 2rem 0;
        }
        .demo-reply,
        .demo-node {
            --demo-from: -1.5rem 0;
        }
        .demo-inspector dd {
            --demo-from: 1rem 0;
        }
        .demo-chips li:nth-child(2) {
            animation-range: entry 30% cover 15%;
        }
        .demo-chips li:nth-child(3) {
            animation-range: entry 60% cover 25%;
        }
        .demo-steps {
            view-timeline: --demo-steps block;
        }
        .demo-steps::before {
            @apply origin-top;
            animation: demo-draw linear both;
            animation-timeline: --demo-steps;
            animation-range: entry 0% entry 100%;
        }
    }
}
@keyframes demo-inspect {
    from {
        opacity: 0.55;
        transform: translateX(0.375rem);
    }
}
@keyframes demo-enter {
    from {
        opacity: 0.6;
        transform: translateY(2rem) scale(0.98);
    }
    to {
        opacity: 1;
        transform: none;
    }
}
@keyframes demo-exit {
    to {
        opacity: 0.5;
        transform: translateY(-1rem) scale(0.97);
    }
}
@keyframes demo-reveal {
    from {
        opacity: 0;
        translate: var(--demo-from, 0 1rem);
    }
}
@keyframes demo-draw {
    from {
        transform: scaleY(0);
    }
}
</style>
