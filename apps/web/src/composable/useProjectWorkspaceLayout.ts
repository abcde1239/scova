import { computed, onMounted, onUnmounted, ref, watch, type InjectionKey } from 'vue';

export type WorkspacePanelMode = 'overview' | 'reading';
export const projectWorkspaceLayoutKey: InjectionKey<ReturnType<typeof useProjectWorkspaceLayout>> =
    Symbol('project-workspace-layout');
const defaultWidth = { sidebar: 16, overview: 20, reading: 32 } as const;
export type WorkspacePane = keyof typeof defaultWidth;
const separatorStep = 16;

export function useProjectWorkspaceLayout() {
    const viewport = ref(0);
    const rootPixels = ref(16);
    const desktop = computed(() => viewport.value >= 54 * rootPixels.value);
    const wide = computed(() => viewport.value >= 72 * rootPixels.value);
    const preferences = ref<Record<WorkspacePane, number>>({ ...defaultWidth });
    function measure() {
        rootPixels.value =
            Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        viewport.value = document.documentElement.clientWidth;
    }
    onMounted(() => {
        for (const pane of Object.keys(defaultWidth) as WorkspacePane[]) {
            try {
                const stored = Number(localStorage.getItem(`scova.workbench.width.${pane}`));
                if (Number.isFinite(stored) && stored > 0) preferences.value[pane] = stored;
            } catch {
                /* Layout remains interactive without local storage. */
            }
        }
        measure();
        window.addEventListener('resize', measure);
    });
    onUnmounted(() => window.removeEventListener('resize', measure));
    watch(
        preferences,
        (widths) => {
            try {
                for (const pane of Object.keys(widths) as WorkspacePane[])
                    localStorage.setItem(`scova.workbench.width.${pane}`, String(widths[pane]));
            } catch {
                /* Layout remains interactive without local storage. */
            }
        },
        { deep: true },
    );

    function min(pane: WorkspacePane) {
        return (pane === 'sidebar' ? 12 : 18) * rootPixels.value;
    }
    function max(pane: WorkspacePane): number {
        if (pane === 'sidebar') return 24 * rootPixels.value;
        return Math.max(
            min(pane),
            Math.floor(
                Math.min(
                    viewport.value * 0.65,
                    viewport.value - width('sidebar') - 24 * rootPixels.value,
                ),
            ),
        );
    }
    function width(pane: WorkspacePane): number {
        return Math.round(
            Math.min(max(pane), Math.max(min(pane), preferences.value[pane] * rootPixels.value)),
        );
    }
    function resize(pane: WorkspacePane, pixel: number) {
        preferences.value[pane] =
            Math.min(max(pane), Math.max(min(pane), pixel)) / rootPixels.value;
    }
    function reset(pane: WorkspacePane) {
        preferences.value[pane] = defaultWidth[pane];
    }
    function keyboard(pane: WorkspacePane, event: KeyboardEvent) {
        const step = separatorStep * (event.shiftKey ? 4 : 1) * (pane === 'sidebar' ? 1 : -1);
        switch (event.key) {
            case 'ArrowRight':
                resize(pane, width(pane) + step);
                break;
            case 'ArrowLeft':
                resize(pane, width(pane) - step);
                break;
            case 'Home':
                resize(pane, min(pane));
                break;
            case 'End':
                resize(pane, max(pane));
                break;
            case 'Enter':
                reset(pane);
                break;
            default:
                return;
        }
        event.preventDefault();
    }
    return { desktop, wide, min, max, width, resize, reset, keyboard };
}
