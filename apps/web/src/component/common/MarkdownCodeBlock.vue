<template>
    <div class="markdown-code">
        <div class="markdown-code__toolbar">
            <span>{{ node.language || '纯文本' }}</span>
            <button type="button" class="keyboard-focus-wide" @click="copyCode">复制代码</button>
        </div>
        <pre
            tabindex="0"
            aria-label="代码"
        ><code><highlighted-code v-if="highlighted.length" :children="highlighted" /><template v-else>{{ source }}</template></code></pre>
        <span v-if="copyFeedback" role="status" class="markdown-code__feedback">{{
            copyFeedback
        }}</span>
    </div>
</template>

<script setup lang="ts">
import { computed, h, ref, shallowRef, watch, type VNodeChild } from 'vue';
import type { PreCodeNodeProps } from 'markstream-vue';

type SyntaxNode = ReturnType<
    ReturnType<typeof import('lowlight').createLowlight>['highlight']
>['children'][number];

const props = defineProps<{ node: PreCodeNodeProps['node'] }>();
const source = computed(() => props.node.code);
const highlighted = shallowRef<SyntaxNode[]>([]);
const copyFeedback = ref('');

function renderSyntax(node: SyntaxNode): VNodeChild {
    if (node.type === 'text') return node.value;
    if (node.type === 'element')
        return h('span', { class: node.properties.className }, node.children.map(renderSyntax));
    return '';
}

const HighlightedCode = (props: { children: SyntaxNode[] }) => props.children.map(renderSyntax);

watch(
    [source, () => props.node.language, () => props.node.loading],
    async ([code, language, loading], _, onCleanup) => {
        highlighted.value = [];
        copyFeedback.value = '';
        if (!language || loading || !code || code.length > 6000) return;
        let current = true;
        onCleanup(() => {
            current = false;
        });
        try {
            const { common, createLowlight } = await import('lowlight');
            if (!current) return;
            const highlighter = createLowlight(common);
            const name = language.trim().split(/\s+/, 1)[0]!;
            if (highlighter.registered(name))
                highlighted.value = highlighter.highlight(name, code).children;
        } catch {
            // The original source remains visible if highlighting is unavailable.
        }
    },
    { immediate: true },
);

async function copyCode() {
    try {
        await navigator.clipboard.writeText(source.value);
        copyFeedback.value = '已复制';
    } catch {
        copyFeedback.value = '无法复制，请选中文本后手动复制';
    }
}
</script>

<style scoped>
.markdown-code {
    max-inline-size: 100%;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
}

.markdown-code__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.75rem;
    border-block-end: 1px solid var(--scova-border);
}

.markdown-code pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    white-space: pre;
}

.markdown-code__feedback {
    padding-inline: 0.75rem;
}
.markdown-code :deep(.hljs-keyword),
.markdown-code :deep(.hljs-literal),
.markdown-code :deep(.hljs-number),
.markdown-code :deep(.hljs-string) {
    color: var(--scova-primary);
}
.markdown-code :deep(.hljs-comment) {
    opacity: 0.7;
}
</style>
