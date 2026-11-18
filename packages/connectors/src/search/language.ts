import { ConnectorError } from '../types.ts';

export const SEARCH_LANGUAGES = [
    'en',
    'zh',
    'ja',
    'ko',
    'de',
    'fr',
    'es',
    'pt',
    'ru',
    'ar',
    'it',
] as const;
export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];
export interface SearchOptions {
    /** Discovery language, independent of the report language; never an engine override. */
    language?: SearchLanguage;
}
export const isSearchLanguage = (value: unknown): value is SearchLanguage =>
    typeof value === 'string' && SEARCH_LANGUAGES.some((language) => language === value);

export function searchLanguage(options: SearchOptions): SearchLanguage | undefined {
    if (options.language !== undefined && !isSearchLanguage(options.language))
        throw new ConnectorError('configuration', '搜索语言不受支持');
    return options.language;
}
