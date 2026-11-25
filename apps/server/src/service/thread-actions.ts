import { and, eq, projectThreadItems } from '@scova/db';
import type { ApiServices } from '@/app/services';
import { appendProjectThreadItems, createProjectThreadStore } from '@/repo/project-threads.ts';
import { createProjectConversationStore } from '@/repo/project-conversations.ts';
import { requireVisibleProjectEvidence } from '@/service/project-evidence.ts';
import { createProjectStore } from '@/repo/projects.ts';
import { confirmThreadDraft, queuedThreadRunItem } from '@/service/thread-draft-confirmation.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid } from '@/utils/security.ts';

export const threadMissing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
export const requireWritableThread = (thread: { archivedAt: Date | null }) => {
    if (thread.archivedAt) throw new ApiError(409, 'THREAD_ARCHIVED', '请先恢复已归档的会话');
};

export function createThreadActionService(services: ApiServices) {
    return async function decide(
        userId: string,
        threadId: string,
        actionId: string,
        approve: boolean,
    ) {
        const thread = await createProjectThreadStore(services.db(), userId).find(threadId);
        if (!thread) throw threadMissing();
        return services.db().transaction(async (tx) => {
            if (!(await createProjectStore(tx).lockProject(userId, thread.projectId)))
                throw threadMissing();
            const current = await createProjectThreadStore(tx, userId).lock(threadId);
            if (!current) throw threadMissing();
            const filter = and(
                eq(projectThreadItems.userId, userId),
                eq(projectThreadItems.threadId, threadId),
                eq(projectThreadItems.id, actionId),
                eq(projectThreadItems.kind, 'plan'),
            );
            const [item] = await tx.select().from(projectThreadItems).where(filter);
            if (!item || item.payload.command !== 'start_run') throw threadMissing();
            const { draftId, revision } = item.payload;
            if (typeof draftId !== 'string' || !isUuid(draftId) || typeof revision !== 'number')
                throw threadMissing();
            const store = createProjectConversationStore(tx, userId, thread.projectId, threadId);
            const draft = await store.draft(draftId);
            if (!draft) throw threadMissing();
            const status = approve ? 'applied' : 'rejected';
            const receipt = {
                actionId,
                status,
                taskId: approve ? draft.confirmedTaskId : null,
                runId: approve ? draft.confirmedRunId : null,
            } as const;
            if (item.status === status) return receipt;
            requireWritableThread(current);
            if (
                item.status !== 'pending' ||
                draft.revision !== revision ||
                (!approve && draft.confirmedStart !== null)
            )
                throw new ApiError(409, 'ACTION_CONFLICT', '此操作已处理或草案已更新');
            if (approve)
                await requireVisibleProjectEvidence(tx, userId, thread.projectId, item.refs);
            const result = approve
                ? await confirmThreadDraft(services, tx, store, draft, true)
                : undefined;
            const decision = {
                ...receipt,
                taskId: result?.taskId ?? null,
                runId: result?.runId ?? null,
            };
            await tx.update(projectThreadItems).set({ status }).where(filter);
            await appendProjectThreadItems(
                tx,
                userId,
                threadId,
                [
                    {
                        turnId: item.turnId,
                        kind: 'plan',
                        payload: decision,
                        status,
                    },
                    ...(result?.runId
                        ? [queuedThreadRunItem(item.turnId, result.taskId, result.runId)]
                        : []),
                ],
                services.clock(),
            );
            return decision;
        });
    };
}
