import type { Prisma, Run } from "@scova/models";
import { terminalNotificationKind } from "@/utils/notifications.ts";

/** Only the fixed version is read. Broken preferences suppress notifications without blocking failure persistence. */
export async function createTerminalNotifications(
  tx: Prisma.TransactionClient,
  run: Run,
  terminal: { status: "succeeded" | "partial" | "failed"; outcome?: string; reportId?: string },
) {
  const version = await tx.taskVersion.findFirst({
    where: { id: run.taskVersionId, userId: run.userId, taskId: run.taskId },
    select: { configJson: true },
  });
  const config = version?.configJson;
  const preference =
    config && typeof config === "object" && !Array.isArray(config)
      ? config.notificationPreference
      : undefined;
  const kind = terminalNotificationKind(preference, terminal);
  if (!kind) return;
  await tx.notification.upsert({
    where: { userId_runId_kind: { userId: run.userId, runId: run.id, kind } },
    create: { userId: run.userId, runId: run.id, kind, reportId: terminal.reportId ?? null },
    update: {},
  });
}
