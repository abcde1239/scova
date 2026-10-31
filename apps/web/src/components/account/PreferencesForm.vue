<template>
    <form
        class="preferences-form"
        novalidate
        :aria-busy="pending || query.isFetching.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <p v-if="query.isPending.value" role="status">正在读取默认偏好…</p>
        <div v-if="query.isError.value" class="load-error">
            <p role="alert">默认偏好暂时无法读取，请检查连接后重试。</p>
            <action-button :busy="query.isFetching.value" @click="query.refetch()"
                >重新读取</action-button
            >
        </div>
        <div class="field">
            <label :for="`${id}-timezone`">默认时区</label>
            <n-input
                ref="timezoneInput"
                v-model:value="draft.defaultTimezone"
                placeholder=""
                :readonly="pending"
                :input-props="{
                    id: `${id}-timezone`,
                    list: `${id}-timezones`,
                    autocomplete: 'off',
                    'aria-invalid': fields.defaultTimezone ? 'true' : undefined,
                    'aria-describedby': fields.defaultTimezone
                        ? `${id}-timezone-error`
                        : `${id}-timezone-help`,
                }"
            />
            <datalist :id="`${id}-timezones`">
                <option v-for="zone in timezones" :key="zone" :value="zone" />
            </datalist>
            <p :id="`${id}-timezone-help`" class="help">使用 IANA 时区，例如 Asia/Shanghai。</p>
            <p v-if="fields.defaultTimezone" :id="`${id}-timezone-error`" class="field-error">
                {{ fields.defaultTimezone }}
            </p>
        </div>
        <fieldset class="notification-fields">
            <legend>默认提醒</legend>
            <div class="field">
                <label :for="`${id}-mode`">结果提醒</label>
                <select
                    ref="modeInput"
                    :id="`${id}-mode`"
                    v-model="draft.notificationPreference.mode"
                    :disabled="pending"
                    :aria-invalid="fields.mode ? 'true' : undefined"
                    :aria-describedby="fields.mode ? `${id}-mode-error` : undefined"
                >
                    <option value="summary">每次汇总</option>
                    <option value="important_change">仅重要变化</option>
                    <option value="off">关闭结果提醒</option>
                </select>
                <p v-if="fields.mode" :id="`${id}-mode-error`" class="field-error">
                    {{ fields.mode }}
                </p>
            </div>
            <label class="checkbox-field" :for="`${id}-issues`">
                <input
                    ref="issuesInput"
                    :id="`${id}-issues`"
                    v-model="draft.notificationPreference.runIssues"
                    type="checkbox"
                    :disabled="pending"
                    :aria-invalid="fields.runIssues ? 'true' : undefined"
                    :aria-describedby="fields.runIssues ? `${id}-issues-error` : undefined"
                />
                提醒失败或不完整的执行
            </label>
            <p v-if="fields.runIssues" :id="`${id}-issues-error`" class="field-error">
                {{ fields.runIssues }}
            </p>
        </fieldset>
        <p v-if="message" ref="errorMessage" role="alert" tabindex="-1" class="field-error">
            {{ message }}
        </p>
        <p v-if="saved" role="status">默认偏好已保存。</p>
        <div class="form-actions">
            <action-button
                attr-type="submit"
                :disabled="!dirty || !query.isSuccess.value"
                :busy="pending"
                >{{ pending ? '正在保存' : '保存默认偏好' }}</action-button
            >
        </div>
    </form>
</template>

<script setup lang="ts">
import { nextTick, ref, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { InputInst } from 'naive-ui';
import ActionButton from '@/components/common/ActionButton.vue';
import { usePreferences } from '@/composables/usePreferences';

const id = useId();
const { form, query } = usePreferences();
const { draft, fields, message, saved, pending, dirty } = form;
const timezones = [
    'UTC',
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Tokyo',
    'Europe/London',
    'America/New_York',
];
const timezoneInput = ref<InputInst>();
const modeInput = ref<HTMLSelectElement>();
const issuesInput = ref<HTMLInputElement>();
const errorMessage = ref<HTMLParagraphElement>();
async function submit() {
    if (!query.isSuccess.value) return;
    const outcome = await form.submit();
    if (outcome === 'invalid' || outcome === 'error') {
        await nextTick();
        if (form.firstField.value === 'defaultTimezone') timezoneInput.value?.focus();
        else if (form.firstField.value === 'mode') modeInput.value?.focus();
        else if (form.firstField.value === 'runIssues') issuesInput.value?.focus();
        else errorMessage.value?.focus();
    }
}
</script>

<style scoped>
.preferences-form,
.field,
.notification-fields,
.load-error {
    display: grid;
    min-inline-size: 0;
}
.preferences-form {
    gap: 1.5rem;
    inline-size: min(100%, 32rem);
}
.field {
    gap: 0.5rem;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
label {
    font-weight: 500;
    cursor: default;
}
.help {
    color: var(--scova-muted);
}
.notification-fields {
    gap: 1rem;
    margin: 0;
    padding: 0;
    border: 0;
}
legend {
    margin-block-end: 1rem;
    padding: 0;
    font-weight: 600;
}
.preferences-form :deep(.n-input) {
    --n-font-size: 1rem !important;
    min-block-size: 2.75rem;
    border-radius: 0.375rem;
}
.preferences-form :deep(input) {
    min-inline-size: 0;
    font-size: 1rem;
    cursor: text;
}
select {
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0.625rem 0.75rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.375rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    font: inherit;
    cursor: pointer;
}
.checkbox-field {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-block-size: 2.75rem;
    cursor: pointer;
}
.checkbox-field input {
    flex: 0 0 auto;
    inline-size: 1.125em;
    block-size: 1.125em;
    margin: 0;
    accent-color: var(--scova-primary);
    cursor: pointer;
}
select:disabled,
.checkbox-field:has(:disabled),
.checkbox-field input:disabled {
    cursor: not-allowed;
}
select:focus-visible,
.checkbox-field input:focus-visible,
.field-error:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.field-error {
    color: var(--scova-danger);
    background: var(--scova-surface);
}
.form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
}
.load-error {
    gap: 1rem;
    justify-items: start;
}
</style>
