import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from '@/store/appearance';
import { accentOptions, themeOverrides, themeTokens, themeVariables } from '@/utils/theme/tokens';

const pins: ReturnType<typeof createPinia>[] = [];

function setup(saved: string | null = null, dark = false) {
    const items = new Map<string, string>([
        ['unrelated-session', 'leave-alone'],
        ...(saved ? [[APPEARANCE_STORAGE_KEY, saved] as const] : []),
    ]);
    const listeners = new Set<(event: { matches: boolean }) => void>();
    const storage = {
        getItem: vi.fn((key: string) => items.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => items.set(key, value)),
    };
    const media = {
        matches: dark,
        addEventListener: vi.fn((_name: string, callback: (event: { matches: boolean }) => void) =>
            listeners.add(callback),
        ),
        removeEventListener: vi.fn(
            (_name: string, callback: (event: { matches: boolean }) => void) =>
                listeners.delete(callback),
        ),
    };
    vi.stubGlobal('window', { localStorage: storage, matchMedia: () => media });
    const mount = () => {
        const pinia = createPinia();
        pins.push(pinia);
        setActivePinia(pinia);
        return { pinia, store: useAppearanceStore() };
    };
    return {
        ...mount(),
        mount,
        storage,
        items,
        listeners,
        media,
        changeSystem: (matches: boolean) => {
            for (const listener of listeners) listener({ matches });
        },
    };
}

afterEach(() => {
    for (const pinia of pins.splice(0)) disposePinia(pinia);
    vi.unstubAllGlobals();
});

describe('外观偏好', () => {
    it('默认蓝色并跟随系统，媒体变化立即生效', () => {
        const { store, changeSystem } = setup();
        expect(store.accent).toBe('blue');
        expect(store.mode).toBe('system');
        expect(store.scheme).toBe('light');
        changeSystem(true);
        expect(store.scheme).toBe('dark');
        changeSystem(false);
        expect(store.scheme).toBe('light');
    });

    it.each(['light', 'dark'] as const)('显式 %s 不被系统变化覆盖，回到系统后取当前值', (mode) => {
        const { store, changeSystem } = setup();
        store.setMode(mode);
        changeSystem(true);
        expect(store.scheme).toBe(mode);
        changeSystem(false);
        expect(store.scheme).toBe(mode);
        changeSystem(true);
        store.setMode('system');
        expect(store.scheme).toBe('dark');
    });

    it.each(accentOptions)('$label 在刷新后保留；只持久化非敏感外观字段', ({ value }) => {
        const { store, mount, items, storage } = setup();
        store.setAccent(value);
        store.setMode('dark');
        const refreshed = mount().store;
        expect(refreshed.accent).toBe(value);
        expect(refreshed.mode).toBe('dark');
        expect(JSON.parse(items.get(APPEARANCE_STORAGE_KEY)!)).toEqual({
            version: 1,
            accent: value,
            mode: 'dark',
        });
        expect(items.get('unrelated-session')).toBe('leave-alone');
        expect(storage.getItem.mock.calls.every(([key]) => key === APPEARANCE_STORAGE_KEY)).toBe(
            true,
        );
    });

    it.each([
        '{broken',
        'null',
        '[]',
        JSON.stringify({ version: 2, accent: 'blue', mode: 'dark' }),
        JSON.stringify({ version: 1, accent: 'pink', mode: 'dark' }),
        JSON.stringify({ version: 1, accent: 'blue', mode: 'automatic' }),
    ])('损坏偏好 %s 恢复蓝色/系统且不影响其他存储', (saved) => {
        const { store, items } = setup(saved, true);
        expect(store.accent).toBe('blue');
        expect(store.mode).toBe('system');
        expect(store.scheme).toBe('dark');
        expect(items.get('unrelated-session')).toBe('leave-alone');
    });

    it('存储读取或写入失败仍可在本页切换', () => {
        const { store, storage } = setup();
        storage.setItem.mockImplementation(() => {
            throw new DOMException('Blocked', 'SecurityError');
        });
        expect(() => store.setAccent('pine')).not.toThrow();
        expect(store.accent).toBe('pine');
        vi.stubGlobal('window', {
            get localStorage() {
                throw new DOMException('Blocked', 'SecurityError');
            },
        });
        const pinia = createPinia();
        pins.push(pinia);
        setActivePinia(pinia);
        const blocked = useAppearanceStore();
        expect(blocked.accent).toBe('blue');
        expect(() => blocked.setMode('dark')).not.toThrow();
        expect(blocked.scheme).toBe('dark');
    });

    it('store释放后移除系统监听，不残留跨挂载订阅', () => {
        const { store, listeners, media } = setup();
        expect(listeners.size).toBe(1);
        store.$dispose();
        expect(listeners.size).toBe(0);
        expect(media.removeEventListener).toHaveBeenCalledTimes(1);
    });

    it('无浏览器环境可安全创建默认外观', () => {
        vi.stubGlobal('window', undefined);
        const pinia = createPinia();
        pins.push(pinia);
        setActivePinia(pinia);
        expect(useAppearanceStore().scheme).toBe('light');
    });
});

function luminance(hex: string) {
    const values = hex
        .slice(1)
        .match(/.{2}/g)!
        .map((value) => Number.parseInt(value, 16) / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}

function contrast(first: string, second: string) {
    const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (high! + 0.05) / (low! + 0.05);
}

describe('四色浅暗主题', () => {
    for (const { value: accent } of accentOptions)
        for (const scheme of ['light', 'dark'] as const) {
            it(`${accent}/${scheme} 正文/操作/引用/状态对比度达4.5，边界达3`, () => {
                const colors = themeTokens(accent, scheme);
                for (const background of [colors.canvas, colors.surface, colors.selected]) {
                    for (const foreground of [
                        colors.text,
                        colors.muted,
                        colors.primary,
                        colors.partial,
                        colors.danger,
                    ])
                        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
                    expect(contrast(colors.border, background)).toBeGreaterThanOrEqual(3);
                }
                for (const background of [
                    colors.primary,
                    colors.primaryHover,
                    colors.primaryPressed,
                ])
                    expect(contrast(colors.onPrimary, background)).toBeGreaterThanOrEqual(4.5);
            });

            it(`${accent}/${scheme} Naive配置与语义变量保持同源，状态不随主色改变`, () => {
                const colors = themeTokens(accent, scheme);
                const overrides = themeOverrides(accent, scheme);
                expect(overrides.common?.primaryColor).toBe(colors.primary);
                expect(overrides.Button?.textColorPrimary).toBe(colors.onPrimary);
                expect(themeVariables(accent, scheme)['--scova-primary']).toBe(colors.primary);
                expect(colors.partial).toBe(themeTokens('blue', scheme).partial);
                expect(colors.danger).toBe(themeTokens('blue', scheme).danger);
                expect(overrides.common?.borderRadius).toBe('0.375rem');
                expect(overrides.common?.fontSize).toBe('1rem');
            });
        }
});
