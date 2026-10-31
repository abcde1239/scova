import {
    ApiErrorSchema,
    ContractValidationError,
    parseContract,
    type FieldError,
} from '@scova/models';
import {
    classifyError,
    CommunicationError,
    type ErrorKind,
    type TransportResponse,
} from 'requestlane';

export class ApiRequestError extends Error {
    readonly kind: ErrorKind;
    readonly status?: number;
    readonly code: string;
    readonly requestId?: string;
    readonly fieldErrors?: FieldError[];
    readonly retryable: boolean;

    constructor(error: unknown, response?: TransportResponse) {
        const info = classifyError(error);
        const contractError =
            error instanceof ContractValidationError
                ? error
                : error instanceof Error && error.cause instanceof ContractValidationError
                  ? error.cause
                  : undefined;
        let body;
        try {
            body = parseContract(ApiErrorSchema, response?.data);
        } catch {
            // 非标准错误体不作为可信契约，仍保留 HTTP 状态和追踪头。
        }
        super(body?.message ?? contractError?.message ?? info.message, { cause: error });
        this.name = info.kind === 'cancelled' ? 'AbortError' : 'ApiRequestError';
        this.kind = contractError ? 'validation' : info.kind;
        this.status = response?.status ?? info.status;
        this.code = body?.code ?? contractError?.code ?? info.kind.toUpperCase();
        this.requestId = body?.requestId ?? response?.headers['x-request-id'];
        this.fieldErrors = body?.fieldErrors ?? contractError?.fieldErrors;
        this.retryable = info.retryable;
    }
}

export function toApiError(error: unknown, response?: TransportResponse): ApiRequestError {
    if (error instanceof ApiRequestError) return error;
    const httpResponse = error instanceof CommunicationError ? error.response : undefined;
    return new ApiRequestError(error, response ?? httpResponse);
}
