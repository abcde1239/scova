import { createHash } from 'node:crypto';
import {
    projectThreadRunOrigins,
    type DatabaseTransaction,
    type projectResearchDrafts,
} from '@scova/db';
import type { ApiServices } from '@/app/services';
import type { createProjectConversationStore } from '@/repo/project-conversations.ts';
import { createTaskService } from '@/service/tasks.ts';
import { ApiError } from '@/utils/errors.ts';

export function queuedThreadRunItem(turnId: string | null, taskId: string, runId: string) {
    return {
        kind: 'run',
        turnId,
        status: 'queued',
        payload: { runId, taskId, status: 'queued' },
    } as const;
}

export async function confirmThreadDraft(
    services: ApiServices,
    tx: DatabaseTransaction,
    store: ReturnType<typeof createProjectConversationStore>,
    draft: typeof projectResearchDrafts.$inferSelect,
    start: boolean,
) {
    const { userId, projectId, threadId } = draft;
    const tasks = createTaskService(services);
    if (draft.confirmedStart !== null) {
        if (draft.confirmedStart !== Number(start))
            throw new ApiError(409, 'DRAFT_ALREADY_CONFIRMED', '草案已按其他方式提交');
        if (!draft.confirmedTaskId || (start && !draft.confirmedRunId))
            throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        return { taskId: draft.confirmedTaskId, runId: draft.confirmedRunId };
    }
    const key = createHash('sha256')
        .update(`project-draft:${draft.id}:${draft.revision}`)
        .digest('hex');
    const result = await tasks.createInProject(
        userId,
        projectId,
        { config: draft.config },
        key,
        start,
        tx,
    );
    const taskId = result.detail.task.id;
    await store.confirmDraft(draft.id, taskId, result.runId, start);
    if (result.runId) {
        await tx.insert(projectThreadRunOrigins).values({
            userId,
            projectId,
            threadId,
            runId: result.runId,
            draftId: draft.id,
            draftRevision: draft.revision,
        });
    }
    return { taskId, runId: result.runId, result };
}
