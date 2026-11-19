<template>
    <section
        v-if="state.mode.value !== 'closed'"
        class="note-editor scova-interface layout-stack break-anywhere pt-6 pb-6 [border-block:0.0625rem_solid_var(--scova-border)]"
        :aria-labelledby="`${id}-title`"
    >
        <h3 class="text-[1.125rem] m-0" :id="`${id}-title`">
            {{ state.mode.value === 'create' ? '新建纯文本笔记' : '编辑纯文本笔记' }}
        </h3>
        <p class="m-0">
            {{ state.target.value?.kind === 'report' ? '报告' : '来源' }}目标：{{
                state.target.value?.id
            }}
        </p>
        <label :for="`${id}-body`">本地笔记正文</label>
        <textarea
            class="box-border w-full max-w-full min-w-0 min-h-[12rem] [resize:none] border-theme rounded-2 bg-surface text-default [font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] leading-[1.75] [font-variant:inherit] [cursor:text] p-3.5 keyboard-focus-wide"
            :id="`${id}-body`"
            v-model="state.draft.value"
            :readonly="
                state.pending.value ||
                state.reading.value ||
                !!state.attempt.value ||
                state.lock.value === 'deleted'
            "
            :aria-describedby="`${id}-help`"
            spellcheck="false"
        />
        <p class="m-0" :id="`${id}-help`">
            仅保存纯文本；最多 20000 个 UTF-16 码元，不解析 HTML 或 Markdown。
        </p>
        <p class="m-0" v-if="validation" role="status">{{ validation }}</p>
        <p class="m-0" v-if="state.reading.value" role="status">正在读取笔记当前版本。</p>
        <p class="m-0" v-if="state.pending.value" role="status">正在提交笔记操作。</p>
        <p class="m-0" v-if="state.waiting.value && state.retryAt.value" role="status">
            可重试时间：<time :datetime="new Date(state.retryAt.value).toISOString()">{{
                new Date(state.retryAt.value).toLocaleString()
            }}</time>
        </p>
        <div v-if="state.attempt.value" class="editor-actions action-group">
            <action-button
                :disabled="
                    !available ||
                    state.pending.value ||
                    state.waiting.value ||
                    state.attemptTerminal.value
                "
                @click="state.create(true)"
                >同键核对并重放创建</action-button
            >
            <action-button :disabled="state.pending.value" @click="state.endAttempt(confirmAction)"
                >结束本次创建尝试</action-button
            >
        </div>
        <div v-else class="editor-actions action-group">
            <action-button
                :disabled="!state.canSave.value"
                :busy="state.pending.value"
                @click="save"
                >{{ state.mode.value === 'create' ? '创建笔记' : '保存笔记' }}</action-button
            >
            <action-button
                v-if="state.mode.value === 'edit' && state.lock.value !== 'deleted'"
                :disabled="!available || state.pending.value || state.reading.value"
                @click="state.read()"
                >重新读取服务端副本</action-button
            >
            <action-button
                v-if="state.mode.value === 'edit' && state.lock.value !== 'deleted'"
                :disabled="
                    !available ||
                    state.pending.value ||
                    state.reading.value ||
                    !!state.lock.value ||
                    state.waiting.value
                "
                @click="remove"
                >删除笔记</action-button
            >
        </div>
        <section
            v-if="available && state.reviewReady.value && state.server.value"
            class="server-copy layout-stack break-anywhere pt-4 pb-4 [border-top:0.0625rem_solid_var(--scova-border)]"
            :aria-labelledby="`${id}-server-title`"
        >
            <h4 class="text-[1rem] m-0" :id="`${id}-server-title`">服务端当前副本</h4>
            <p class="m-0">修订 {{ state.server.value.revision }} · 本地稿尚未被替换</p>
            <p class="note-body scova-note whitespace-pre-wrap break-anywhere m-0">
                {{ state.server.value.body }}
            </p>
            <div class="editor-actions action-group">
                <action-button @click="adoptServer">采用服务端正文</action-button>
                <action-button @click="state.adopt(true)">保留本地稿，按此版本整理</action-button>
            </div>
        </section>
        <action-button
            :disabled="state.pending.value || state.reading.value"
            @click="emit('close')"
            >{{ state.lock.value === 'deleted' ? '关闭笔记' : '取消编辑' }}</action-button
        >
    </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import ActionButton from '@/component/common/ActionButton.vue';
import type { useNoteEditor } from '@/composable/useNotes';
import { noteTextError } from '@/utils/notes';
import { useActionNotification } from '@/composable/useActionNotification';
const props = withDefaults(
    defineProps<{ state: ReturnType<typeof useNoteEditor>; available?: boolean }>(),
    { available: true },
);
const emit = defineEmits<{ close: [] }>();
useActionNotification().watch(
    () => props.state.notice.value,
    () => (props.state.lock.value ? 'warning' : 'info'),
);
const id = useId();
const validation = computed(() =>
    props.state.draft.value ? noteTextError(props.state.draft.value) : '',
);
const confirmAction = (message: string) => window.confirm(message);
function save() {
    if (props.state.mode.value === 'create') void props.state.create();
    else void props.state.write();
}
function remove() {
    if (window.confirm('确认删除这条笔记？来源、收藏和报告不会删除。'))
        void props.state.write(true);
}
function adoptServer() {
    if (!props.state.dirty.value || window.confirm('采用服务端正文将替换当前本地稿，是否继续？'))
        props.state.adopt(false);
}
</script>
