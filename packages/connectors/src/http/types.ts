import { type ReadDiagnostic } from '../types.ts';
import { type ResolvedAddress } from './address.ts';

export interface HttpResponse {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface HttpOptions {
    /** Trusted guard immediately before dispatch, after any origin queue wait. */
    beforeDispatch?: () => Promise<void>;
    onReadDiagnostic?: (event: ReadDiagnostic) => void;
    responseEncoding?: 'web-text';
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
}

export interface TransportOptions {
    /** Only Reader enables this; a progressing body keeps the unchanged overall deadline. */
    bodyIdleTimeoutMs?: number;
    responseEncoding?: 'web-text';
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    maxBytes: number;
    address: ResolvedAddress;
    /** Trusted transport callback; only response headers end the IP connection budget. */
    onResponseStarted?: () => void;
}

/** A privileged injection point: production callers should use the default pinned transport. */
export type HttpTransport = (
    url: URL,
    options: TransportOptions,
) => Promise<Omit<HttpResponse, 'url'>>;

export interface SafeHttpClient {
    request(url: string, options?: HttpOptions): Promise<HttpResponse>;
}
