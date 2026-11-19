import type { AgentContext } from '../types.ts';
import { allowed, safeUrl, within } from '../research/state.ts';

// Frozen discovery hints for searchDirectionPolicy 3. No homepage is a read target or evidence.
const directory = [
    {
        site: 'eur-lex.europa.eu',
        region: 'European Union',
        use: 'EU law and official publications (multilingual)',
        topic: /欧盟|\bEU\b|European Union|EUR-Lex/i,
    },
    {
        site: 'legislation.gov.uk',
        region: 'United Kingdom',
        use: 'UK legislation; not a source for other jurisdictions',
        topic: /英国|\b(?:UK|United Kingdom)\b/i,
    },
    {
        site: 'govinfo.gov',
        region: 'United States',
        use: 'US federal laws and government publications; not state law',
        topic: /美国|\bUnited States\b|\bU\.S\.|\b(?:USC|CFR|GovInfo)\b/i,
    },
    {
        site: 'laws-lois.justice.gc.ca',
        region: 'Canada',
        use: 'Canadian federal legislation (English and French); not provincial law',
        topic: /加拿大|\bCanad(?:a|ian|ien(?:ne)?)\b/i,
    },
    {
        site: 'laws.e-gov.go.jp',
        region: 'Japan',
        use: 'Japanese legislation; preserve the Japanese statute name when known',
        topic: /日本|\bJapan(?:ese)?\b/i,
    },
    {
        site: 'pubmed.ncbi.nlm.nih.gov',
        use: 'Biomedical literature index; follow the original publication',
        topic: /医学|临床|公共卫生|生物医学|\b(?:medical|biomedical|clinical|PubMed)\b/i,
    },
    {
        site: 'search.crossref.org',
        use: 'Scholarly DOI and publication metadata; not article findings',
        topic: /论文|学术|文献|\b(?:DOI|Crossref|journal|papers?)\b/i,
    },
    {
        site: 'developer.mozilla.org',
        use: 'Web platform documentation; check the primary specification when needed',
        topic: /浏览器|网页|\b(?:DOM|HTML|CSS|browser|web API|JavaScript)\b/i,
    },
    {
        site: 'wikipedia.org',
        use: 'Multilingual background and reference links; not primary evidence',
    },
    { site: 'wikidata.org', use: 'Entity identifiers, aliases and references; not verification' },
];

export function sourceDirectoryHints(context: AgentContext, subject: string) {
    if (context.config.sourcePreferences.officialOnly) return [];
    return directory
        .filter(
            ({ site, topic }) =>
                (!topic || topic.test(subject)) && searchSiteAllowed(context, site),
        )
        .slice(0, 4)
        .map(({ site, region, use }) => ({ site, region, use }));
}

/** Hint filtering only; actual search results still pass the Reader's URL rules. */
export function searchSiteAllowed(context: AgentContext, site: string) {
    const https = `https://${site}`;
    const http = `http://${site}`;
    const url = safeUrl(https);
    return (
        !!url &&
        (allowed(context, https) || allowed(context, http)) &&
        !context.config.sourcePreferences.excludedUrls.some((excluded) => {
            const base = safeUrl(excluded);
            // Do not suggest an edition/subdomain of an excluded directory either.
            return (
                within(https, excluded) ||
                within(http, excluded) ||
                !!(base?.pathname === '/' && url.hostname.endsWith(`.${base.hostname}`))
            );
        })
    );
}
