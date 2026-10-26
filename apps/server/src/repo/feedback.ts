import { Prisma } from "@scova/models";
import type { ApiServices } from "@/app/context.ts";
import type { FeedbackInput } from "@scova/contracts";

function store(tx: Prisma.TransactionClient) {
  return {
    lockTask(userId: string, taskId: string) {
      return tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM tasks WHERE id=${taskId}::uuid AND user_id=${userId}::uuid FOR NO KEY UPDATE`;
    },
    find(userId: string, id: string) {
      return tx.feedback.findFirst({ where: { id, userId } });
    },
    target(userId: string, input: FeedbackInput) {
      return input.sourceId
        ? tx.source.findFirst({
            where: {
              id: input.sourceId,
              userId,
              observations: { some: { userId, run: { taskId: input.taskId, userId } } },
            },
            select: { id: true },
          })
        : tx.claim.findFirst({
            where: { id: input.claimId, userId, taskId: input.taskId },
            select: { id: true },
          });
    },
    existing(userId: string, input: FeedbackInput) {
      return tx.feedback.findFirst({
        where: {
          userId,
          taskId: input.taskId,
          sourceId: input.sourceId ?? null,
          claimId: input.claimId ?? null,
        },
      });
    },
    count(userId: string, taskId: string) {
      return tx.feedback.count({ where: { userId, taskId, active: true } });
    },
    create(userId: string, input: FeedbackInput) {
      return tx.feedback.create({
        data: {
          userId,
          taskId: input.taskId,
          sourceId: input.sourceId ?? null,
          claimId: input.claimId ?? null,
          kind: input.kind,
        },
      });
    },
    update(id: string, data: Prisma.FeedbackUpdateInput) {
      return tx.feedback.update({ where: { id }, data });
    },
  };
}
export function createFeedbackRepo(services: Pick<ApiServices, "db">) {
  return {
    find(userId: string, id: string) {
      return services.db().feedback.findFirst({ where: { id, userId } });
    },
    task(userId: string, id: string) {
      return services.db().task.findFirst({ where: { id, userId }, select: { id: true } });
    },
    list(userId: string, taskId: string) {
      return services.db().feedback.findMany({
        where: { userId, taskId, active: true },
        orderBy: { id: "asc" },
        take: 200,
      });
    },
    transaction<T>(work: (value: ReturnType<typeof store>) => Promise<T>) {
      return services.db().$transaction((tx) => work(store(tx)));
    },
  };
}
