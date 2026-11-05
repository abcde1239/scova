<template>
    <form
        class="register-form"
        novalidate
        :aria-busy="registration.pending.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <div v-for="field in fieldList" :key="field.key" class="field">
            <label :for="`${id}-${field.key}`">{{ field.label }}</label>
            <n-input
                v-model:value="input[field.key]"
                :status="registration.fields.value[field.key] ? 'error' : undefined"
                :type="field.key === 'password' ? 'password' : 'text'"
                :readonly="registration.pending.value || registration.closed.value"
                placeholder=""
                :input-props="{
                    id: `${id}-${field.key}`,
                    ...(field.key === 'email'
                        ? { type: 'email', autocomplete: 'username', maxlength: 254 }
                        : field.key === 'password'
                          ? { autocomplete: 'new-password', maxlength: 128 }
                          : { autocomplete: 'off', spellcheck: false }),
                    'aria-invalid': registration.fields.value[field.key] ? 'true' : undefined,
                    'aria-describedby': registration.fields.value[field.key]
                        ? `${id}-${field.key}-error`
                        : field.key === 'password'
                          ? `${id}-password-help`
                          : undefined,
                }"
            />
            <p
                v-if="field.key === 'password' && !registration.fields.value.password"
                :id="`${id}-password-help`"
            >
                至少 8 位，无需特殊组合
            </p>
            <p
                v-if="registration.fields.value[field.key]"
                :id="`${id}-${field.key}-error`"
                class="field-error"
            >
                <app-icon name="warning" />
                {{ registration.fields.value[field.key] }}
            </p>
        </div>
        <div class="field">
            <label :for="`${id}-defaultTimezone`">默认时区</label>
            <app-select
                :id="`${id}-defaultTimezone`"
                v-model="input.defaultTimezone"
                label="默认时区"
                :options="timezones"
                icon="timezone"
                searchable
                search-placeholder="搜索城市或时区"
                :disabled="registration.pending.value || registration.closed.value"
                :invalid="!!registration.fields.value.defaultTimezone"
                :describedby="
                    registration.fields.value.defaultTimezone
                        ? `${id}-defaultTimezone-error`
                        : undefined
                "
            />
            <p
                v-if="registration.fields.value.defaultTimezone"
                :id="`${id}-defaultTimezone-error`"
                class="field-error"
            >
                <app-icon name="warning" />{{ registration.fields.value.defaultTimezone }}
            </p>
        </div>
        <p
            v-if="registration.message.value"
            ref="alert"
            role="alert"
            tabindex="-1"
            class="form-error"
        >
            {{ registration.message.value }}
        </p>
        <action-button
            type="primary"
            attr-type="submit"
            :busy="registration.pending.value"
            :disabled="registration.closed.value"
            >{{ registration.pending.value ? '正在注册' : '注册' }}</action-button
        >
        <auth-switch-link />
    </form>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, reactive, ref, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { RegisterInput } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import AuthSwitchLink from '@/components/auth/AuthSwitchLink.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import AppSelect from '@/components/common/AppSelect.vue';
import { timezoneOptions } from '@/utils/timezones';
import { createRegisterController } from '@/composables/useRegister';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const emit = defineEmits<{ success: [] }>();
const id = useId();
const registration = createRegisterController(useSessionLifecycle());
const input = reactive<RegisterInput>({
    email: '',
    password: '',
    defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
});
const fieldList = [
    { key: 'email', label: '邮箱' },
    { key: 'password', label: '密码' },
] as const;
const timezones = timezoneOptions(input.defaultTimezone);
const alert = ref<HTMLParagraphElement>();
async function submit() {
    const outcome = await registration.submit({ ...input });
    if (outcome === 'success') {
        input.password = '';
        emit('success');
    } else if (outcome === 'invalid' || outcome === 'error') {
        await nextTick();
        const field = registration.firstField.value;
        if (field) document.getElementById(`${id}-${field}`)?.focus();
        else alert.value?.focus();
    }
}
onUnmounted(() => {
    input.password = '';
    registration.dispose();
});
</script>

<style scoped>
.register-form {
    display: grid;
    gap: 1.5rem;
    inline-size: 100%;
    min-inline-size: 0;
}
.field {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
}
label {
    font-weight: 500;
    cursor: default;
}
.register-form :deep(.n-input) {
    --n-font-size: 1rem !important;
    min-block-size: 2.75rem;
    border-radius: 0.75rem;
}
.register-form :deep(input) {
    min-inline-size: 0;
    font-size: 1rem;
    cursor: text;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
.field > p:not(.field-error) {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.field-error {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
    color: var(--scova-danger);
    font-size: 0.8125rem;
    line-height: 1.5;
}
.field-error :deep(.app-icon) {
    margin-block-start: 0.1875rem;
}
.form-error {
    padding: 0.75rem 0.875rem;
    border-radius: 0.75rem;
    color: var(--scova-danger);
    background: color-mix(in srgb, var(--scova-danger) 7%, var(--scova-surface));
    font-size: 0.875rem;
}
.form-error:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
