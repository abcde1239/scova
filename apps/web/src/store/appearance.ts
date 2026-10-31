import { computed, onScopeDispose, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { accentOptions, modeOptions, type Accent, type AppearanceMode } from '@/theme/tokens';

export const APPEARANCE_STORAGE_KEY = 'scova.appearance.v1';

function readPreference(storage: Storage | undefined): { accent: Accent; mode: AppearanceMode } {
    const fallback = { accent: 'blue' as const, mode: 'system' as const };
    try {
        const stored: unknown = JSON.parse(storage?.getItem(APPEARANCE_STORAGE_KEY) ?? 'null');
        if (
            stored &&
            typeof stored === 'object' &&
            'version' in stored &&
            stored.version === 1 &&
            'accent' in stored &&
            accentOptions.some((option) => option.value === stored.accent) &&
            'mode' in stored &&
            modeOptions.some((option) => option.value === stored.mode)
        )
            return { accent: stored.accent as Accent, mode: stored.mode as AppearanceMode };
    } catch {
        // 无效或不可访问的存储只影响外观，不读取或改动会话。
    }
    return fallback;
}

export const useAppearanceStore = defineStore('appearance', () => {
    let storage: Storage | undefined;
    let media: MediaQueryList | undefined;
    if (typeof window !== 'undefined') {
        try {
            storage = window.localStorage;
        } catch {
            // 浏览器隐私策略可能禁用 localStorage，仍允许本页切换。
        }
        media = window.matchMedia?.('(prefers-color-scheme: dark)');
    }
    const saved = readPreference(storage);
    const accent = ref<Accent>(saved.accent);
    const mode = ref<AppearanceMode>(saved.mode);
    const systemDark = ref(media?.matches ?? false);
    const scheme = computed(() =>
        mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
    );
    const onSystemChange = (event: MediaQueryListEvent) => {
        systemDark.value = event.matches;
    };
    media?.addEventListener('change', onSystemChange);
    onScopeDispose(() => media?.removeEventListener('change', onSystemChange));
    watch(
        [accent, mode],
        () => {
            try {
                storage?.setItem(
                    APPEARANCE_STORAGE_KEY,
                    JSON.stringify({ version: 1, accent: accent.value, mode: mode.value }),
                );
            } catch {
                // 存储写入失败不阻止外观切换。
            }
        },
        { flush: 'sync' },
    );
    function setAccent(value: Accent) {
        if (accentOptions.some((option) => option.value === value)) accent.value = value;
    }
    function setMode(value: AppearanceMode) {
        if (modeOptions.some((option) => option.value === value)) mode.value = value;
    }
    return { accent, mode, scheme, setAccent, setMode };
});
