<template>
    <form
        class="register-form layout-grid gap-6 w-full [&.register-form_.n-input]:(![--n-font-size:1rem] min-h-11 rounded-3) [&.register-form_input]:(min-w-0 text-[1rem] [cursor:text])"
        novalidate
        :aria-busy="registration.pending.value ? 'true' : undefined"
        @submit.prevent="submit"
    >
        <div v-for="field in fieldList" :key="field.key" class="field layout-grid gap-2">
            <label class="font-medium cursor-default" :for="`${id}-${field.key}`">{{
                field.label
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
                至少 8 位，无需特殊组合
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
            <label class="font-medium cursor-default" :for="`${id}-defaultTimezone`"
                >默认时区</label
            >
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
                class="field-error break-anywhere flex items-start gap-1.5 text-danger text-[0.8125rem] leading-[1.5] m-0 [.field_>_&:is(p):not(.field-error)]:(text-muted text-[0.875rem]) [&.field-error_.app-icon]:mt-[0.1875rem]"
            >
                <app-icon name="warning" />{{ registration.fields.value.defaultTimezone }}
            </p>
        </div>
        <p
            v-if="registration.message.value"
            ref="alert"
            role="alert"
            tabindex="-1"
            class="form-error break-anywhere rounded-3 text-danger [background:color-mix(in_srgb,_var(--scova-danger)_7%,_var(--scova-surface))] text-[0.875rem] m-0 py-3 px-3.5 keyboard-focus-wide"
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
