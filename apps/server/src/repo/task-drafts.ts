import { randomUUID } from "node:crypto";
import { withDeadline } from "@scova/connectors";
import type { ApiServices } from "@/app/context.ts";
import { ApiError } from "@/utils/errors.ts";

const fields = ["requests", "attempts", "inputTokens", "outputTokens"] as const;
const reserveScript = [
  "local fields={'requests','attempts','inputTokens','outputTokens'}",
  "for k=1,2 do for i=1,4 do local n=tonumber(redis.call('HGET',KEYS[k],fields[i]) or '0')+tonumber(ARGV[i]); if n>tonumber(ARGV[4+(k-1)*4+i]) then return {0} end end end",
  "for k=1,2 do for i=1,4 do redis.call('HINCRBY',KEYS[k],fields[i],ARGV[i]) end; redis.call('EXPIRE',KEYS[k],ARGV[13]) end",
  "if tonumber(ARGV[2])>0 then redis.call('HSET',KEYS[3],'state','reserved','inputTokens',ARGV[3],'outputTokens',ARGV[4]); redis.call('EXPIRE',KEYS[3],ARGV[13]) end",
  "return {1}",
].join("\n");
const settleScript = [
  "if redis.call('HGET',KEYS[3],'state')~='reserved' then return {0} end",
  "local input=tonumber(redis.call('HGET',KEYS[3],'inputTokens')); local output=tonumber(redis.call('HGET',KEYS[3],'outputTokens'))",
  "if tonumber(ARGV[1])>input or tonumber(ARGV[2])>output then return {0} end",
  "for k=1,2 do if redis.call('EXISTS',KEYS[k])==0 then return {0} end end",
  "for k=1,2 do redis.call('HINCRBY',KEYS[k],'inputTokens',tonumber(ARGV[1])-input); redis.call('HINCRBY',KEYS[k],'outputTokens',tonumber(ARGV[2])-output) end",
  "redis.call('HSET',KEYS[3],'state','settled'); return {1}",
].join("\n");

export interface DraftReservation {
  inputTokens: number;
  outputTokens: number;
  settle(inputTokens: number, outputTokens: number): Promise<void>;
}

/** 只保存独立草稿限流和预算预留；不读写任何任务、执行或Outbox。 */
export function createTaskDraftRepo(
  services: Pick<ApiServices, "redis" | "clock" | "taskDraftPolicy">,
) {
  return {
    async begin(userId: string, signal?: AbortSignal) {
      const policy = services.taskDraftPolicy;
      const seconds = Math.floor(services.clock().getTime() / 1000);
      const window = Math.floor(seconds / policy.windowSeconds);
      const prefix = policy.keyPrefix + window + ":";
      const keys = [prefix + "user:" + userId, prefix + "global"];
      const remaining = policy.windowSeconds - (seconds % policy.windowSeconds);
      async function execute(script: string, reservationKey: string, args: number[]) {
        try {
          const result = await withDeadline(
            Math.min(policy.commandTimeoutMs, policy.timeoutMs),
            signal,
            async (commandSignal) => {
              const redis = services.redis();
              if (redis.status === "wait") await redis.connect();
              if (commandSignal.aborted) throw commandSignal.reason;
              const result = await redis.eval(script, 3, ...keys, reservationKey, ...args);
              if (commandSignal.aborted) throw commandSignal.reason;
              return result;
            },
          );
          if (!Array.isArray(result) || result.length !== 1 || ![0, 1].includes(Number(result[0])))
            throw new Error("草稿预算存储返回无效");
          return Number(result[0]) === 1;
        } catch {
          throw new ApiError(
            503,
            "DRAFT_SERVICE_UNAVAILABLE",
            "草稿解析服务暂时不可用，请稍后重试",
          );
        }
      }
      async function reserve(delta: number[]) {
        if (delta.length !== fields.length) throw new Error("草稿预留字段不完整");
        const reservationKey = prefix + "reservation:" + randomUUID();
        const ok = await execute(reserveScript, reservationKey, [
          ...delta,
          policy.userRequests,
          policy.userAttempts,
          policy.userInputTokens,
          policy.userOutputTokens,
          policy.globalRequests,
          policy.globalAttempts,
          policy.globalInputTokens,
          policy.globalOutputTokens,
          policy.windowSeconds + 30,
        ]);
        if (!ok) {
          const error = new ApiError(
            429,
            "DRAFT_RATE_LIMITED",
            "草稿解析过于频繁或解析额度已用尽，请稍后重试",
          );
          error.retryAfterSeconds = remaining;
          throw error;
        }
        return reservationKey;
      }
      await reserve([1, 0, 0, 0]);
      return {
        async reserveAttempt(inputTokens: number, outputTokens: number): Promise<DraftReservation> {
          const key = await reserve([0, 1, inputTokens, outputTokens]);
          return {
            inputTokens,
            outputTokens,
            async settle(actualInput, actualOutput) {
              if (
                ![actualInput, actualOutput].every(
                  (value) => Number.isSafeInteger(value) && value >= 0,
                ) ||
                actualInput > inputTokens ||
                actualOutput > outputTokens
              )
                throw new Error("草稿结算超过预算预留");
              if (!(await execute(settleScript, key, [actualInput, actualOutput])))
                throw new ApiError(
                  503,
                  "DRAFT_SERVICE_UNAVAILABLE",
                  "草稿解析预算无法结算，请稍后重试",
                );
            },
          };
        },
      };
    },
  };
}
