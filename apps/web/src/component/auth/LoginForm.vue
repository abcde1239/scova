<template>
    <form
        class="login-form layout-grid gap-6 w-full [&.login-form_.n-input]:(![--n-font-size:1rem] min-h-11 rounded-3) [&.login-form_input]:(min-w-0 text-[1rem] [cursor:text])"
        novalidate
        :aria-busy="login.pending.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <div class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-email`">{{
                t('auth.email')
            }}</label>
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
            <label class="font-medium cursor-default" :for="`${id}-password`">{{
                t('auth.password')
            }}</label>
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
        <action-button
            class="login-submit"
            type="primary"
            attr-type="submit"
            :busy="login.pending.value"
        >
            <span class="login-submit-label">{{
                t(login.pending.value ? 'auth.signingIn' : 'pages.login')
            }}</span>
        </action-button>
    </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { nextTick, watch, onUnmounted, ref, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { InputInst } from 'naive-ui';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { createLoginController } from '@/composable/useLogin';
import { useActionNotification } from '@/composable/useActionNotification';
const emit = defineEmits<{ success: [] }>();
const id = useId();
const email = ref('');
const password = ref('');
const emailInput = ref<InputInst>();
const passwordInput = ref<InputInst>();
const { t } = useI18n({ useScope: 'global' });
const login = createLoginController(useSessionLifecycle(), t);
const notification = useActionNotification();
watch(login.messageKey, (key) => {
    if (key) notification.error(login.message.value);
});
async function submit() {
    const result = await login.submit({ email: email.value, password: password.value });
    if (result === 'success') {
        password.value = '';
        emit('success');
    } else if (result === 'invalid' || result === 'error') {
        await nextTick();
        if (login.firstField.value === 'email') emailInput.value?.focus();
        else if (login.firstField.value === 'password') passwordInput.value?.focus();
    }
}
onUnmounted(() => {
    password.value = '';
    login.dispose();
});
</script>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
    .login-submit-label {
        transition: transform 140ms ease-out;
    }
    .login-submit:active:not([aria-disabled='true']) .login-submit-label {
        transform: scale(0.94);
    }
    .field-error {
        animation: login-field-error-in 160ms ease-out;
    }
}
@keyframes login-field-error-in {
    from {
        opacity: 0.65;
        transform: translateY(-0.1875rem);
    }
}
</style>
