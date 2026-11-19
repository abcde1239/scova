import { onMounted, ref } from 'vue';
import { useReadingStore } from '@/store/reading';

let fontLoading: Promise<void> | undefined;
/** 列表内容标题、报告与笔记入口共享；不在纯操作页加载阅读 CSS。 */
export function loadReadingFonts() {
    fontLoading ??= import('@/composable/reading-fonts.css')
        .then(() => {})
        .catch((error: unknown) => {
            fontLoading = undefined;
            throw error;
        });
    return fontLoading;
}

export function useReadingTypography() {
    const reading = useReadingStore();
    const ready = ref(false);
    onMounted(() => {
        void loadReadingFonts()
            .then(() => {
                ready.value = true;
            })
            .catch(() => {
                // 本地字体资产不可达时继续采用 CSS 系统回退，后续挂载可重试。
            });
    });
    return { reading, ready };
}
