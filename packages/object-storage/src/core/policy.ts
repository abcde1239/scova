import { ObjectStorageError } from './errors.ts';
import type { StoragePolicy } from './types.ts';

export interface ResolvedPolicy {
    maxSizeBytes: number;
    allowedContentTypes?: readonly string[];
}

function validMime(value: string): boolean {
    return typeof value === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value);
}

export function resolvePolicy(input: StoragePolicy): ResolvedPolicy {
    const maxSizeBytes = input.maxSizeBytes ?? 50 * 1024 * 1024;
    if (
        !Number.isSafeInteger(maxSizeBytes) ||
        maxSizeBytes <= 0 ||
        (input.allowedContentTypes !== undefined &&
            (!Array.isArray(input.allowedContentTypes) ||
                !input.allowedContentTypes.every(validMime)))
    )
        throw new ObjectStorageError('invalid_config', 'Invalid storage policy.');
    return {
        maxSizeBytes,
        allowedContentTypes:
            input.allowedContentTypes === undefined ? undefined : [...input.allowedContentTypes],
    };
}

export function tightenPolicy(parent: ResolvedPolicy, child: StoragePolicy): ResolvedPolicy {
    const policy = resolvePolicy({ ...parent, ...child });
    if (
        policy.maxSizeBytes > parent.maxSizeBytes ||
        (parent.allowedContentTypes !== undefined &&
            (policy.allowedContentTypes === undefined ||
                policy.allowedContentTypes.some(
                    (type) => !parent.allowedContentTypes!.includes(type),
                )))
    ) {
        throw new ObjectStorageError('invalid_config', 'Child policy must not widen its parent.');
    }
    return policy;
}

export function validateFile(size: number, contentType: string, policy: ResolvedPolicy): void {
    if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !validMime(contentType) ||
        (policy.allowedContentTypes !== undefined &&
            !policy.allowedContentTypes.includes(contentType))
    ) {
        throw new ObjectStorageError('invalid_file', 'Invalid file size or content type.');
    }
    if (size > policy.maxSizeBytes) {
        throw new ObjectStorageError('file_too_large', 'File exceeds the configured size limit.');
    }
}
