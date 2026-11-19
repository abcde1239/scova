import { computed, ref, shallowRef } from 'vue';
import zh from './messages/zh-CN';

type AuthErrorKey = keyof typeof zh.authErrors;
export type AuthErrorTranslator = (key: `authErrors.${AuthErrorKey}`) => string;

export function authErrors<Field extends string>(translate?: AuthErrorTranslator) {
    const fieldKeys = shallowRef<Partial<Record<Field, AuthErrorKey>>>({});
    const messageKey = ref<AuthErrorKey>();
    const label = (key: AuthErrorKey) => translate?.(`authErrors.${key}`) ?? zh.authErrors[key];
    const fields = computed(() => {
        const translated: Partial<Record<Field, string>> = {};
        for (const [field, key] of Object.entries(fieldKeys.value) as [Field, AuthErrorKey][])
            translated[field] = label(key);
        return translated;
    });
    const message = computed(() => (messageKey.value ? label(messageKey.value) : ''));
    return { fieldKeys, messageKey, fields, message };
}
