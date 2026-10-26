import { Type, type Static } from "@sinclair/typebox";
import {
  describeProperties,
  InstantSchema,
  ModeSchema,
  PageQuerySchema,
  pageSchema,
  RunStatusSchema,
  UuidSchema,
} from "./common.ts";

export const NotificationKindSchema = Type.Union(
  [Type.Literal("summary"), Type.Literal("important_change"), Type.Literal("run_issue")],
  { description: "完整汇总、已确认重要变化或不完整/失败的运行问题" },
);
export const NotificationSchema = Type.Object(
  {
    id: UuidSchema,
    runId: UuidSchema,
    taskId: UuidSchema,
    reportId: Type.Union([UuidSchema, Type.Null()], { description: "关联报告；失败时可为空" }),
    kind: NotificationKindSchema,
    readAt: Type.Union([InstantSchema, Type.Null()], { description: "首次已读时间；未读为空" }),
    createdAt: InstantSchema,
    runStatus: RunStatusSchema,
    mode: ModeSchema,
    failureCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: "执行的脱敏失败分类；无失败为空",
    }),
  },
  { additionalProperties: false, description: "当前账号的站内通知，独立于报告收件箱" },
);
export const NotificationListQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
    kind: Type.Optional(NotificationKindSchema),
    unread: Type.Optional(Type.Boolean({ description: "只看未读或已读；省略返回全部" })),
  },
  { additionalProperties: false, description: "通知分页与种类/已读筛选" },
);
export const NotificationListResponseSchema = pageSchema(NotificationSchema);
export const NotificationPatchInputSchema = Type.Object(
  { read: Type.Boolean({ description: "标为已读或恢复未读，不改变收件箱状态" }) },
  { additionalProperties: false, description: "修改通知已读状态" },
);
for (const schema of [
  NotificationSchema,
  NotificationListQuerySchema,
  NotificationPatchInputSchema,
])
  describeProperties(schema);
export type Notification = Static<typeof NotificationSchema>;
export type NotificationListQuery = Static<typeof NotificationListQuerySchema>;
export type NotificationPatchInput = Static<typeof NotificationPatchInputSchema>;
