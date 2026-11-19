import type { AgentClaim } from '../../types.ts';

/** A display-text repair must stay with the explicitly linked object's own evidence. */
export function mentionsObject(name: string, claim: AgentClaim): boolean {
    if (!name.trim()) return true;
    // Permit the grammatical insertion in “回调中创建”, without dropping scope or version.
    const normalize = (text: string) =>
        text
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/中(?=创建|建立|注册|启动|生成|定义)/g, '');
    const label = normalize(name);
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /[a-z0-9_]/;
    const pattern = new RegExp(
        `${boundary.test(label[0]!) ? '(?<![a-z0-9_])' : ''}${escaped}${boundary.test(label.at(-1)!) ? '(?![a-z0-9_])' : ''}`,
    );
    return [
        claim.text,
        claim.assessment?.conditions ?? '',
        ...claim.citations.map((c) => c.quote),
    ].some((fragment) => pattern.test(normalize(fragment)));
}
