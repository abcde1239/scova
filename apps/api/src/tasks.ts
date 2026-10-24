import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  Prisma,
  type Task as StoredTask,
  type TaskVersion as StoredTaskVersion,
} from "@prisma/client";
import { Elysia, t } from "elysia";
import {
  CreateTaskInputSchema,
  ApiErrorSchema,
  PageQuerySchema,
  RevisionHeadersSchema,
  TaskDetailResponseSchema,
  TaskListResponseSchema,
  TaskConfigSchema,
  TaskSchema,
  TaskVersionSchema,
  UpdateTaskInputSchema,
  parseContract,
  parseRevisionEtag,
  revisionEtag,
  type TaskConfig,
} from "@scova/contracts";
import type { ApiServices } from "./services.ts";
import { ApiError } from "./errors.ts";
import { requireCsrf, requireSession, type AuthenticatedSession } from "./auth.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** 检索与正文提取策略升级时递增，避免错误复用旧比较范围。 */
const RETRIEVAL_STRATEGY_VERSION = 1;
const EXTRACTION_STRATEGY_VERSION = "readability-v1";
const DEFAULT_BUDGET_LIMITS = { maxSearches: 10, maxPages: 20, maxDurationSeconds: 300 } as const;
const OptionalRevisionHeadersSchema = t.Object(
  {
    "if-match": t.Optional(
      t.String({ pattern: '^"[1-9][0-9]*"$', description: '编辑时提交读取到的 ETag，例如 "3"' }),
    ),
  },
  { additionalProperties: true, description: "编辑任务时的乐观锁请求头；缺失时返回 428" },
);

function assertBudget(config: TaskConfig): void {
  const fieldErrors = Object.entries(DEFAULT_BUDGET_LIMITS)
    .filter(([key, maximum]) => config.budget[key as keyof typeof DEFAULT_BUDGET_LIMITS]! > maximum)
    .map(([key, maximum]) => ({
      path: `/config/budget/${key}`,
      message: `部署默认上限为 ${maximum}`,
    }));
  if (fieldErrors.length)
    throw new ApiError(422, "BUDGET_EXCEEDED", "任务预算超过部署默认上限", fieldErrors);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** 语义范围不包含标题、计划时点、展示格式和提醒偏好，避免无关编辑重置基线。 */
export function comparisonScopeHash(config: TaskConfig): string {
  const scope = {
    retrievalStrategyVersion: RETRIEVAL_STRATEGY_VERSION,
    extractionStrategyVersion: EXTRACTION_STRATEGY_VERSION,
    topic: config.topic,
    goal: config.goal,
    focusPoints: config.focusPoints,
    exclusions: config.exclusions,
    sourcePreferences: config.sourcePreferences,
    timeRange: config.timeRange,
  };
  return hash(JSON.stringify(stable(scope)));
}

export function nextRunAt(config: TaskConfig, now: Date): Date | null {
  if (config.schedule.frequency === "manual") return null;
  const current = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(config.timezone);
  const [hour, minute] = config.schedule.localTime.split(":").map(Number);
  let candidate = current.with({
    hour,
    minute,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
  if (config.schedule.frequency === "daily") {
    if (Temporal.ZonedDateTime.compare(candidate, current) <= 0)
      candidate = candidate.add({ days: 1 });
  } else {
    const days = (config.schedule.weekday - current.dayOfWeek + 7) % 7;
    candidate = candidate.add({ days });
    if (Temporal.ZonedDateTime.compare(candidate, current) <= 0)
      candidate = candidate.add({ days: 7 });
  }
  return new Date(Number(candidate.toInstant().epochMilliseconds));
}

function taskResponse(
  task: StoredTask,
  version: StoredTaskVersion,
  baselineResetRequired: boolean,
) {
  const dto = {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      revision: task.revision,
      currentVersionId: task.currentVersionId!,
      nextRunAt: task.nextRunAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
    version: {
      id: version.id,
      taskId: version.taskId,
      version: version.version,
      configSchemaVersion: version.configSchemaVersion as 1,
      config: version.configJson,
      comparisonScopeHash: version.comparisonScopeHash,
      createdAt: version.createdAt.toISOString(),
    },
    baselineResetRequired,
  };
  return parseContract(TaskDetailResponseSchema, dto);
}

function listItem(task: StoredTask) {
  return parseContract(TaskSchema, {
    id: task.id,
    title: task.title,
    status: task.status,
    revision: task.revision,
    currentVersionId: task.currentVersionId!,
    nextRunAt: task.nextRunAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  });
}

type Database = Prisma.TransactionClient | ReturnType<ApiServices["db"]>;

async function ownedTask(
  taskId: string,
  session: AuthenticatedSession,
  services: ApiServices,
  database: Database = services.db(),
) {
  if (!UUID.test(taskId)) throw new ApiError(404, "NOT_FOUND", "资源不存在");
  const task = await database.task.findFirst({ where: { id: taskId, userId: session.userId } });
  if (!task) throw new ApiError(404, "NOT_FOUND", "资源不存在");
  return task;
}

function cursorFor(task: StoredTask): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: task.updatedAt.toISOString(), id: task.id }),
    "utf8",
  ).toString("base64url");
}
function decodeCursor(value: string | undefined): { updatedAt: Date; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      updatedAt?: string;
      id?: string;
    };
    if (!parsed.updatedAt || !parsed.id || !UUID.test(parsed.id)) throw new Error();
    const updatedAt = new Date(parsed.updatedAt);
    if (!Number.isFinite(updatedAt.getTime())) throw new Error();
    return { updatedAt, id: parsed.id };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "分页游标无效");
  }
}

