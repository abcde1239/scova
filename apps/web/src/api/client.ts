import { IdempotencyHeadersSchema, RevisionHeadersSchema, parseContract } from '@scova/models';
import {
    cancelled,
    createClient,
    identityCodec,
    raceSignal,
    requestLifetime,
    ValidationError,
    type Endpoint,
    type EndpointData,
    type EndpointInput,
    type EndpointSpec,
    type TransportResponse,
    type Validator,
} from 'requestlane';
import { createFetchTransport, type Fetcher } from 'requestlane/fetch';
import { assertApiPath } from '@/api/endpoints';
import { toApiError } from '@/api/errors';
import { apiBaseUrl, apiCredentials } from '@/api/config';

export interface ApiRequestOptions {
    signal?: AbortSignal;
    timeout?: number;
    csrfToken?: string;
    /** 由调用方按用户动作创建；同一动作重发时必须复用。 */
    idempotencyKey?: string;
    /** 从读取响应取得的完整 ETag，不做去引号或数字转换。 */
    ifMatch?: string;
}

export interface ApiResponse<T> {
    data: T;
    status: number;
    headers: Readonly<Record<string, string>>;
    url: string;
}

export function createApi(options: { fetcher?: Fetcher } = {}) {
    const controller = new AbortController();
    const transport = createFetchTransport(options);
    const client = createClient({
        transport,
        baseURL: apiBaseUrl,
        credentials: apiCredentials,
        codec: identityCodec,
    });

    async function request<S extends EndpointSpec>(
        endpoint: Endpoint<S>,
        input: EndpointInput<S>,
        options: ApiRequestOptions = {},
    ): Promise<ApiResponse<EndpointData<S>>> {
        const lifetime = requestLifetime(
            {
                signal: AbortSignal.any([
                    controller.signal,
                    ...(options.signal ? [options.signal] : []),
                ]),
                timeout: options.timeout ?? endpoint.options.timeout,
            },
            15000,
        );
        let response: TransportResponse | undefined;
        try {
            return await raceSignal(
                (async () => {
                    lifetime.signal.throwIfAborted();
                    const spec = endpoint.options;
                    assertApiPath(spec.path);
                    if (!spec.validator) throw new TypeError('API 端点未声明响应校验器');
                    const headers: Record<string, string> = {};
                    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(spec.method);
                    if (writing && !spec.anonymous) {
                        if (!options.csrfToken) throw new TypeError('写请求需要 CSRF 校验值');
                        headers['x-csrf-token'] = options.csrfToken;
                    }
                    if (options.idempotencyKey !== undefined) {
                        parseContract(IdempotencyHeadersSchema, {
                            'idempotency-key': options.idempotencyKey,
                        });
                        headers['idempotency-key'] = options.idempotencyKey;
                    }
                    if (options.ifMatch !== undefined) {
                        parseContract(RevisionHeadersSchema, { 'if-match': options.ifMatch });
                        headers['if-match'] = options.ifMatch;
                    }
                    const validate = async <T>(
                        validator: Validator<T> | undefined,
                        value: unknown,
                        part: string,
                    ): Promise<T | undefined> => {
                        if (value !== undefined && !validator)
                            throw new TypeError(`API 端点未声明 ${part} 校验器`);
                        try {
                            return validator ? await validator.parse(value) : undefined;
                        } catch (error) {
                            throw new ValidationError(error);
                        }
                    };
                    const body = await validate(spec.inputValidators?.body, input.body, 'body');
                    const query = await validate(spec.inputValidators?.query, input.query, 'query');
                    const params = await validate(
                        spec.inputValidators?.params,
                        input.params,
                        'params',
                    );
                    lifetime.signal.throwIfAborted();
                    response = await client.requestRaw({
                        url: spec.path,
                        method: spec.method,
                        body,
                        query,
                        params,
                        querySerializer: spec.querySerializer,
                        headers,
                        signal: lifetime.signal,
                        timeout: options.timeout ?? spec.timeout,
                        credentials: apiCredentials,
                        responseType: 'json',
                        bypassCache: true,
                    });
                    let data: EndpointData<S>;
                    try {
                        data = await spec.validator.parse(response.data);
                    } catch (error) {
                        throw new ValidationError(error);
                    }
                    lifetime.signal.throwIfAborted();
                    return {
                        data,
                        status: response.status,
                        headers: response.headers,
                        url: response.url,
                    };
                })(),
                lifetime.signal,
            );
        } catch (error) {
            throw toApiError(
                lifetime.signal.aborted && !lifetime.timedOut
                    ? cancelled(lifetime.signal.reason)
                    : error,
                response,
            );
        } finally {
            lifetime.dispose();
        }
    }

    return {
        request,
        transport,
        dispose() {
            controller.abort();
            client.dispose();
        },
    };
}

export const api = createApi();
/** native 返回原始 Response；后续 SSE 桥接须显式设置 credentials 与 signal。 */
export const transport = api.transport;
