/** Plain JSON object guard for untrusted model and checkpoint data. */
export const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
