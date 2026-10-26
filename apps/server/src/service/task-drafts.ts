import {
  ContractValidationError,
  NotificationPreferenceSchema,
  TaskDraftInputSchema,
  TaskDraftResponseSchema,
  parseContract,
  type TaskDraftResponse,
} from "@scova/contracts";
import {
  ConnectorError,
  estimateModelInputTokens,
  withDeadline,
  type StructuredInput,
} from "@scova/connectors";
import type { ApiServices } from "@/app/context.ts";
import type { AuthenticatedSession } from "@/service/auth.ts";
import { createTaskDraftRepo, type DraftReservation } from "@/repo/task-drafts.ts";
import {
  draftModelSchema,
  draftPrompt,
  manualDraft,
  normalizeDraft,
  resolveDraftTimezone,
} from "@/utils/task-drafts.ts";
import { ApiError } from "@/utils/errors.ts";

type Reason = NonNullable<TaskDraftResponse["manualReason"]>;
const reasons: Record<Reason, string> = {
  model_unavailable: "当前未配置可用模型，请手工编辑并确认配置。",
  ambiguous_timezone: "原始描述包含不同明确时区，请手工确认时区与计划。",
  invalid_output: "模型输出未通过配置校验，请根据保留的原始描述手工编辑。",
  timeout: "草稿解析超时，请手工编辑；未安排任何执行。",
  aborted: "草稿解析已取消，原始描述已保留。",
  budget_exceeded: "独立草稿解析预算已用尽，请手工编辑。",
  model_failed: "模型暂时无法解析，请手工编辑；供应商内部信息不会返回。",
};
function failureReason(error: unknown): Reason {
  if (error instanceof ContractValidationError) return "invalid_output";
  if (error instanceof ConnectorError) {
    if (["invalid_response", "extraction_failed"].includes(error.code)) return "invalid_output";
    if (["timeout", "aborted", "budget_exceeded"].includes(error.code)) return error.code as Reason;
  }
  return "model_failed";
}

