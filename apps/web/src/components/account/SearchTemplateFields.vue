<template>
    <fieldset class="template-fields">
        <legend class="font-medium">自定义搜索请求与结果</legend>
        <p class="m-0 text-muted leading-[1.65]">
            搜索由此服务提供，正文明确使用本地网页读取工具。保存只校验配置，不调用搜索接口。
        </p>
        <action-button quaternary :disabled="disabled" @click="$emit('preset')">
            填入 Brave Search 预设
        </action-button>
        <div class="template-grid">
            <task-config-field
                v-model="method"
                label="请求方法"
                kind="select"
                :options="methodOptions"
                :disabled="disabled"
                :error="errors.method"
            />
            <task-config-field
                v-model="authType"
                label="密钥发送方式"
                kind="select"
                :options="authOptions"
                :disabled="disabled"
                :error="errors.auth"
            />
            <task-config-field
                v-if="draft.authType === 'header'"
                v-model="draft.headerName"
                label="密钥请求头名称"
                :disabled="disabled"
                :error="errors.headerName"
            />
        </div>
        <div class="layout-grid gap-2">
            <label :for="`${id}-request`" class="font-medium">请求参数 JSON（必填）</label>
            <n-input
                v-model:value="draft.requestJson"
                type="textarea"
                :autosize="{ minRows: 5 }"
                :disabled="disabled"
                :input-props="{
                    id: `${id}-request`,
                    name: 'searchRequest',
                    spellcheck: false,
                    autocapitalize: 'none',
                    'aria-invalid': errors.request ? 'true' : 'false',
                    'aria-describedby': `${id}-variables${errors.request ? ` ${id}-request-error` : ''}`,
                }"
                @update:value="$emit('clear', 'request')"
            />
            <p :id="`${id}-variables`" class="m-0 text-muted break-anywhere leading-[1.65]">
                {{ variablesHint }} GET 作为查询参数，POST 作为 JSON 请求体。密钥只填入独立密钥框。
            </p>
            <p v-if="errors.request" :id="`${id}-request-error`" class="m-0 text-danger">
                {{ errors.request }}
            </p>
        </div>
        <div class="template-grid">
            <task-config-field
                v-model="draft.resultsPath"
                label="结果数组路径"
                :disabled="disabled"
                :error="errors.resultsPath"
            />
            <task-config-field
                v-model="draft.urlPath"
                label="结果链接路径"
                :disabled="disabled"
                :error="errors.urlPath"
            />
            <task-config-field
                v-model="draft.titlePath"
                label="结果标题路径"
                :disabled="disabled"
                :error="errors.titlePath"
            />
            <task-config-field
                v-model="draft.snippetPath"
                label="结果摘要路径"
                :disabled="disabled"
                :error="errors.snippetPath"
            />
        </div>
        <task-config-field
            v-model="draft.languageMapJson"
            label="语言映射 JSON"
            kind="textarea"
            :disabled="disabled"
            :error="errors.languageMap"
        />
        <p class="m-0 text-muted leading-[1.65]">
            将标准语言映射为服务使用的值，例如 Brave 的 {"zh":"zh-hans"}；无须映射时填写 {}。
        </p>
        <p class="m-0 text-muted leading-[1.65]">
            数组路径相对整个响应，其他路径相对单条结果；例如 web.results 和
            url。仅支持字段路径和数组下标，不执行脚本。
        </p>
        <p v-if="errors.custom" class="m-0 text-danger" role="alert" tabindex="-1">
            {{ errors.custom }}
        </p>
    </fieldset>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { SearchTemplateDraft } from '@/models/search-template';
import ActionButton from '@/components/common/ActionButton.vue';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';

defineProps<{ disabled?: boolean; errors: Record<string, string> }>();
defineEmits<{ preset: []; clear: [field: string] }>();
const draft = defineModel<SearchTemplateDraft>({ required: true });
const method = computed({
    get: () => draft.value.method,
    set: (value: string) => {
        if (value === 'GET' || value === 'POST') draft.value.method = value;
    },
});
const authType = computed({
    get: () => draft.value.authType,
    set: (value: string) => {
        if (value === 'bearer' || value === 'header') draft.value.authType = value;
    },
});
const id = useId();
const variablesHint = '仅支持 {{query}}、{{count}}、{{language}}；未指定语言时省略对应参数。';
const methodOptions = [
    { value: 'GET', label: 'GET' },
    { value: 'POST', label: 'POST（JSON）' },
];
const authOptions = [
    { value: 'bearer', label: 'Authorization: Bearer' },
    { value: 'header', label: '独立请求头' },
];
</script>

<style scoped>
.template-fields {
    @apply col-span-full min-w-0 layout-grid gap-4 m-0 p-4 [border:0.0625rem_solid_var(--scova-border)] rounded-2;
}
.template-grid {
    @apply grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_17rem),_1fr))] gap-4 min-w-0;
}
.template-fields :deep(textarea) {
    @apply text-[1rem] leading-[1.5] [font-family:monospace];
}
</style>
