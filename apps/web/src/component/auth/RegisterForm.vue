<template>
    <form
        class="register-form layout-grid gap-6 w-full [&.register-form_.n-input]:(![--n-font-size:1rem] min-h-11 rounded-3) [&.register-form_input]:(min-w-0 text-[1rem] [cursor:text])"
        novalidate
        :aria-busy="registration.pending.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <div v-for="field in fieldList" :key="field.key" class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-${field.key}`">{{
                t(field.label)
            }}</label>
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
                class="break-anywhere m-0 [.field_>_&:is(p):not(.field-error)]:(text-muted text-[0.875rem])"
                v-if="field.key === 'password' && !registration.fields.value.password"
                :id="`${id}-password-help`"
            >
                {{ t('auth.passwordHint') }}
            </p>
            <p
                v-if="registration.fields.value[field.key]"
                :id="`${id}-${field.key}-error`"
                class="field-error break-anywhere flex items-start gap-1.5 text-danger text-[0.8125rem] leading-[1.5] m-0 [.field_>_&:is(p):not(.field-error)]:(text-muted text-[0.875rem]) [&.field-error_.app-icon]:mt-[0.1875rem]"
            >
                <app-icon name="warning" />
                {{ registration.fields.value[field.key] }}
            </p>
        </div>
        <div class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-defaultTimezone`">{{
                t('auth.timezone')
            }}</label>
            <app-select
                :id="`${id}-defaultTimezone`"
                v-model="input.defaultTimezone"
                :label="t('auth.timezone')"
                :options="timezones"
                icon="timezone"
                searchable
                :search-placeholder="t('auth.searchTimezone')"
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
                class="field-error break-anywhere flex items-start gap-1.5 text-danger text-[0.8125rem] leading-[1.5] m-0 [.field_>_&:is(p):not(.field-error)]:(text-muted text-[0.875rem]) [&.field-error_.app-icon]:mt-[0.1875rem]"
            >
                <app-icon name="warning" />{{ registration.fields.value.defaultTimezone }}
            </p>
        </div>
        <action-button
            type="primary"
            attr-type="submit"
            :busy="registration.pending.value"
            :disabled="registration.closed.value"
            >{{
                t(registration.pending.value ? 'auth.signingUp' : 'pages.register')
            }}</action-button
        >
        <auth-switch-link />
    </form>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { nextTick, watch, onUnmounted, reactive, useId } from 'vue';
import { NInput } from 'naive-ui';
import type { RegisterInput } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import AuthSwitchLink from '@/component/auth/AuthSwitchLink.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import AppSelect from '@/component/common/AppSelect.vue';
import { timezoneOptions } from '@/utils/timezones';
import { createRegisterController } from '@/composable/useRegister';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { useActionNotification } from '@/composable/useActionNotification';
const emit = defineEmits<{ success: [] }>();
const id = useId();
const { t } = useI18n({ useScope: 'global' });
const registration = createRegisterController(useSessionLifecycle(), t);
const notification = useActionNotification();
watch(registration.messageKey, (key) => {
    if (key) notification.error(registration.message.value);
});
const input = reactive<RegisterInput>({
    email: '',
    password: '',
    defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
});
const fieldList = [
    { key: 'email', label: 'auth.email' },
    { key: 'password', label: 'auth.password' },
] as const;
const timezones = timezoneOptions(input.defaultTimezone);
async function submit() {
    const outcome = await registration.submit({ ...input });
    if (outcome === 'success') {
        input.password = '';
        emit('success');
    } else if (outcome === 'invalid' || outcome === 'error') {
        await nextTick();
        const field = registration.firstField.value;
        if (field) document.getElementById(`${id}-${field}`)?.focus();
    }
}
onUnmounted(() => {
    input.password = '';
    registration.dispose();
});
</script>
