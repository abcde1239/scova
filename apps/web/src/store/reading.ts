import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

export const READING_STORAGE_KEY = 'scova.reading.v1';
export const readingFamilies = [
    { value: 'serif', label: '衬线' },
    { value: 'sans', label: '无衬线' },
] as const;
export const readingSizes = [
    { value: 1, label: '标准' },
    { value: 1.0625, label: '稍大' },
    { value: 1.1875, label: '大' },
] as const;
export type ReadingFamily = (typeof readingFamilies)[number]['value'];
export type ReadingSize = (typeof readingSizes)[number]['value'];

function readPreference(storage: Storage | undefined): {
    family: ReadingFamily;
    size: ReadingSize;
} {
    try {
        const saved: unknown = JSON.parse(storage?.getItem(READING_STORAGE_KEY) ?? 'null');
        if (
            saved &&
            typeof saved === 'object' &&
            'version' in saved &&
            saved.version === 1 &&
            'family' in saved &&
            readingFamilies.some((option) => option.value === saved.family) &&
            'size' in saved &&
            readingSizes.some((option) => option.value === saved.size)
        )
            return { family: saved.family as ReadingFamily, size: saved.size as ReadingSize };
    } catch {
        // 无效/不可访问的存储不阻止本页阅读。
    }
    return { family: 'serif', size: 1 };
}

export const useReadingStore = defineStore('reading', () => {
    let storage: Storage | undefined;
    if (typeof window !== 'undefined') {
        try {
            storage = window.localStorage;
        } catch {
            /* 隐私模式允许本页切换。 */
        }
    }
    const saved = readPreference(storage);
    const family = ref<ReadingFamily>(saved.family);
    const size = ref<ReadingSize>(saved.size);
    const variables = computed(() => ({
        '--scova-reading-family':
            family.value === 'serif' ? 'var(--scova-font-reading)' : 'var(--scova-font-interface)',
        '--scova-reading-size': `${size.value}rem`,
    }));
    watch(
        [family, size],
        () => {
            try {
                storage?.setItem(
                    READING_STORAGE_KEY,
                    JSON.stringify({ version: 1, family: family.value, size: size.value }),
                );
            } catch {
                /* 存储失败不阻止当前阅读设置生效。 */
            }
        },
        { flush: 'sync' },
    );
    function setFamily(value: ReadingFamily) {
        if (readingFamilies.some((option) => option.value === value)) family.value = value;
    }
    function setSize(value: ReadingSize) {
        if (readingSizes.some((option) => option.value === value)) size.value = value;
    }
    return { family, size, variables, setFamily, setSize };
});
