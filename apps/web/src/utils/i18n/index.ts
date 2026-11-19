import { createI18n } from 'vue-i18n';
import en from './messages/en';
import zh from './messages/zh-CN';

export const interfaceLocales = ['zh-CN', 'en'] as const;
export type InterfaceLocale = (typeof interfaceLocales)[number];
export const interfaceLanguageKey = 'scova.interface-language';
const defaultLocale = 'zh-CN';
const messages = { 'zh-CN': zh, en: en satisfies typeof zh };

export function isInterfaceLocale(value: unknown): value is InterfaceLocale {
    return interfaceLocales.some((locale) => locale === value);
}

function readLocale(): InterfaceLocale {
    try {
        const saved = window.localStorage.getItem(interfaceLanguageKey);
        if (isInterfaceLocale(saved)) return saved;
    } catch {
        // A blocked storage policy must not prevent startup.
    }
    return defaultLocale;
}

export function rememberInterfaceLocale(locale: InterfaceLocale) {
    try {
        window.localStorage.setItem(interfaceLanguageKey, locale);
    } catch {
        // The current app session can still use the selected language.
    }
}

export function createInterfaceI18n() {
    return createI18n({
        legacy: false,
        locale: readLocale(),
        fallbackLocale: defaultLocale,
        messages,
    });
}
