import { Prisma } from "@scova/models";
import type { ApiServices } from "@/app/context.ts";

/** 绑定当前事务的任务持久化操作；不包含 HTTP、认证或产品决策。 */
export function createTaskStore(database: Prisma.TransactionClient) {
  return {
    findTask(taskId: string, userId: string) {
      return database.task.findFirst({ where: { id: taskId, userId } });
    },
    findVersion(versionId: string, userId: string, taskId: string) {
      return database.taskVersion.findFirst({ where: { id: versionId, userId, taskId } });
    },
    requireVersion(versionId: string, userId: string, taskId: string) {
      return database.taskVersion.findFirstOrThrow({ where: { id: versionId, userId, taskId } });
    },
    listTasks(userId: string, take: number, cursor?: { updatedAt: Date; id: string }) {
      return database.task.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take,
      });
    },
    createTask(data: Prisma.TaskUncheckedCreateInput) {
      return database.task.create({ data });
    },
    createVersion(data: Prisma.TaskVersionUncheckedCreateInput) {
      return database.taskVersion.create({ data });
    },
    setCurrentVersion(taskId: string, versionId: string) {
      return database.task.update({
        where: { id: taskId },
        data: { currentVersionId: versionId },
        include: { currentVersion: true },
      });
    },
    claimRevision(
      taskId: string,
      userId: string,
      revision: number,
      data: Prisma.TaskUpdateManyMutationInput,
    ) {
      return database.task.updateMany({ where: { id: taskId, userId, revision }, data });
    },
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;

/** 惰性取得连接，事务回调只能使用绑定该事务的 store。 */
export function createTaskRepo(services: Pick<ApiServices, "db">) {
  return {
    findTask: (...args: Parameters<TaskStore["findTask"]>) =>
      createTaskStore(services.db()).findTask(...args),
    findVersion: (...args: Parameters<TaskStore["findVersion"]>) =>
      createTaskStore(services.db()).findVersion(...args),
    listTasks: (...args: Parameters<TaskStore["listTasks"]>) =>
      createTaskStore(services.db()).listTasks(...args),
    transaction<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
      return services.db().$transaction((database) => work(createTaskStore(database)));
    },
    isUniqueConflict(error: unknown) {
      return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
    },
  };
}
