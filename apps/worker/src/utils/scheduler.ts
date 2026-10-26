/** 保留坏任务身份供本批跳过；错误详情不会写入用户可见日志。 */
export class SchedulerTaskError extends Error {
  constructor(
    readonly taskId: string,
    cause: unknown,
  ) {
    super("调度任务事务失败", { cause });
    this.name = "SchedulerTaskError";
  }
}
