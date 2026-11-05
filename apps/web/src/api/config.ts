/** Only VITE_ settings are public; backend credentials never enter the browser bundle. */
export function resolveApiBaseUrl(value: string | undefined): string {
    const base = value?.trim() || '/api/v1';
    if (/[\\\s]/.test(base)) throw new Error('VITE_API_BASE_URL 地址格式不正确');
    const url = new URL(base, 'https://scova.invalid');
    if (
        (!base.startsWith('/') && !/^https?:\/\//.test(base)) ||
        base.startsWith('//') ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/(?:[^/]+\/)*api\/v1\/?$/.test(url.pathname)
    )
        throw new Error('VITE_API_BASE_URL 应为 /api/v1 或以 /api/v1 结尾的 HTTP(S) 地址');
    return base.replace(/\/$/, '');
}

export const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
export const apiCredentials = 'include' as const;
export const apiUrl = (path: string) => `${apiBaseUrl}${path}`;
