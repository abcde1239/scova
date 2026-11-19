import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createMemoryHistory } from 'vue-router';
import { createInterfaceI18n, interfaceLanguageKey, rememberInterfaceLocale } from '@/utils/i18n';
import { createWorkbenchRouter, pageTitle } from '@/router';

afterEach(() => vi.unstubAllGlobals());

describe('interface language preference', () => {
    it('uses a Chinese default, independent of the browser language', () => {
        vi.stubGlobal('window', {
            navigator: { languages: ['en-US'] },
            localStorage: { getItem: () => 'fr' },
        });
        expect(createInterfaceI18n().global.locale.value).toBe('zh-CN');
    });

    it('persists only a local UI locale and translates route titles for a new app instance', () => {
        const values = new Map<string, string>();
        vi.stubGlobal('window', {
            localStorage: { getItem: values.get.bind(values), setItem: values.set.bind(values) },
        });
        rememberInterfaceLocale('en');
        const i18n = createInterfaceI18n();
        const route = createWorkbenchRouter(createMemoryHistory()).resolve('/library/search');
        expect([...values]).toEqual([[interfaceLanguageKey, 'en']]);
        expect(i18n.global.locale.value).toBe('en');
        expect(pageTitle(route, i18n.global.t)).toBe('Search library · Scova');
        i18n.global.locale.value = 'zh-CN';
        expect(pageTitle(route, i18n.global.t)).toBe('搜索已存资料 · 知巡 Scova');
    });

    it('keeps startup and switching usable when browser storage is blocked', () => {
        vi.stubGlobal('window', {
            get localStorage() {
                throw new Error('blocked');
            },
        });
        expect(createInterfaceI18n().global.locale.value).toBe('zh-CN');
        expect(() => rememberInterfaceLocale('en')).not.toThrow();
    });
});
