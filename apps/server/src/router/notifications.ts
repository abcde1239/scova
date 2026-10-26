import { Elysia, t } from "elysia";
import {
  ApiErrorSchema,
  NotificationSchema,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  NotificationPatchInputSchema,
} from "@scova/contracts";
import type { ApiServices } from "@/app/context.ts";
import { createNotificationHandlers } from "@/handler/notifications.ts";

export function createNotificationPlugin(services: ApiServices) {
  const handlers = createNotificationHandlers(services);
  const errors = {
    400: ApiErrorSchema,
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    422: ApiErrorSchema,
  };
  return new Elysia({ name: "scova-notifications", prefix: "/api/v1", normalize: false })
    .model({
      Notification: NotificationSchema,
      NotificationListResponse: NotificationListResponseSchema,
    })
    .get("/notifications", handlers.list, {
      query: t.Object(
        {
          ...NotificationListQuerySchema.properties,
          limit: t.Optional(
            t.Numeric({
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "每页条数，默认50，上限100",
            }),
          ),
          unread: t.Optional(t.BooleanString({ description: "只读未读或已读，省略返回全部" })),
        },
        { additionalProperties: false, description: "通知分页及筛选" },
      ),
      response: { 200: NotificationListResponseSchema, ...errors },
      detail: {
        operationId: "listNotifications",
        tags: ["通知"],
        summary: "读取站内通知",
        description: "按稳定游标读取当前账号的通知；失败通知可无报告，关闭通知不会删除收件箱成果。",
      },
    })
    .patch("/notifications/:notificationId", handlers.patch, {
      body: NotificationPatchInputSchema,
      response: { 200: NotificationSchema, ...errors },
      detail: {
        operationId: "updateNotificationRead",
        tags: ["通知"],
        summary: "修改通知已读状态",
        description:
          "使用会话和CSRF修改当前账号通知，重复已读保留首次时间，与报告收件箱的已读状态独立。",
      },
    });
}
