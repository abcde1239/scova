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
                            <li
                                v-for="node in nodes"
                                :key="node.label"
                                class="demo-node"
                                :class="{ 'demo-node--selected': node.selected }"
                            >
                                <span class="demo-node-text"
                                    ><small>{{ t(node.label) }}</small
                                    >{{ t(node.task) }}</span
                                >
                                <app-icon class="demo-handle" name="menu" />
                            </li>
                            <li class="demo-boundary">{{ t('auth.demo.finish') }}</li>
                        </ol>
                        <div class="demo-inspector">
                            <div class="demo-inspector-header">
                                <h4>{{ t('auth.demo.inspector') }}</h4>
                                <span class="demo-badge">{{ t('auth.demo.studyOne') }}</span>
                            </div>
                            <dl>
                                <dt>{{ t('auth.demo.task') }}</dt>
                                <dd>{{ t('auth.demo.compareVersions') }}</dd>
                                <dt>{{ t('auth.demo.output') }}</dt>
                                <dd>{{ t('auth.demo.brief') }}</dd>
                            </dl>
                        </div>
                    </div>
                </div>
            </article>
            <a class="demo-back keyboard-focus" href="#auth-start" @click.prevent="$emit('back')">
                <app-icon name="back" />{{ t('auth.demo.backToIntro') }}
            </a>
        </div>
    </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import AppIcon from '@/component/common/AppIcon.vue';

const { t } = useI18n({ useScope: 'global' });
defineEmits<{ back: [] }>();

const scopeKeys = ['auth.demo.scopeRange', 'auth.demo.scopeSources', 'auth.demo.scopeOutput'];
const nodes = [
    { label: 'auth.demo.studyOne', task: 'auth.demo.compareVersions', selected: true },
    { label: 'auth.demo.studyTwo', task: 'auth.demo.verifyChanges', selected: false },
] as const;
</script>

<style scoped>
.product-demo {
    @apply [border-top:0.0625rem_solid_var(--auth-line)]
        [background:color-mix(in_srgb,_var(--scova-primary)_4%,_var(--scova-canvas))]
        px-[clamp(2rem,_4vw,_4rem)] py-10;
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
    @apply flex items-center gap-2 w-full min-w-0 px-3 py-2 rounded-2.5 border-subtle bg-surface;
}
.demo-node-text {
    @apply flex-1 min-w-0 break-anywhere;
}
.demo-node small {
    @apply block text-xs text-muted;
}
.demo-handle {
    @apply shrink-0 text-muted opacity-60;
}
.demo-node--selected {
    @apply [border-color:var(--scova-primary)]
        [box-shadow:0_0_0_0.1875rem_color-mix(in_srgb,_var(--scova-primary)_18%,_transparent)];
}
.demo-inspector {
    @apply grid content-start gap-3 min-w-0 p-3 rounded-3 [background:var(--scova-canvas)];
}
.demo-inspector-header {
    @apply flex flex-wrap items-center justify-between gap-2;
}
.demo-inspector dl {
    @apply grid gap-1.5 m-0;
}
.demo-inspector dt {
    @apply text-xs text-muted;
}
.demo-inspector dd {
    @apply m-0 mb-1 rounded-2 px-2.5 py-1.5 border-subtle bg-surface break-anywhere;
}

.demo-back {
    @apply inline-flex items-center gap-2 min-h-11 justify-self-start rounded-2
        text-primary text-sm font-medium underline underline-offset-4;
}
@media (prefers-reduced-motion: no-preference) {
    @supports (animation-timeline: view()) {
        .demo-window {
            animation: demo-enter linear both;
            animation-timeline: view();
            animation-range: entry 0% entry 80%;
        }
    }
}
@keyframes demo-enter {
    from {
        opacity: 0.8;
        transform: translateY(0.75rem);
    }
    to {
        opacity: 1;
        transform: none;
    }
}
</style>
