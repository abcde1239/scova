/** Display projection only: keep different sources and different limitations intact. */
export function uniqueCoverageNotes(values: string[]): string[] {
    return [...new Set(values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}
