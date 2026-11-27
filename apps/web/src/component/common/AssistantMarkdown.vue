<template>
    <div class="assistant-markdown">
        <markdown-render
            v-if="!plain"
            :content="text"
            :final="final"
            :render-code-blocks-as-pre="true"
            :show-tooltips="false"
            :fade="false"
            custom-id="scova-assistant-markdown"
            html-policy="escape"
            mode="chat"
        />
        <p v-else class="m-0 whitespace-pre-wrap">{{ text }}</p>
    </div>
</template>

<script lang="ts">
import { defineComponent, h, type Component, type PropType } from 'vue';
import {
    LinkNode,
    MarkdownRender,
    setCustomComponents,
    TableNode,
    type LinkNodeProps,
} from 'markstream-vue';
import MarkdownCodeBlock from '@/component/common/MarkdownCodeBlock.vue';

const imagePlaceholder = defineComponent({
    inheritAttrs: false,
    props: { node: { type: Object, required: true } },
    setup(props) {
        return () => h('span', {}, props.node.alt || '图片');
    },
});

const scrollableTable = defineComponent({
    inheritAttrs: false,
    setup(_, { attrs }) {
        return () =>
            h(
                'div',
                {
                    class: 'assistant-markdown__table',
                    tabindex: 0,
                    role: 'region',
                    'aria-label': '回答表格',
                },
                [h(TableNode as Component, attrs)],
            );
    },
});

const restrictedLink = defineComponent({
    inheritAttrs: false,
    props: { node: { type: Object as PropType<LinkNodeProps['node']>, required: true } },
    setup(props, { attrs }) {
        return () => {
            const { href, text } = props.node;
            if (!/^https?:\/\//i.test(href) || !URL.canParse(href)) return h('span', text);
            return h(LinkNode as Component, { ...attrs, node: props.node });
        };
    },
});

setCustomComponents('scova-assistant-markdown', {
    link: restrictedLink,
    image: imagePlaceholder,
    code_block: MarkdownCodeBlock,
    mermaid: MarkdownCodeBlock,
    d2: MarkdownCodeBlock,
    infographic: MarkdownCodeBlock,
    table: scrollableTable,
});
</script>

<script setup lang="ts">
import { computed, onErrorCaptured, ref, watch } from 'vue';
import 'markstream-vue/index.css';

const props = withDefaults(defineProps<{ text: string; final?: boolean }>(), { final: true });
const failed = ref(false);
const plain = computed(() => failed.value || props.text.length > 12_000);
watch(
    () => props.text,
    () => {
        failed.value = false;
    },
);
onErrorCaptured(() => {
    failed.value = true;
    return false;
});
</script>

<style scoped>
.assistant-markdown {
    min-inline-size: 0;
    overflow-wrap: anywhere;
}

.assistant-markdown :deep(.assistant-markdown__table) {
    max-inline-size: 100%;
    overflow: auto;
}

.assistant-markdown :deep(.assistant-markdown__table .table-node-wrapper) {
    overflow: visible;
}

.assistant-markdown :deep(.assistant-markdown__table table) {
    min-inline-size: max-content;
}
</style>
