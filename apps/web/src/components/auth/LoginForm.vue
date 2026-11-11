<template>
    <form
        class="login-form layout-grid gap-6 w-full [&.login-form_.n-input]:(![--n-font-size:1rem] min-h-11 rounded-3) [&.login-form_input]:(min-w-0 text-[1rem] [cursor:text])"
        novalidate
        :aria-busy="login.pending.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <div class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-email`">邮箱</label>
            <n-input
                ref="emailInput"
                placeholder=""
                v-model:value="email"
                :readonly="login.pending.value"
                :status="login.fields.value.email ? 'error' : undefined"
                :input-props="{
                    id: `${id}-email`,
                    type: 'email',
                    autocomplete: 'username',
                    maxlength: 254,
                    'aria-invalid': login.fields.value.email ? 'true' : undefined,
                    'aria-describedby': login.fields.value.email ? `${id}-email-error` : undefined,
                }"
            />
            <p
                v-if="login.fields.value.email"
                :id="`${id}-email-error`"
                class="field-error flex items-start gap-1.5 text-danger text-[0.8125rem] leading-[1.5] break-anywhere m-0 [&.field-error_.app-icon]:mt-[0.1875rem]"
            >
                <app-icon name="warning" />
                {{ login.fields.value.email }}
            </p>
        </div>
        <div class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-password`">密码</label>
            <n-input
                ref="passwordInput"
                placeholder=""
                v-model:value="password"
                type="password"
                :readonly="login.pending.value"
                :status="login.fields.value.password ? 'error' : undefined"
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
            <p
                v-if="login.fields.value.password"
                :id="`${id}-password-error`"
                class="field-error flex items-start gap-1.5 text-danger text-[0.8125rem] leading-[1.5] break-anywhere m-0 [&.field-error_.app-icon]:mt-[0.1875rem]"
            >
                <app-icon name="warning" />
                {{ login.fields.value.password }}
            </p>
        </div>
        <p
            v-if="login.message.value"
            ref="errorMessage"
            role="alert"
            tabindex="-1"
            class="form-error rounded-3 text-danger [background:color-mix(in_srgb,_var(--scova-danger)_7%,_var(--scova-surface))] text-[0.875rem] break-anywhere m-0 py-3 px-3.5 keyboard-focus-wide"
        >
            {{ login.message.value }}
        </p>
        <action-button type="primary" attr-type="submit" :busy="login.pending.value">{{
            login.pending.value ? '正在登录' : '登录'
        }}</action-button>
    </form>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { InputInst } from 'naive-ui';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
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
