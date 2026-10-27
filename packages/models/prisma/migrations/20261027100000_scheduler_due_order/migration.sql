-- Prisma 6 cannot express a partial index. Match the stable scheduler scan order.
DROP INDEX "tasks_due_active";
CREATE INDEX "tasks_due_active" ON "tasks"("next_run_at", "id")
WHERE "status" = 'active' AND "next_run_at" IS NOT NULL;
