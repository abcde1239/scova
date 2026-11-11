import { selectedOutputFormats, type TaskConfig, type OutputFormat } from '@scova/models';

// Collection objectives belong in planning, before search and source selection.
const objectives: Record<OutputFormat, { collect: string; write: string }> = {
    brief: {
        collect:
            'Find the decisive answer, important numbers, eligibility conditions, and material developments. Prioritize sources that change the answer; do not consume the research budget on generic background.',
        write: 'Lead with the core answer, then the essential findings and justified next actions or unresolved items. Synthesize in Chinese in your own words and combine complementary evidence from the same source. At most 8 claims, 320 Unicode characters per claim and 1600 in total. Include qualifications within that limit; do not retell pages in order or add actions the user did not request.',
    },
    list: {
        collect:
            'Identify the distinct objects or topics requested. Collect each name, requested attributes, relevant dates, eligibility, and usable source links. Cover different entries before collecting duplicates; track genuinely missing requested fields.',
        write: 'Make each claim one identifiable object or topic. Start with its name, then the requested fields, conditions, and citations. Deduplicate the same object and group related entries. Use Chinese prose and explicitly mark a missing requested field as 未知. Do not substitute generic research chapters for a usable list or fabricate entries to reach a count.',
    },
    comparison: {
        collect:
            'Identify the actual comparison objects and shared dimensions. Collect comparable values, units, periods, pricing bases, conditions, strengths, and limitations for every side. Seek missing sides rather than only the best-documented object. If no objects were specified, compare source positions on the question; do not invent products, scores, or rankings.',
        write: 'Use one shared comparison dimension per claim. Explicitly name each actual object and give its evidence, then explain the supported difference in Chinese. Preserve units, dates, conditions, and asymmetric evidence. Unknown is not zero or a disadvantage. Do not rank incomparable measures or replace comparison with a generic summary. Do not confuse comparing products with changes between historical runs.',
    },
    research_report: {
        collect:
            'Build an evidence chain around the core questions: definitions and scope, primary evidence, methods or sample conditions, supporting and opposing accounts, necessary context, and limitations. Prefer primary studies or direct documentation where relevant. Respect collection-only tasks: do not expand them into unrequested causal claims or predictions.',
        write: 'Develop coherent Chinese argument paragraphs organized by the research questions: findings, evidence and explanation, applicability, then material disagreement and limitations. Begin each paragraph with its specific point and develop it with connected evidence; combine complementary same-source material and separate sourced statements from your deductions. Depth should come from explanation and scope, not padded background or more short fragments. Do not relabel a brief as a research report. Use complete paragraphs within the existing claims schema; do not invent chapter fields.',
    },
};

export function outputInstructions(config: TaskConfig, stage: 'collect' | 'write') {
    const formats = selectedOutputFormats(config);
    return `\n# Selected deliverables\nGenerate exactly these formats: ${JSON.stringify(formats)}.\n${formats.map((format) => `${format}: ${objectives[format][stage]}`).join('\n')}${formats.length > 1 ? (stage === 'collect' ? '\nCombine queries and sources across the selected formats within the shared budget. Avoid duplicate reads while covering the collection objectives of every selected format.' : '\nOrganize each selected format separately and set each claim.outputFormat to its owning format. A verbatim citation may be shared, but do not copy the same claims word for word into multiple artifacts. Each selected format must have content; where evidence is unavailable, use a specific insufficient claim within that format. Never add an unselected format.') : ''}\n`;
}
