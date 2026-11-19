import {
    BRAVE_SEARCH_PRESET,
    CustomSearchTemplateSchema,
    parseContract,
    type CustomSearchTemplate,
} from '@scova/models';

export interface SearchTemplateDraft {
    method: 'GET' | 'POST';
    authType: 'bearer' | 'header';
    headerName: string;
    requestJson: string;
    languageMapJson: string;
    resultsPath: string;
    urlPath: string;
    titlePath: string;
    snippetPath: string;
}

export const braveSearchEndpoint = BRAVE_SEARCH_PRESET.baseUrl;
export const braveSearchTemplate: CustomSearchTemplate = BRAVE_SEARCH_PRESET.custom;

export function searchTemplateDraft(template?: CustomSearchTemplate): SearchTemplateDraft {
    const value = template ?? braveSearchTemplate;
    return {
        method: value.method,
        authType: value.auth.type,
        headerName: value.auth.headerName ?? '',
        requestJson: JSON.stringify(value.request, null, 2),
        languageMapJson: JSON.stringify(value.languageMap ?? {}, null, 2),
        ...value.response,
    };
}

/** Parsing is static only: saving a template never sends a search or exposes a key. */
export function parseSearchTemplate(draft: SearchTemplateDraft): CustomSearchTemplate {
    let request: unknown;
    let languageMap: unknown;
    try {
        request = JSON.parse(draft.requestJson);
        languageMap = JSON.parse(draft.languageMapJson);
    } catch {
        throw new TypeError('请求参数与语言映射必须是有效的 JSON 对象。');
    }
    return parseContract(CustomSearchTemplateSchema, {
        method: draft.method,
        auth: {
            type: draft.authType,
            ...(draft.authType === 'header' ? { headerName: draft.headerName.trim() } : {}),
        },
        request,
        languageMap,
        response: {
            resultsPath: draft.resultsPath.trim(),
            urlPath: draft.urlPath.trim(),
            titlePath: draft.titlePath.trim(),
            snippetPath: draft.snippetPath.trim(),
        },
    });
}
