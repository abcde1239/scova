/** 仅为前端展示输入，不是 API DTO，也不表示媒体已获生产授权。 */
export interface SourceImageInput {
    src: string;
    alt: string;
    attribution: string;
    concept?: boolean;
}

export function displayImage(input?: SourceImageInput): SourceImageInput | undefined {
    if (
        !input ||
        !input.alt.trim() ||
        !input.attribution.trim() ||
        !input.src.startsWith('/') ||
        input.src.startsWith('//') ||
        input.src.includes('\\') ||
        Array.from(input.src).some((character) => character.charCodeAt(0) <= 32)
    )
        return undefined;
    return input;
}
