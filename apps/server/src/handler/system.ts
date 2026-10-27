export function health() {
    return {
        status: 'ok' as const,
        runtime: typeof Bun === 'undefined' ? ('node' as const) : ('bun' as const),
    };
}
