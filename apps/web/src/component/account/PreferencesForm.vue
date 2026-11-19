<template>
    <form
        class="preferences-form layout-grid gap-6 w-full"
        novalidate
        :aria-busy="pending || query.isFetching.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <p class="break-anywhere m-0" v-if="query.isPending.value" role="status">
            正在读取默认偏好…
        </p>
        <div v-if="query.isError.value" class="load-error layout-stack [justify-items:start]">
            <p class="break-anywhere m-0" role="alert">默认偏好暂时无法读取，请检查连接后重试。</p>
            <action-button :busy="query.isFetching.value" @click="query.refetch()"
                >重新读取</action-button
            >
        </div>
        <div class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-timezone`">默认时区</label>
            <app-select
                ref="timezoneInput"
                v-model="draft.defaultTimezone"
                :id="`${id}-timezone`"
                label="默认时区"
                :options="timezones"
                icon="timezone"
                searchable
                search-placeholder="搜索城市或时区"
                :disabled="pending"
                :invalid="!!fields.defaultTimezone"
                :describedby="
                    fields.defaultTimezone ? `${id}-timezone-error` : `${id}-timezone-help`
                "
            />
            <p :id="`${id}-timezone-help`" class="help break-anywhere text-muted m-0">
                搜索城市或时区，选择你所在的地区。
            </p>
            <p
                v-if="fields.defaultTimezone"
                :id="`${id}-timezone-error`"
                class="field-error break-anywhere text-danger bg-surface m-0 keyboard-focus-wide"
            >
                {{ fields.defaultTimezone }}
            </p>
        </div>
        <fieldset class="notification-fields layout-stack [border:0] m-0 p-0">
            <legend class="mb-4 font-semibold p-0">默认提醒</legend>
            <div class="field layout-grid gap-2">
                <label class="font-medium cursor-default" :for="`${id}-mode`">结果提醒</label>
                <app-select
                    ref="modeInput"
                    :id="`${id}-mode`"
                    v-model="notificationMode"
                    :disabled="pending"
                    label="结果提醒"
                    :options="notificationOptions"
                    :invalid="!!fields.mode"
                    :describedby="fields.mode ? `${id}-mode-error` : undefined"
                />
                <p
                    v-if="fields.mode"
                    :id="`${id}-mode-error`"
                    class="field-error break-anywhere text-danger bg-surface m-0 keyboard-focus-wide"
                >
                    {{ fields.mode }}
                </p>
            </div>
            <label
                class="checkbox-field font-medium cursor-pointer flex items-center gap-3 min-h-11 [&.checkbox-field:has(:disabled)]:cursor-not-allowed"
                :for="`${id}-issues`"
            >
                <input
                    class="[.checkbox-field_&:is(input)]:([flex:0_0_auto] w-[1.125em] h-[1.125em] [accent-color:var(--scova-primary)] cursor-pointer m-0) [.checkbox-field_&:is(input):disabled]:cursor-not-allowed [.checkbox-field_&:is(input):focus-visible]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem])"
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
            <p
                v-if="fields.runIssues"
                :id="`${id}-issues-error`"
                class="field-error break-anywhere text-danger bg-surface m-0 keyboard-focus-wide"
            >
                {{ fields.runIssues }}
            </p>
        </fieldset>
        <p
            v-if="message && Object.keys(fields).length"
            ref="errorMessage"
            role="alert"
            tabindex="-1"
            class="field-error break-anywhere text-danger bg-surface m-0 keyboard-focus-wide"
        >
            {{ message }}
        </p>
        <div class="form-actions flex flex-wrap gap-4">
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
import { computed, nextTick, ref, useId } from 'vue';
import AppSelect from '@/component/common/AppSelect.vue';
import ActionButton from '@/component/common/ActionButton.vue';
import { usePreferences } from '@/composable/usePreferences';
import { useActionNotification } from '@/composable/useActionNotification';
import { timezoneOptions } from '@/utils/timezones';

const id = useId();
const { form, query } = usePreferences();
const notice = useActionNotification();
const { draft, fields, message, pending, dirty } = form;
const timezones = computed(() => timezoneOptions(draft.value.defaultTimezone));
const notificationMode = computed({
    get: () => draft.value.notificationPreference.mode,
    set: (value: string) => {
        if (value === 'summary' || value === 'important_change' || value === 'off')
            draft.value.notificationPreference.mode = value;
    },
});
const notificationOptions = [
    { value: 'summary', label: '每次汇总', description: '每次研究完成后提醒', icon: 'inbox' },
    {
        value: 'important_change',
        label: '仅重要变化',
        description: '只在发现重要变化时提醒',
        icon: 'notifications',
    },
    { value: 'off', label: '关闭结果提醒', description: '仍可在收件箱中查看报告', icon: 'pause' },
] as const;
const timezoneInput = ref<InstanceType<typeof AppSelect>>();
const modeInput = ref<InstanceType<typeof AppSelect>>();
const issuesInput = ref<HTMLInputElement>();
const errorMessage = ref<HTMLParagraphElement>();
async function submit() {
    if (!query.isSuccess.value) return;
    const outcome = await form.submit();
    if (outcome === 'success') notice.success('默认偏好已保存');
    else if (outcome === 'error') notice.error('默认偏好未保存', message.value);
    if (outcome === 'invalid' || outcome === 'error') {
        await nextTick();
        if (form.firstField.value === 'defaultTimezone') timezoneInput.value?.focus();
        else if (form.firstField.value === 'mode') modeInput.value?.focus();
        else if (form.firstField.value === 'runIssues') issuesInput.value?.focus();
        else errorMessage.value?.focus();
    }
}
</script>
