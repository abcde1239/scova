import { HttpUrlSchema, parseContract } from '@scova/models';

export function sourceLink(value: string): string | undefined {
    try {
        return parseContract(HttpUrlSchema, value);
    } catch {
        return undefined;
    }
}
