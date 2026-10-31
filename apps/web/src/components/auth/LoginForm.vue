<template>
    <form
        class="login-form"
        novalidate
        :aria-busy="login.pending.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <div class="field">
            <label :for="`${id}-email`">邮箱</label>
            <n-input
                ref="emailInput"
                placeholder=""
                v-model:value="email"
                :readonly="login.pending.value"
                :input-props="{
                    id: `${id}-email`,
                    type: 'email',
                    autocomplete: 'username',
                    maxlength: 254,
                    'aria-invalid': login.fields.value.email ? 'true' : undefined,
                    'aria-describedby': login.fields.value.email ? `${id}-email-error` : undefined,
                }"
            />
            <p v-if="login.fields.value.email" :id="`${id}-email-error`" class="field-error">
                {{ login.fields.value.email }}
            </p>
        </div>
        <div class="field">
            <label :for="`${id}-password`">密码</label>
            <n-input
                ref="passwordInput"
                placeholder=""
                v-model:value="password"
                type="password"
                :readonly="login.pending.value"
                :input-props="{
                    id: `${id}-password`,
                    autocomplete: 'current-password',
                    maxlength: 128,
                    'aria-invalid': login.fields.value.password ? 'true' : undefined,
                    'aria-describedby': login.fields.value.password
                        ? `${id}-password-error`
                        : undefined,
                }"
            />
            <p v-if="login.fields.value.password" :id="`${id}-password-error`" class="field-error">
                {{ login.fields.value.password }}
            </p>
        </div>
        <p
            v-if="login.message.value"
            ref="errorMessage"
            role="alert"
            tabindex="-1"
            class="field-error"
        >
            {{ login.message.value }}
        </p>
        <action-button attr-type="submit" :busy="login.pending.value">{{
            login.pending.value ? '正在登录' : '登录'
        }}</action-button>
    </form>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { InputInst } from 'naive-ui';
import ActionButton from '@/components/common/ActionButton.vue';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { createLoginController } from '@/composables/useLogin';
const emit = defineEmits<{ success: [] }>();
const id = useId();
const email = ref('');
const password = ref('');
const emailInput = ref<InputInst>();
const passwordInput = ref<InputInst>();
const errorMessage = ref<HTMLParagraphElement>();
const login = createLoginController(useSessionLifecycle());
async function submit() {
    const result = await login.submit({ email: email.value, password: password.value });
    if (result === 'success') {
        password.value = '';
        emit('success');
    } else if (result === 'invalid' || result === 'error') {
        await nextTick();
        if (login.firstField.value === 'email') emailInput.value?.focus();
        else if (login.firstField.value === 'password') passwordInput.value?.focus();
        else errorMessage.value?.focus();
    }
}
onUnmounted(() => {
    password.value = '';
    login.dispose();
});
</script>

<style scoped>
.login-form {
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
.login-form :deep(.n-input) {
    --n-font-size: 1rem !important;
    min-block-size: 2.75rem;
    border-radius: 0.375rem;
}
.login-form :deep(input) {
    min-inline-size: 0;
    font-size: 1rem;
    cursor: text;
}
.field-error {
    margin: 0;
    color: var(--scova-danger);
    background: var(--scova-surface);
    overflow-wrap: anywhere;
}
.field-error:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
