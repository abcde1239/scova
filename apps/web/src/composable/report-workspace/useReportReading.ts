import { nextTick, onBeforeUnmount, ref } from 'vue';
import type { Report } from '@scova/models';
import type { ComputedRef, Ref } from 'vue';

export function useReportReading(
    routeIdentity: ComputedRef<string>,
    report: ComputedRef<Report | undefined>,
    readingQuery: ComputedRef<{ refetch: () => Promise<unknown> }>,
    detail: Ref<HTMLElement | undefined>,
    artifactCard: Ref<HTMLButtonElement | undefined>,
) {
    const readingOnly = ref(false);
    const artifactOpen = ref(true);
    let readingAnimation: Animation | undefined;
    onBeforeUnmount(() => readingAnimation?.cancel());
    async function expandArtifact(reading: boolean) {
        const panel = detail.value?.querySelector<HTMLElement>('#report-artifact');
        // Measure the visible floating panel before changing the grid. Animate the same
        // element back from those bounds so its scroll state and saved content survive.
        const before = panel?.getBoundingClientRect();
        readingAnimation?.cancel();
        readingOnly.value = reading;
        artifactOpen.value = true;
        await nextTick();
        if (
            !panel?.isConnected ||
            !before?.width ||
            !before.height ||
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        )
            return;
        const after = panel.getBoundingClientRect();
        if (!after.width || !after.height) return;
        readingAnimation = panel.animate(
            [
                {
                    transformOrigin: 'top left',
                    transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`,
                },
                { transformOrigin: 'top left', transform: 'none' },
            ],
            { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
        await readingAnimation.finished.catch(() => {});
    }
    async function openArtifact() {
        const identity = routeIdentity.value;
        artifactOpen.value = true;
        readingOnly.value ||= window.matchMedia('(width < 64rem)').matches;
        await nextTick();
        if (identity !== routeIdentity.value || !report.value) return;
        if (readingOnly.value)
            detail.value
                ?.querySelector<HTMLElement>('#report-title')
                ?.focus({ preventScroll: true });
        else detail.value?.querySelector<HTMLButtonElement>('.artifact-close')?.focus();
    }
    async function closeArtifact() {
        if (readingOnly.value) return;
        const identity = routeIdentity.value;
        artifactOpen.value = false;
        await nextTick();
        if (identity === routeIdentity.value) artifactCard.value?.focus();
    }
    async function openReading() {
        const identity = routeIdentity.value;
        await expandArtifact(true);
        if (identity !== routeIdentity.value || !readingOnly.value || !report.value) return;
        const title = detail.value?.querySelector<HTMLElement>('#report-title');
        title?.focus({ preventScroll: true });
    }
    async function openConversation() {
        const identity = routeIdentity.value;
        await expandArtifact(false);
        if (identity !== routeIdentity.value || readingOnly.value) return;
        const target = detail.value?.querySelector<HTMLElement>('#report-conversation');
        const input = target?.querySelector<HTMLTextAreaElement>(
            '#report-question:not([readonly])',
        );
        (input ?? target)?.focus({ preventScroll: true });
    }
    async function retry() {
        const restoreFocus = detail.value?.contains(document.activeElement);
        await readingQuery.value.refetch();
        if (restoreFocus && report.value) {
            await nextTick();
            detail.value?.querySelector<HTMLElement>('#report-title')?.focus();
        }
    }

    return {
        detail,
        readingOnly,
        artifactOpen,
        artifactCard,
        openArtifact,
        closeArtifact,
        openReading,
        openConversation,
        retry,
        cancelReadingAnimation: () => readingAnimation?.cancel(),
    };
}