export function createTaskPlugin(services: ApiServices) {
  const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    409: ApiErrorSchema,
    412: ApiErrorSchema,
    422: ApiErrorSchema,
  } as const;
  return new Elysia({ name: "scova-tasks", prefix: "/api/v1", normalize: false })
    .model({
      CreateTaskInput: CreateTaskInputSchema,
      UpdateTaskInput: UpdateTaskInputSchema,
      PageQuery: PageQuerySchema,
      RevisionHeaders: RevisionHeadersSchema,
      Task: TaskSchema,
      TaskVersion: TaskVersionSchema,
      TaskDetailResponse: TaskDetailResponseSchema,
      TaskListResponse: TaskListResponseSchema,
    })
    .get(
      "/tasks",
      async ({ query, request }) => {
        const session = await requireSession(request, services);
        const page = parseContract(PageQuerySchema, query);
        const cursor = decodeCursor(page.cursor);
        const take = Math.min(page.limit ?? 50, 100);
        const tasks = await services.db().task.findMany({
          where: {
            userId: session.userId,
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
          take: take + 1,
        });
        const hasNext = tasks.length > take;
        const items = tasks.slice(0, take).map(listItem);
        return parseContract(TaskListResponseSchema, {
          items,
          nextCursor: hasNext ? cursorFor(tasks[take - 1]!) : null,
        });
      },
      {
        query: "PageQuery",
        response: { 200: TaskListResponseSchema, ...errors },
        detail: {
          operationId: "listTasks",
          tags: ["任务"],
          summary: "查看任务列表",
          description: "按更新时间倒序返回当前账号拥有的长期查阅任务，使用不透明游标分页。",
        },
      },
    )
    .post(
      "/tasks",
      async ({ body, request, set }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        const input = parseContract(CreateTaskInputSchema, body);
        assertBudget(input.config);
        const scopeHash = comparisonScopeHash(input.config);
        const next = nextRunAt(input.config, services.clock());
        const result = await services.db().$transaction(async (database) => {
          const task = await database.task.create({
            data: { userId: session.userId, title: input.config.title, nextRunAt: next },
          });
          const version = await database.taskVersion.create({
            data: {
              userId: session.userId,
              taskId: task.id,
              version: 1,
              inputText: input.inputText,
              configSchemaVersion: 1,
              configJson: input.config,
              comparisonScopeHash: scopeHash,
            },
          });
          const updated = await database.task.update({
            where: { id: task.id },
            data: { currentVersionId: version.id },
            include: { currentVersion: true },
          });
          return { task: updated, version };
        });
        set.status = 201;
        set.headers.etag = revisionEtag(result.task.revision);
        return taskResponse(result.task, result.version, false);
      },
      {
        body: "CreateTaskInput",
        response: { 201: TaskDetailResponseSchema, ...errors },
        detail: {
          operationId: "createTask",
          tags: ["任务"],
          summary: "创建查阅任务",
          description:
            "保存用户确认的配置并创建不可变版本；自然语言解析失败时由调用方提交手工配置。",
        },
      },
    )
    .get(
      "/tasks/:taskId",
      async ({ params, request, set }) => {
        const session = await requireSession(request, services);
        const task = await ownedTask(params.taskId, session, services);
        const version = await services.db().taskVersion.findFirst({
          where: { id: task.currentVersionId!, userId: session.userId, taskId: task.id },
        });
        if (!version) throw new ApiError(500, "TASK_VERSION_MISSING", "任务配置版本不可用");
        set.headers.etag = revisionEtag(task.revision);
        return taskResponse(task, version, false);
      },
      {
        response: { 200: TaskDetailResponseSchema, ...errors },
        detail: {
          operationId: "getTask",
          tags: ["任务"],
          summary: "查看任务详情",
          description: "返回当前账号的任务摘要及不可变配置版本；不存在或跨账号资源统一返回404。",
        },
      },
    )
    .patch(
      "/tasks/:taskId",
      async ({ params, body, request, set }) => {
        const session = await requireSession(request, services);
        requireCsrf(request, session, services);
        const ifMatch = request.headers.get("if-match");
        if (!ifMatch)
          throw new ApiError(428, "REVISION_REQUIRED", "编辑任务必须携带 If-Match 修订版本");
        const expectedRevision = parseRevisionEtag(ifMatch);
        const input = parseContract(UpdateTaskInputSchema, body);
        assertBudget(input.config);
        const result = await services
          .db()
          .$transaction(async (database) => {
            const task = await ownedTask(params.taskId, session, services, database);
            if (task.revision !== expectedRevision)
              throw new ApiError(409, "REVISION_CONFLICT", "任务已被其他请求修改，请刷新后重试");
            const previous = await database.taskVersion.findFirstOrThrow({
              where: { id: task.currentVersionId!, userId: session.userId, taskId: task.id },
            });
            const previousConfig = parseContract(TaskConfigSchema, previous.configJson);
            const scheduleChanged =
              previousConfig.timezone !== input.config.timezone ||
              JSON.stringify(stable(previousConfig.schedule)) !==
                JSON.stringify(stable(input.config.schedule));
            const scopeHash = comparisonScopeHash(input.config);
            // 先以 revision 作为条件原子占位，避免两个并发编辑都从同一版本创建 version=2。
            const claimed = await database.task.updateMany({
              where: { id: task.id, userId: session.userId, revision: expectedRevision },
              data: {
                title: input.config.title,
                revision: { increment: 1 },
                nextRunAt: nextRunAt(input.config, services.clock()),
                ...(scheduleChanged ? { scheduleRevision: { increment: 1 } } : {}),
              },
            });
            if (claimed.count !== 1)
              throw new ApiError(409, "REVISION_CONFLICT", "任务已被其他请求修改，请刷新后重试");
            const version = await database.taskVersion.create({
              data: {
                userId: session.userId,
                taskId: task.id,
                version: previous.version + 1,
                // 未提供 inputText 时沿用上个版本，避免普通配置编辑意外清空来源文本。
                inputText: input.inputText ?? previous.inputText,
                configSchemaVersion: 1,
                configJson: input.config,
                comparisonScopeHash: scopeHash,
              },
            });
            const updated = await database.task.update({
              where: { id: task.id },
              data: { currentVersionId: version.id },
              include: { currentVersion: true },
            });
            return {
              task: updated,
              version,
              baselineResetRequired: previous.comparisonScopeHash !== scopeHash,
            };
          })
          .catch((error: unknown) => {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
              throw new ApiError(409, "REVISION_CONFLICT", "任务已被其他请求修改，请刷新后重试");
            throw error;
          });
        set.headers.etag = revisionEtag(result.task.revision);
        return taskResponse(result.task, result.version, result.baselineResetRequired);
      },
      {
        body: "UpdateTaskInput",
        headers: OptionalRevisionHeadersSchema,
        response: { 200: TaskDetailResponseSchema, ...errors, 428: ApiErrorSchema },
        detail: {
          operationId: "updateTask",
          tags: ["任务"],
          summary: "编辑任务并创建新版本",
          description:
            "使用 If-Match 乐观锁保存不可变配置版本；标题、计划、展示格式和提醒修改不会重置比较范围，语义范围变化会明确提示新基线。",
        },
      },
    );
}
