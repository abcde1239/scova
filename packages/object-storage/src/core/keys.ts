import { randomUUID } from 'node:crypto';
import { ObjectStorageError } from './errors.ts';
import { validateKey } from './validation.ts';

export function uploadKey(prefix: string, key?: string): string {
    const relative = validateKey(key ?? randomUUID());
    return validateKey(prefix ? `${prefix}/${relative}` : relative);
}

/** Purpose is extensible; every component must be a single object-key segment. */
export function createStorageKey(input: {
    purpose: string;
    ownerId: string;
    objectId: string;
    extension?: string;
}): string {
    const segment = (value: string) => {
        validateKey(value);
        if (value.includes('/'))
            throw new ObjectStorageError('invalid_key', 'Invalid key segment.');
        return value;
    };
    if (input.extension !== undefined && !/^[a-zA-Z0-9]+$/.test(input.extension)) {
        throw new ObjectStorageError('invalid_key', 'Invalid file extension.');
    }
    const filename = segment(input.objectId) + (input.extension ? `.${input.extension}` : '');
    return validateKey(`${segment(input.purpose)}/${segment(input.ownerId)}/${filename}`);
}
