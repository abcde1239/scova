import { t } from "elysia";
import {
  ApiErrorSchema,
  RegisterInputSchema,
  LoginInputSchema,
  SessionResponseSchema,
  UserSchema,
  PreferencesSchema,
  UpdatePreferencesInputSchema,
  TaskConfigSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  TaskSchema,
  TaskVersionSchema,
  RunSchema,
  RunCommandResponseSchema,
  RunCommandInputSchema,
  ReportSchema,
  RunEventSchema,
  TaskDetailResponseSchema,
  TaskListResponseSchema,
} from "@scova/contracts";
/** 系统健康检查返回值；只代表进程存活，不宣称数据库、队列或 Agent 已就绪。 */
export const HealthResponseSchema = t.Object(
  {
    status: t.Literal("ok", { description: "API 进程正常响应" }),
    runtime: t.Union([t.Literal("bun"), t.Literal("node")], {
      description: "当前主运行时或兼容运行时",
    }),
  },
  { additionalProperties: false, description: "进程健康状态" },
);

export const contractModels = {
  ApiError: ApiErrorSchema,
  RegisterInput: RegisterInputSchema,
  LoginInput: LoginInputSchema,
  SessionResponse: SessionResponseSchema,
  User: UserSchema,
  Preferences: PreferencesSchema,
  UpdatePreferencesInput: UpdatePreferencesInputSchema,
  TaskConfig: TaskConfigSchema,
  CreateTaskInput: CreateTaskInputSchema,
  UpdateTaskInput: UpdateTaskInputSchema,
  Task: TaskSchema,
  TaskVersion: TaskVersionSchema,
  TaskDetailResponse: TaskDetailResponseSchema,
  TaskListResponse: TaskListResponseSchema,
  Run: RunSchema,
  RunCommandResponse: RunCommandResponseSchema,
  RunCommandInput: RunCommandInputSchema,
  Report: ReportSchema,
  RunEvent: RunEventSchema,
};
