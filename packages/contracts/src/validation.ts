import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import { Value, type ValueError } from "@sinclair/typebox/value";
import { RefinementBase, type ApiError, type FieldError } from "./common.ts";

export class ContractValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly fieldErrors: FieldError[];
  constructor(fieldErrors: FieldError[]) {
    super("请求字段不符合接口契约");
    this.fieldErrors = fieldErrors;
    this.name = "ContractValidationError";
  }
  toResponse(requestId: string): ApiError {
    return { code: this.code, message: this.message, requestId, fieldErrors: this.fieldErrors };
  }
}

/** 对输入执行与 Elysia 相同的 TypeBox 格式、类型及跨字段校验，不隐式修剪或丢弃未知字段。 */
export function parseContract<S extends TSchema>(schema: S, input: unknown): Static<S> {
  if (Value.Check(schema, input)) return input as Static<S>;
  const expand = (error: ValueError): ValueError[] => {
    const base = (error.schema as TSchema & { [RefinementBase]?: TSchema })[RefinementBase];
    if (base && !Value.Check(base, error.value)) {
      return [...Value.Errors(base, error.value)].flatMap((inner) =>
        expand({ ...inner, path: `${error.path}${inner.path}` }),
      );
    }
    return error.errors.length
      ? error.errors.flatMap((branch) => [...branch].flatMap(expand))
      : [error];
  };
  const errors = [...Value.Errors(schema, input)].flatMap(expand).map((error): FieldError => {
    const kind = error.schema[Kind];
    const path = error.path || "/";
    if (kind === "ScovaFixedTimeRange")
      return {
        path: `${error.path}/end`,
        message: "固定时间范围结束时间不能早于开始时间，且时间格式必须有效",
      };
    if (kind === "ScovaClaim")
      return { path: `${error.path}/evidenceIds`, message: "事实型结论必须至少引用一条有效证据" };
    if (kind === "ScovaChange")
      return { path, message: "变化必须包含双方值与证据；新增资料不得伪造旧值" };
    if (kind === "ScovaReport") return { path, message: "报告的完整性、结论和证据引用必须一致" };
    if (kind === "ScovaRun")
      return { path, message: "执行状态与查阅完整性必须一致，基线和无重要变化仅允许完整成功执行" };
    return { path, message: `${error.schema.description ?? "字段"}不符合接口约束` };
  });
  throw new ContractValidationError(errors);
}

export function revisionEtag(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("修订版本必须为正安全整数");
  return `"${revision}"`;
}
export function parseRevisionEtag(value: string): number {
  if (!/^"[1-9][0-9]*"$/.test(value))
    throw new ContractValidationError([
      { path: "/if-match", message: "If-Match 必须是带双引号的正整数修订版本" },
    ]);
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision))
    throw new ContractValidationError([{ path: "/if-match", message: "修订版本超出安全整数范围" }]);
  return revision;
}
