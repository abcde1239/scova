export type ObjectStorageErrorCode =
    | 'invalid_config'
    | 'invalid_key'
    | 'invalid_file'
    | 'file_too_large'
    | 'invalid_expiry'
    | 'storage_closed'
    | 'request_aborted'
    | 'storage_request_failed';

/** Contains fixed messages only; never retains upstream messages, credentials or signed URLs. */
export class ObjectStorageError extends Error {
    constructor(
        public readonly code: ObjectStorageErrorCode,
        message: string,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'ObjectStorageError';
    }
}