/** 仅生成待确认草稿；唯一持久化是独立Redis解析限流与预算预留。 */
export function createTaskDraftService(services: ApiServices) {
  const repository = createTaskDraftRepo(services);
  return {
    async create(
      session: Pick<AuthenticatedSession, "userId" | "user">,
      body: unknown,
      requestSignal?: AbortSignal,
    ) {
      const input = parseContract(TaskDraftInputSchema, body);
      if (Buffer.byteLength(input.inputText, "utf8") > 8000)
        throw new ContractValidationError([
          { path: "/inputText", message: "原始描述不得超过8000 UTF-8字节" },
        ]);
      const defaults = {
        timezone: session.user.defaultTimezone,
        notificationPreference: parseContract(
          NotificationPreferenceSchema,
          session.user.notificationPreference,
        ),
      };
      const fallback = manualDraft(input, defaults);
      const resolvedTimezone = resolveDraftTimezone(input, defaults.timezone);
      const policy = services.taskDraftPolicy;
      const ledger: { inputTokens: number; outputTokens: number; estimated: boolean }[] = [];
      const pendingWrites = new Set<Promise<unknown>>();
      const writeErrors: unknown[] = [];
      const write = <T>(operation: Promise<T>) => {
        pendingWrites.add(operation);
        void operation.then(
          () => pendingWrites.delete(operation),
          (error: unknown) => {
            writeErrors.push(error);
            pendingWrites.delete(operation);
          },
        );
        return operation;
      };
      const usage = () => ({
        attempts: ledger.length,
        inputTokens: ledger.reduce((total, entry) => total + entry.inputTokens, 0),
        outputTokens: ledger.reduce((total, entry) => total + entry.outputTokens, 0),
        estimated: ledger.some((entry) => entry.estimated),
      });
      const manual = (reason: Reason) =>
        parseContract(TaskDraftResponseSchema, {
          inputText: input.inputText,
          config: fallback,
          mode: "manual",
          requiresConfirmation: true,
          manualReason: reason,
          warnings: [...resolvedTimezone.warnings, { path: "/config", message: reasons[reason] }],
          parsingUsage: usage(),
        });
      try {
        return await withDeadline(policy.timeoutMs, requestSignal, async (signal) => {
          const alive = () => {
            if (signal.aborted) throw signal.reason;
          };
          alive();
          const budget = await write(repository.begin(session.userId, signal));
          alive();
          if (resolvedTimezone.ambiguous) return manual("ambiguous_timezone");
          let model;
          try {
            model = services.taskDraftModel();
          } catch {
            return manual("model_unavailable");
          }
          if (!model) return manual("model_unavailable");
          let repairPaths: string[] = [];
          for (let call = 0; call < 2; call++) {
            alive();
            const currentUsage = usage();
            const outputTokens = Math.min(
              policy.outputTokensPerAttempt,
              policy.maxOutputTokens - currentUsage.outputTokens,
            );
            const modelInput: StructuredInput = {
              prompt:
                draftPrompt +
                (call
                  ? "\nRegenerate once, correcting invalid fields: " + repairPaths.join(", ")
                  : ""),
              schema: draftModelSchema,
              untrustedSources: [{ inputText: input.inputText, defaults: fallback }],
              maxInputTokens: policy.maxInputTokens - currentUsage.inputTokens,
              maxOutputTokens: outputTokens,
            };
            const reservedInput = estimateModelInputTokens(modelInput);
            if (outputTokens < 1 || reservedInput > modelInput.maxInputTokens)
              throw new ConnectorError("budget_exceeded", "草稿解析预算不足");
            // Reserve the complete conservative input, then require actual usage to stay inside it.
            modelInput.maxInputTokens = reservedInput;
            let reservation: DraftReservation | undefined;
            let entry: (typeof ledger)[number] | undefined;
            let started = false;
            try {
              const result = await model.generateStructured(modelInput, {
                signal,
                timeoutMs: policy.timeoutMs,
                beforeAttempt: async (kind) => {
                  alive();
                  if (kind !== "model" || started || ledger.length >= 2)
                    throw new ConnectorError("budget_exceeded", "草稿解析最多两次模型尝试");
                  started = true;
                  await write(
                    (async () => {
                      reservation = await budget.reserveAttempt(reservedInput, outputTokens);
                      entry = { inputTokens: reservedInput, outputTokens, estimated: true };
                      ledger.push(entry);
                    })(),
                  );
                  alive();
                },
              });
              alive();
              if (
                !reservation ||
                !entry ||
                result.mode !== "live" ||
                !result.usage ||
                ![result.usage.inputTokens, result.usage.outputTokens].every(
                  (value) => Number.isSafeInteger(value) && value >= 0,
                ) ||
                result.usage.inputTokens > reservedInput ||
                result.usage.outputTokens > outputTokens ||
                typeof result.usage.estimated !== "boolean"
              )
                throw new ConnectorError("invalid_response", "模型解析用量或模式无效");
              const settledEntry = entry;
              await write(
                (async () => {
                  await reservation!.settle(result.usage.inputTokens, result.usage.outputTokens);
                  Object.assign(settledEntry, result.usage);
                })(),
              );
              alive();
              const normalized = normalizeDraft(result.data, input, fallback);
              return parseContract(TaskDraftResponseSchema, {
                inputText: input.inputText,
                ...normalized,
                mode: "model",
                requiresConfirmation: true,
                manualReason: null,
                warnings: [
                  ...resolvedTimezone.warnings,
                  ...normalized.warnings,
                  ...(call
                    ? [{ path: "/config", message: "配置经过一次结构修复，请确认全部字段。" }]
                    : []),
                ],
                parsingUsage: usage(),
              });
            } catch (error) {
              if (error instanceof ApiError) throw error;
              alive();
              if (call === 0 && failureReason(error) === "invalid_output") {
                repairPaths =
                  error instanceof ContractValidationError
                    ? [...new Set(error.fieldErrors.map((field) => field.path))].slice(0, 20)
                    : ["/"];
                continue;
              }
              throw error;
            }
          }
          throw new ConnectorError("invalid_response", "模型配置无效");
        });
      } catch (error) {
        // Drain the short Redis writes so late reservations cannot disappear from reported usage.
        const writes = await Promise.allSettled(pendingWrites);
        if (error instanceof ApiError) throw error;
        for (const writeError of writeErrors) if (writeError instanceof ApiError) throw writeError;
        for (const result of writes)
          if (result.status === "rejected" && result.reason instanceof ApiError)
            throw result.reason;
        return manual(failureReason(error));
      }
    },
  };
}
