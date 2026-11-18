import { pageIsLoading } from './readiness.ts';
import { pageHasPendingData } from './data-readiness.ts';
import { ConnectorError, type PageCollection } from '../../types.ts';

const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const auxiliary = 'nav,header,footer,aside,form,[role="navigation"],[hidden],[aria-hidden="true"]';

/** Inspect the requested content, rather than letting menus/legal text hide a gate. */
export function checkPageQuality(
    document: Document,
    originalMarkup: string,
): PageCollection['limitations'] {
    const title = compact(document.title);
    const main = document.querySelector('main,[role="main"]') ?? document.body;
    const text = compact(main?.textContent ?? '');
    const articleBodies = [
        ...(main?.querySelectorAll('article,[itemprop="articleBody"]') ?? []),
    ].filter((node) => !node.closest(auxiliary));
    const hasArticle = articleBodies.some((node) => compact(node.textContent ?? '').length >= 80);
    const challengeMarkup =
        /TencentCaptcha|\/WafCaptcha\b|cf-chl-|challenge-platform|cf-turnstile|g-recaptcha|h-captcha/i.test(
            originalMarkup,
        );
    const challengeTitle =
        /^(?:just a moment|attention required|security (?:check|verification)|安全(?:检测|验证)|访问验证|人机验证)[.!…\s]*(?:\|\s*cloudflare)?$/i.test(
            title,
        );
    const challengeText =
        /^(?:安全(?:检测|验证)中|请(?:完成|通过)(?:安全|人机)?验证|验证您(?:是|为)真人|checking (?:your )?browser|verify (?:that )?you are human|performing security verification)[\s.!。…]*$/i.test(
            text,
        );
    if (challengeText || (!hasArticle && challengeTitle) || (text.length < 120 && challengeMarkup))
        throw new ConnectorError('http', '来源要求安全验证，未取得正文', false, 403);
    if (
        /^(?:access denied|403 forbidden|访问被拒绝|拒绝访问)$/i.test(title) ||
        /^(?:access denied|forbidden|403(?: forbidden)?|permission denied|拒绝访问|访问被拒绝)[\s.!。:：…]*$/i.test(
            text,
        )
    )
        throw new ConnectorError('http', '来源拒绝公开访问，未取得正文', false, 403);
    if (
        /^(?:404(?: not found)?|page not found|页面不存在)$/i.test(title) ||
        /^(?:404(?: not found)?|not found|page not found|页面不存在|网页不存在|您访问的页面不存在)[\s.!。…]*$/i.test(
            text,
        )
    )
        throw new ConnectorError('http', '来源页面不存在，未取得正文', false, 404);
    const password = !!main?.querySelector('input[type="password"]');
    const loginTitle = /^(?:login|log in|sign in|登录|用户登录|会员登录)$/i.test(title);
    const loginOnly =
        /^(?:登录后(?:查看|阅读|访问)|请先登录|请登录后(?:查看|阅读|访问)|sign in to (?:continue|read)|log in to (?:continue|read))[\s.!。…]*$/i.test(
            text,
        );
    if (loginOnly || (password && loginTitle))
        throw new ConnectorError('http', '来源要求登录，未取得公开正文', false, 403);

    const limitations: PageCollection['limitations'] = [];
    const visualText = [...(main?.querySelectorAll('svg') ?? [])].some(
        (node) =>
            !node.closest(auxiliary) &&
            !/(?:^|[\s_-])(?:icon|logo)(?:$|[\s_-])/i.test(
                [
                    node.getAttribute('class'),
                    node.getAttribute('id'),
                    node.getAttribute('aria-label'),
                ]
                    .filter(Boolean)
                    .join(' '),
            ) &&
            [...node.querySelectorAll('text,tspan')].some((label) =>
                compact(label.textContent ?? ''),
            ) &&
            !!node.querySelector('path,line,polyline,polygon'),
    );
    if (visualText) limitations.push('visual_structure');
    const gate = document.querySelector(
        '.paywall,.subscription-wall,[data-testid="paywall"],[data-component="paywall"]',
    );
    const gateText = compact(gate?.textContent ?? '');
    const restriction =
        /(?:preview of subscription content|access via your institution|subscribe to (?:continue|read)|subscription (?:is )?required|订阅后(?:阅读|查看)|订阅后阅读全文|付费后(?:阅读|查看)|登录后阅读全文)/i;
    const restrictedHeading = [...(main?.querySelectorAll('h1,h2,[role="heading"]') ?? [])].some(
        (node) => restriction.test(compact(node.textContent ?? '')),
    );
    const publicPreview = /(?:preview of subscription content|access via your institution)/i.test(
        text,
    );
    if ((gate && restriction.test(gateText)) || restrictedHeading || publicPreview) {
        // A public abstract outside the gate remains useful, but its extent is
        // explicit. A long subscription sales pitch is not article evidence.
        const outside = [
            ...document.querySelectorAll(
                'article p,[itemprop="articleBody"] p,section[data-title="Abstract"] p,[id="abstract"] p,[role="doc-abstract"] p',
            ),
        ]
            .filter(
                (node) =>
                    !node.closest(auxiliary) &&
                    !node.closest(
                        '.paywall,.subscription-wall,[data-testid="paywall"],[data-component="paywall"]',
                    ),
            )
            .map((node) => compact(node.textContent ?? ''))
            .filter((value) => value.length >= 80 && !restriction.test(value));
        if (!outside.length)
            throw new ConnectorError('http', '来源要求订阅或登录，未取得公开正文', false, 403);
        limitations.push('content_restricted');
    }
    const refresh = [...document.querySelectorAll('meta[http-equiv]')].some(
        (node) => node.getAttribute('http-equiv')?.toLowerCase() === 'refresh',
    );
    if (refresh && !hasArticle)
        throw new ConnectorError('invalid_response', '来源仅提供跳转提示，未取得正文');
    let loading: boolean;
    try {
        loading = pageIsLoading(document, /<script\b/i.test(originalMarkup));
    } catch (error) {
        if (error instanceof Error && error.message === '网页节点数超过提取限制')
            throw new ConnectorError('extraction_failed', '网页节点数超过提取限制');
        throw error;
    }
    if (loading) throw new ConnectorError('extraction_failed', '页面主正文仍在加载');
    const pendingChart = [...(main?.querySelectorAll('.spinning,[aria-busy="true"]') ?? [])].some(
        (node) =>
            !node.closest(auxiliary) &&
            (/(?:chart|graph|visualization)/i.test(node.getAttribute('class') ?? '') ||
                node.getAttribute('role') === 'img'),
    );
    if (pendingChart || pageHasPendingData(document)) limitations.push('render_timeout');
    // rel=next also identifies independent chapters and listing pages. A
    // continuation must explicitly concern the article being collected.
    const nextPage =
        hasArticle &&
        [...document.querySelectorAll('a[rel~="next"]')].some((node) =>
            /(?:下一页|下页|next\s+page|continue\s+reading)/i.test(compact(node.textContent ?? '')),
        );
    const pendingText =
        /(?:正文尚待滚动加载|scroll to (?:load|continue reading))/i.test(text) ||
        [...(main?.querySelectorAll('button,a,[role="button"]') ?? [])].some((node) =>
            /^(?:展开全文|阅读全文后续|加载更多正文)\s*[.…]*$/i.test(
                compact(node.textContent ?? ''),
            ),
        );
    if (nextPage || pendingText) limitations.push('interaction_required');
    return limitations;
}
