/** 从真实路由生成 JSON；调用者使用自己的 OpenAPI 类型缩小 unknown。 */
export function generateOpenApi(): Promise<unknown>;
/** 运行文档契约校验；失败抛出 Error。 */
export function validateOpenApi(spec: unknown): unknown;
