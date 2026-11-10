export type ImageStorageErrorCode =
    | 'invalid_config'
    | 'invalid_key'
    | 'invalid_image'
    | 'image_too_large'
    | 'invalid_expiry'
    | 'storage_closed'
    | 'request_aborted'
    | 'storage_request_failed';

/** Contains fixed messages only; never retains upstream messages, credentials or signed URLs. */
export class ImageStorageError extends Error {
    constructor(
        public readonly code: ImageStorageErrorCode,
        message: string,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'ImageStorageError';
    }
}
