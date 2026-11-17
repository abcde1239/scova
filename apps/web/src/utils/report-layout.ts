/** Display-only sizing: saved answers, paragraph boundaries and provenance remain intact. */
export function readingExtent(text: string): number {
    let extent = 0;
    for (const character of text) {
        extent +=
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(
                character,
            )
                ? 1
                : 0.55;
    }
    return extent;
}

export function reportColumnWidth(texts: readonly string[]): number {
    const extent = Math.max(0, ...texts.map(readingExtent));
    return extent > 420 ? 26 : extent > 180 ? 22 : extent > 60 ? 18 : 14;
}

export function reportTableLayout(
    labels: readonly string[],
    columns: readonly (readonly string[])[],
) {
    const labelWidth = Math.min(
        12,
        Math.max(7, Math.ceil(Math.max(0, ...labels.map(readingExtent)) / 2) + 2),
    );
    const widths = columns.map(reportColumnWidth);
    return {
        labelWidth,
        widths,
        minWidth: labelWidth + widths.reduce((total, width) => total + width, 0),
    };
}

export function reportCardWidth(texts: readonly string[]): number {
    return Math.max(0, ...texts.map(readingExtent)) > 180 ? 30 : 20;
}
