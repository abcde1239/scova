import { selectedOutputFormats, type TaskConfig, type OutputFormat } from '@scova/models';

// Collection objectives belong in planning, before search and source selection.
const objectives: Record<OutputFormat, { collect: string; write: string }> = {
    brief: {
        collect:
            'Find the decisive answer, important numbers with units and the date or version they apply to, eligibility conditions, and material developments. Prioritize sources that change the answer; do not consume the research budget on generic background.',
        write: 'Write a bottom-line-up-front brief. overview (结论): one claim, one or two sentences, answering the core question with its decisive condition. key_findings (关键发现): usually 3–5 claims by decision impact; each opens with a self-contained lead sentence, then one or two sentences of practical meaning with numbers, units and dates. conclusion (影响与建议): only if the user asked for implications or next steps, as supported synthesis. limitations (需留意): at most two gaps that could change the answer. At most 8 claims, 320 Unicode characters per claim and 1600 in total. Keep conditions with the finding. Do not restate the overview, retell pages, pad counts, add unrequested actions or write keyword lists.',
    },
    list: {
        collect:
            'Identify the distinct objects or topics requested. Collect each name, requested attributes, relevant dates or status, eligibility, and a natural grouping attribute (type, region, stage) when entries clearly fall into kinds. Cover different entries before collecting duplicates; track genuinely missing requested fields.',
        write: 'Create a catalogue a reader can scan as a table: one row per named entry, one column per frozen field. Field values are the shortest self-contained answer: a name, a number with unit, a date as YYYY-MM-DD, or a phrase of about 30 characters; use one clear sentence only for a mechanism or condition. Write each entry claim so every field value appears in it as a contiguous phrase WITHOUT the entry name or field label in front (good: claim "Milvus 采用 Apache-2.0 许可" binds "Apache-2.0"; bad: binding "Milvus 的开源许可：Apache-2.0"). State a condition that changes a value once in that entry claim; the renderer shows it as a footnote, so do not repeat it in every field. Deduplicate objects, preserve real groups and label missing requested information 未知; never guess it. Do not fabricate entries, rankings, missing values or unrequested attributes; source links belong in the source appendix. Also write one overview claim stating the inclusion scope (number of entries, grouping basis, inclusion criteria) that is not used as any field value, and return document {version:1,sections:[{id:"scope",title:"收录范围",role:"overview",claimIndexes:[that claim]}]}. Entries and fields are rebuilt from frozen requirements.',
    },
    comparison: {
        collect:
            'Identify the actual comparison objects and shared dimensions. Collect comparable values, units, periods, pricing bases, conditions, strengths, and limitations for every side. Seek missing sides rather than only the best-documented object. If no objects were specified, compare source positions on the question; do not invent products, scores, or rankings.',
        write: 'Produce a comparison matrix: actual objects form columns, shared dimensions form rows. Each cell value is the shortest contiguous span that answers its dimension: a value, a short phrase or at most one sentence, in parallel wording across the row. Do not prefix the object name or dimension label (bad: "Qdrant 的过滤检索：…"); write each object claim so these spans exist. Keep units, measurement period and billing basis in the cell or dimension label. State a condition that changes a cell in the same claim; the renderer shows it as a numbered note under the table. Then write claims that are not used as cell values: one on the decisive difference; two to four, each contrasting at least two objects on one dimension group; and, only when the user asked for a choice or recommendation, conditional claims of the form "需要 X 时，A 更合适，因为 <compared dimension>". Return document with sections overview (title 核心差异), key_findings (title 主要差异), conclusion (title 选择建议, only if requested) and limitations (title 口径说明, only when the measurement basis differs), referencing only these synthesis claims. Do not restate every cell. Unknown is not zero, free, unsupported or a disadvantage. Never invent scores, rankings or an overall winner. Do not confuse comparing objects with historical run changes. The matrix is rebuilt from frozen requirements.',
    },
    research_report: {
        collect:
            'Build an evidence chain around the core questions: definitions and scope, primary evidence, methods or sample conditions, supporting and opposing accounts, necessary context, and limitations. Prefer primary studies or direct documentation where relevant. Respect collection-only tasks: do not expand them into unrequested causal claims or predictions.',
        write: "Write a desk-research report with this outline, omitting a section only when it would be empty. overview (title 摘要): one claim of 3–5 sentences that answers the core question and names the main conclusions in plain Chinese. key_findings (title 主要结论, optional): two to four one-sentence conclusions, each developed later by a thematic section; do not copy section paragraphs. context (title 背景与范围): definitions, scope, time window and exclusions, only when the reader needs them. analysis: two to five thematic sections with informative noun-phrase titles (not questions, not 分析一); each has two to four connected paragraphs: finding, then mechanism or evidence, then implication and conditions. conclusion (title 结论): synthesis across sections answering what this means for the user's question; never restate the overview. limitations (title 局限): only evidence limits that affect a conclusion (missing source types, conflicting accounts, time coverage). Query counts, source counts and the time window are rendered from metadata; do not write them as claims. If a core question lacks evidence, say so once, specifically, in the overview; do not title sections with unanswered questions. Separate distinct ideas into paragraphs and explain relationships rather than merely naming them. Keep material qualifications with the affected paragraph. Do not copy whole paragraphs between sections, invent an experiment, example, method, causal finding or prediction, impose academic IMRaD, or fabricate empty chapters. Distinguish sourced findings from supported synthesis.",
    },
};

const documentRules =
    'For each brief or research_report artifact, return document:{version:1,sections:[{id,title,role,claimIndexes}]}. Use the Chinese section titles given for each format; keep analysis titles specific. Section titles are short Chinese navigation labels, not extra uncited findings. Reference only zero-based claims in this same response and owning format. Include every deliverable main claim exactly once across sections; never include insufficient or reference-only material as main prose. Use role overview/key_findings/context/analysis/conclusion/limitations as appropriate; omit unsupported sections and return document:null when no verified main content exists. Keep conditions in the full claim paragraph; do not put a partial sentence in a heading.';
const structuredDocumentRules =
    ' For list/comparison, document may reference only main claims of that artifact that are not bound to a field or cell; every such unbound main claim appears exactly once; use document:null when there is none.';
const repairRules =
    ' Repair outlines may reference only the repaired response claims; previously accepted valid findings remain available separately. Do not repeat claims merely to populate an outline.';
const sharedCollect =
    '\nCombine queries and sources across the selected formats within the shared budget. Avoid duplicate reads while covering the collection objectives of every selected format.';
const sharedWrite =
    '\nOrganize each selected format separately and set each claim.outputFormat to its owning format. A verbatim citation may be shared, but do not copy the same claims word for word into multiple artifacts. Allocate the existing shared response capacity by the complexity of the requested outputs: reserve room for coherent research paragraphs and all required objects before optional detail, rather than dividing it equally. Each selected format must have content; where evidence is unavailable, use a specific insufficient claim within that format. Never add an unselected format.';

export function outputInstructions(config: TaskConfig, stage: 'collect' | 'write') {
    const formats = selectedOutputFormats(config);
    const structured = formats.some((format) => format === 'list' || format === 'comparison');
    const objectiveLines = formats.map((format) => `${format}: ${objectives[format][stage]}`);
    const documents =
        stage === 'write'
            ? `\n${documentRules}${structured ? structuredDocumentRules : ''}${repairRules}`
            : '';
    const shared = formats.length > 1 ? (stage === 'collect' ? sharedCollect : sharedWrite) : '';
    return `\n# Selected deliverables\nGenerate exactly these formats: ${JSON.stringify(formats)}.\n${objectiveLines.join('\n')}${documents}${shared}\n`;
}
