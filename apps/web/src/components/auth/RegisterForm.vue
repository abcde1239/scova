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
            <p v-if="field.key === 'password'" :id="`${id}-password-help`">12至128个字符</p>
            <p
                v-if="registration.fields.value[field.key]"
                :id="`${id}-${field.key}-error`"
                class="field-error"
            >
                {{ registration.fields.value[field.key] }}
            </p>
        </div>
        <p
            v-if="registration.message.value"
            ref="alert"
            role="alert"
            tabindex="-1"
            class="field-error"
        >
            {{ registration.message.value }}
        </p>
        <action-button
            attr-type="submit"
            :busy="registration.pending.value"
            :disabled="registration.closed.value"
            >{{ registration.pending.value ? '正在注册' : '注册' }}</action-button
        >
        <router-link to="/login">返回登录</router-link>
    </form>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, reactive, ref, useId } from 'vue';
import { RouterLink } from 'vue-router';
import { NInput } from 'naive-ui';
import type { RegisterInput } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
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
    { key: 'defaultTimezone', label: '默认时区' },
] as const;
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
    inline-size: min(100%, 28rem);
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
    border-radius: 0.375rem;
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
.field-error {
    color: var(--scova-danger);
    background: var(--scova-surface);
}
a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    width: fit-content;
    max-inline-size: 100%;
    color: var(--scova-primary);
    cursor: pointer;
}
a:focus-visible,
.field-error:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
