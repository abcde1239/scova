import { parseContract } from '@scova/models';
import type { Validator } from 'requestlane';

type ModelSchema = Parameters<typeof parseContract>[0];

export function modelValidator<S extends ModelSchema>(schema: S) {
    return {
        parse: (value: unknown) => parseContract(schema, value),
    } satisfies Validator<ReturnType<typeof parseContract<S>>>;
}

export const voidValidator: Validator<void> = {
    parse(value) {
        if (value !== undefined) throw new TypeError('预期无响应体');
    },
};
