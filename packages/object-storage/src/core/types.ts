export interface StoragePolicy {
    /** Defaults to 50 MiB at the root; children may only lower this limit. */
    maxSizeBytes?: number;
    /** Exact MIME types. Omitted at the root allows all valid MIME types. */
    allowedContentTypes?: readonly string[];
}

interface BaseConfig extends StoragePolicy {
    bucket: string;
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    /** Public bucket/custom domain URL, optionally including a path prefix. */
    publicBaseUrl?: string;
    /** Namespace applied to generated and caller-supplied keys. */
    keyPrefix?: string;
}

export type ObjectStorageConfig = BaseConfig &
    (
        | { provider: 'r2'; accountId: string; jurisdiction?: 'eu' | 'fedramp' }
        | { provider: 's3'; region: string; endpoint?: string; forcePathStyle?: boolean }
    );

export interface RequestOptions {
    signal?: AbortSignal;
}

export interface UploadFileInput extends RequestOptions {
    body: Uint8Array;
    /** Omit to generate a UUID filename. Relative to keyPrefix. Existing keys are overwritten. */
    key?: string;
    /** Explicit MIME type; content validation belongs to the consuming application. */
    contentType: string;
    cacheControl?: string;
}

export interface StoredObject {
    /** Full object key, including keyPrefix; pass this key to head/delete/sign methods. */
    key: string;
    url: string | null;
    contentType: string;
    size: number;
    etag?: string;
}

export interface ObjectMetadata {
    key: string;
    url: string | null;
    contentType?: string;
    size?: number;
    etag?: string;
    lastModified?: Date;
}

export interface PresignUploadInput {
    contentType: string;
    size: number;
    key?: string;
    /** 1–3600 seconds, defaults to 900. */
    expiresIn?: number;
}

export interface PresignedUpload {
    key: string;
    url: string;
    publicUrl: string | null;
    method: 'PUT';
    headers: { 'Content-Type': string };
    /** Exact body length included in the signature. */
    size: number;
    expiresIn: number;
}

export interface ObjectDownload {
    body: ReadableStream<Uint8Array>;
    size: number | undefined;
}

export interface ObjectStorageScope {
    /** Child directory, relative to this scope. Policies can only be tightened. */
    scope(directory: string, policy?: StoragePolicy): ObjectStorageScope;
    upload(input: UploadFileInput): Promise<StoredObject>;
    download(key: string, options?: RequestOptions): Promise<ObjectDownload>;
    /** Returns null only when the object is absent; permission/network errors throw. */
    head(key: string, options?: RequestOptions): Promise<ObjectMetadata | null>;
    /** S3 deletion is idempotent; missing objects also succeed. */
    delete(key: string, options?: RequestOptions): Promise<void>;
    getPublicUrl(key: string): string | null;
    presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;
    presignDownload(key: string, options?: { expiresIn?: number }): Promise<string>;
}

export interface ObjectStorage extends ObjectStorageScope {
    /** Only the root owns the client; closing it invalidates all child scopes. */
    destroy(): void;
}
