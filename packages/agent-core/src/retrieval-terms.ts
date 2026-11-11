// Discovery vocabulary only: these aliases never generate claims or establish support.
// Keep concepts independent of particular libraries, API answers, or source passages.
const concepts: readonly [RegExp, readonly string[]][] = [
    [/异步|\basync(?:hronous(?:ly)?)?\b/i, ['async', 'asynchronous', 'asynchronously']],
    [/(?<!异)同步|\bsync(?:hronous(?:ly)?)?\b/i, ['sync', 'synchronous', 'synchronously']],
    [/回调|\bcallbacks?\b/i, ['callback', 'callbacks']],
    [/创建|\b(?:create[ds]?|creation)\b/i, ['create', 'created', 'creation']],
    [/绑定|\b(?:bind|bound|binding)\b/i, ['bind', 'bound', 'binding']],
    [/卸载|\bunmount(?:ed|s)?\b/i, ['unmount', 'unmounted', 'unmounts']],
    [/组件|\bcomponents?\b/i, ['component', 'components']],
    [/手动|\bmanual(?:ly)?\b/i, ['manual', 'manually']],
    [/自动|\bautomatic(?:ally)?\b/i, ['automatic', 'automatically']],
    [/停止|\bstop(?:ped|ping)?\b/i, ['stop', 'stopped', 'stopping']],
    [/取消/, ['cancel', 'cancelled', 'abort', 'aborted']],
    [/清理/, ['cleanup', 'clean', 'dispose']],
    [/执行/, ['execute', 'execution', 'executed']],
    [/注册/, ['register', 'registered', 'registration']],
    [/之前|以前/, ['before']],
    [/之后|以后/, ['after']],
    [/方法|方式|如何/, ['method', 'use', 'call', 'invoke']],
    [/返回/, ['return', 'returns', 'returned']],
    [/句柄/, ['handle']],
    [/默认/, ['default']],
    [/参数/, ['parameter', 'parameters', 'argument', 'arguments']],
    [/版本/, ['version']],
    [/超时/, ['timeout']],
    [/资源/, ['resource', 'resources']],
    [/订阅/, ['subscription', 'subscriptions']],
];

export function bilingualRetrievalTerms(text: string): string[] {
    return [
        ...new Set(concepts.flatMap(([pattern, aliases]) => (pattern.test(text) ? aliases : []))),
    ];
}

export function retrievalTermMatcher(term: string): (text: string) => boolean {
    if (!/^[a-z_][a-z0-9_.]*$/i.test(term)) return (text) => text.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, 'i');
    return (text) => pattern.test(text);
}
