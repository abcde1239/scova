import type { FieldError } from '@scova/models';
/** 可公开的错误，不把数据库消息、请求体或凭据拼接进响应。 */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly fieldErrors?: FieldError[];
    retryAfterSeconds?: number;
    constructor(status: number, code: string, message: string, fieldErrors?: FieldError[]) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.fieldErrors = fieldErrors;
    }
}
