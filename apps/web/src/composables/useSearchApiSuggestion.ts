import { h, onScopeDispose } from 'vue';
import { RouterLink } from 'vue-router';
import type { RunEvent } from '@scova/models';
import { useActionNotification } from '@/composables/useActionNotification';
import AppIcon from '@/components/common/AppIcon.vue';

export const SLOW_SEARCH_MS = 15_000;

/** Suggest an optional alternative once per viewed run, based on the actual search tool. */
export function useSearchApiSuggestion() {
    const notice = useActionNotification();
    const prompted = new Set<string>();
    const pending = new Map<string, { runId: string; timer: ReturnType<typeof setTimeout> }>();
    function suggest(runId: string, slow: boolean) {
        if (prompted.has(runId)) return;
        prompted.add(runId);
        notice.info(
            slow ? '内置搜索等待较久' : '内置搜索暂不顺畅',
            '可在 Agent 配置中添加 Search API，需要时在下次执行选择。',
            () =>
                h(
                    RouterLink,
                    {
                        class: 'navigation-link',
                        to: { name: 'agent-settings', hash: '#search-configuration-heading' },
                    },
                    () => ['配置 Search API', h(AppIcon, { name: 'chevron' })],
                ),
        );
    }
    function reset() {
        for (const item of pending.values()) clearTimeout(item.timer);
        pending.clear();
    }
    function onEvent(event: RunEvent) {
        if (event.type === 'tool.started' && event.payload.tool === 'search') {
            const age = Date.now() - Date.parse(event.occurredAt);
            if (event.payload.searchProvider !== 'searxng' || age < -5_000 || age > 30_000) return;
            const id = event.payload.toolCallId;
            if (pending.has(id)) return;
            pending.set(id, {
                runId: event.runId,
                timer: setTimeout(
                    () => suggest(event.runId, true),
                    Math.max(0, SLOW_SEARCH_MS - age),
                ),
            });
        } else if (
            (event.type === 'tool.completed' || event.type === 'tool.failed') &&
            event.payload.tool === 'search'
        ) {
            const item = pending.get(event.payload.toolCallId);
            if (!item || item.runId !== event.runId) return;
            clearTimeout(item.timer);
            pending.delete(event.payload.toolCallId);
            if (event.type === 'tool.failed') suggest(event.runId, false);
            else if (event.payload.durationMs >= SLOW_SEARCH_MS) suggest(event.runId, true);
        } else if (['run.completed', 'run.failed', 'run.canceled'].includes(event.type)) reset();
    }
    onScopeDispose(reset);
    return { onEvent, reset };
}
