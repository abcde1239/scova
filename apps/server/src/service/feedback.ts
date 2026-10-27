import { FeedbackInputSchema, FeedbackSchema, parseContract } from '@scova/models';
import type { Feedback as StoredFeedback } from '@scova/db';
import type { ApiServices } from '@/app/context.ts';
import { createFeedbackRepo } from '@/repo/feedback.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid } from '@/utils/security.ts';
const missing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
const dto = (row: StoredFeedback) =>
    parseContract(FeedbackSchema, {
        id: row.id,
        taskId: row.taskId,
        sourceId: row.sourceId,
        claimId: row.claimId,
        kind: row.kind,
        active: row.active,
        updatedAt: row.updatedAt.toISOString(),
    });

export function createFeedbackService(services: ApiServices) {
    const repo = createFeedbackRepo(services);
    return {
        async list(userId: string, taskId: string) {
            if (!isUuid(taskId) || !(await repo.task(userId, taskId))) throw missing();
            return { items: (await repo.list(userId, taskId)).map(dto) };
        },
        async set(userId: string, body: unknown) {
            const input = parseContract(FeedbackInputSchema, body);
            return repo.transaction(async (store) => {
                if (
                    !(await store.lockTask(userId, input.taskId)).length ||
                    !(await store.target(userId, input))
                )
                    throw missing();
                const existing = await store.existing(userId, input);
                if (existing?.active && existing.kind === input.kind) return dto(existing);
                if (!existing?.active && (await store.count(userId, input.taskId)) >= 200)
                    throw new ApiError(
                        409,
                        'FEEDBACK_LIMIT',
                        '最多同时生效200条反馈，请先撤销已有反馈',
                    );
                return dto(
                    existing
                        ? await store.update(existing.id, { kind: input.kind, active: true })
                        : await store.create(userId, input),
                );
            });
        },
        async revoke(userId: string, id: string) {
            if (!isUuid(id)) throw missing();
            const existing = await repo.find(userId, id);
            if (!existing) throw missing();
            return repo.transaction(async (store) => {
                if (!(await store.lockTask(userId, existing.taskId)).length) throw missing();
                const row = await store.find(userId, id);
                if (!row) throw missing();
                return dto(row.active ? await store.update(id, { active: false }) : row);
            });
        },
    };
}
