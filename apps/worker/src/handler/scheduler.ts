import type { SchedulerService } from "@/service/scheduler.ts";

export function createSchedulerHandler(
  service: Pick<SchedulerService, "scheduleOnce">,
  batchSize: number,
) {
  return (signal: AbortSignal) => service.scheduleOnce(batchSize, signal);
}
