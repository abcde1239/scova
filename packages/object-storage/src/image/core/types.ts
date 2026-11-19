export type ImageContentType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

interface BaseConfig {
    bucket: string;
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    /** Public bucket/custom domain URL, optionally including a path prefix. */
    publicBaseUrl?: string;
    /** Namespace applied to generated and caller-supplied keys. */
    keyPrefix?: string;
    /** Defaults to 10 MiB. Applied before upload and when issuing upload URLs. */
    maxSizeBytes?: number;
}

export type ImageStorageConfig = BaseConfig &
    (
        | { provider: 'r2'; accountId: string; jurisdiction?: 'eu' | 'fedramp' }
        | { provider: 's3'; region: string; endpoint?: string; forcePathStyle?: boolean }
    );

export interface RequestOptions {
    signal?: AbortSignal;
}

export interface UploadImageInput extends RequestOptions {
    body: Uint8Array;
    /** Omit to generate a UUID filename. Relative to keyPrefix. Existing keys are overwritten. */
    key?: string;
    /** If provided, must agree with the detected file signature. */
    contentType?: ImageContentType;
    cacheControl?: string;
}

export interface StoredImage {
    /** Full object key, including keyPrefix; pass this key to head/delete/sign methods. */
    key: string;
    url: string | null;
    contentType: ImageContentType;
    size: number;
    etag?: string;
}

export interface ImageMetadata {
    key: string;
    url: string | null;
    contentType?: string;
    size?: number;
    etag?: string;
    lastModified?: Date;
}

export interface PresignUploadInput {
    contentType: ImageContentType;
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
    headers: { 'Content-Type': ImageContentType };
    /** Exact body length included in the signature. */
    size: number;
    expiresIn: number;
}

export interface ImageStorageClient {
    upload(input: UploadImageInput): Promise<StoredImage>;
    /** Returns null only when the object is absent; permission/network errors throw. */
    head(key: string, options?: RequestOptions): Promise<ImageMetadata | null>;
    /** S3 deletion is idempotent; missing objects also succeed. */
    delete(key: string, options?: RequestOptions): Promise<void>;
    getPublicUrl(key: string): string | null;
    presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;
    presignDownload(key: string, options?: { expiresIn?: number }): Promise<string>;
}

export interface ImageStorage extends ImageStorageClient {
    destroy(): void;
}
