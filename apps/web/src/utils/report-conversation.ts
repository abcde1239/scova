import type { Report, QuestionAnswer, Evidence } from '@scova/models';
import { sourceLink } from '@/composables/useReport';

/** Group by saved webpage, retaining every distinct exact quote and its answer paragraphs. */
export function conversationSources(answer: QuestionAnswer | null, report: Report) {
    const groups = new Map<
        string,
        {
            url: string;
            link?: string;
            title: string;
            host: string;
            evidence: Evidence[];
            citations: { quote: string; statements: number[] }[];
        }
    >();
    answer?.statements.forEach((statement, index) => {
        for (const citation of statement.citations) {
            const evidence = report.evidence.find(
                (item) => item.id.toLowerCase() === citation.evidenceId.toLowerCase(),
            );
            if (!evidence) continue;
            const url = evidence.url;
            let group = groups.get(url);
            if (!group) {
                const link = sourceLink(url);
                group = {
                    url,
                    link,
                    title: evidence.title,
                    host: link ? new URL(link).hostname : '保存来源',
                    evidence: [],
                    citations: [],
                };
                groups.set(url, group);
            }
            if (!group.evidence.some((item) => item.id === evidence.id))
                group.evidence.push(evidence);
            const saved = group.citations.find((item) => item.quote === citation.quote);
            if (saved) {
                if (!saved.statements.includes(index + 1)) saved.statements.push(index + 1);
            } else group.citations.push({ quote: citation.quote, statements: [index + 1] });
        }
    });
    return [...groups.values()];
}

/** Suggestions use saved content only. Choosing one fills the composer without a model call. */
export function conversationSuggestions(report: Report): string[] {
    const subject = (report.claims[0]?.text || report.title).replace(/\s+/g, ' ').slice(0, 70);
    return [
        `请解释“${subject}”的主要依据。`,
        report.limitations[0]
            ? `“${report.limitations[0].slice(0, 70)}”会如何影响结论？`
            : '这份报告的结论适用于哪些情况？',
        report.claims.length > 1
            ? `“${report.claims[1]!.text.slice(0, 70)}”与主要发现有什么联系？`
            : `请用三点概括《${report.title.slice(0, 70)}》中最值得关注的内容。`,
    ];
}
