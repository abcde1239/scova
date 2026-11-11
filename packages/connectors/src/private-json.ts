/** Keep JavaScript Unicode line separators inside one private JSONL frame. */
export function privateJsonLine(value: unknown): string {
    return `${JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) =>
        character === '\u2028' ? '\\u2028' : '\\u2029',
    )}\n`;
}
