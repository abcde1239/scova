type AgentClaim = { kind: string; text: string; citations: readonly { pageId: string }[] };
import type { Coverage } from './runs.ts';
import type { ReportValue } from './report-value.ts';

type Selection = ReportValue['selections'][number];
type SummaryAnswer = {
    claim: AgentClaim;
    selection: Selection;
    key: string;
    sourceKey: string;
    words: Set<string>;
};
const size = (text: string) => Array.from(text).length;
const normalize = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stopWords = new Set([
    '解释',
    '比较',
    '说明',
    '如何',
    '什么',
    '哪些',
    '区别',
    '使用',
    '场景',
    '问题',
    '是否',
    '目前',
    '相关',
]);

/** Lexical coverage only orders already selected main answers; it does not verify support. */
function words(text: string): Set<string> {
    const segments = [...segmenter.segment(text)];
    const chinese = segments
        .filter((s) => s.isWordLike && /\p{Script=Han}/u.test(s.segment) && size(s.segment) > 1)
        .map((s) => s.segment);
    const english = text.toLowerCase().match(/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*/g) ?? [];
    // ICU can split a concept such as “缓存” into single characters. Keep adjacent Han
    // pairs within a phrase as a fallback, without crossing punctuation or particles.
    const pairs: string[] = [];
    let previous = '';
    for (const { segment } of segments) {
        if (/^\p{Script=Han}$/u.test(segment) && !/[的和与及或是在了]/u.test(segment)) {
            if (previous) pairs.push(previous + segment);
            previous = segment;
        } else previous = '';
    }
    return new Set([...chinese, ...english, ...pairs].filter((word) => !stopWords.has(word)));
}

function answerBody({ claim, selection }: SummaryAnswer): string {
    const gap =
        selection.assessment?.gap ||
        (claim.kind === 'conflict' ? '来源说法存在差异，尚未解决分歧。' : '');
    return [
        claim.text.trim(),
        selection.assessment?.conditions ? `适用条件：${selection.assessment.conditions}` : '',
        gap ? `补充说明：${gap}` : '',
        selection.timeScope === 'background' ? '时间范围：背景材料。' : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function answerSummary(claims: AgentClaim[], value: ReportValue): string {
    const ordered = [...value.questions].sort(
        (a, b) => Number(b.priority === 'core') - Number(a.priority === 'core'),
    );
    // Provisional and disputed questions already carry their status and conditions in the
    // visible answer rows. Repeat the route-to-details note only for questions with no direct
    // answer, so the overview does not turn every qualified conclusion into a warning.
    const incomplete = value.questions.filter((q) => q.status === 'unresolved').length;
    const suffix = [
        incomplete ? `${incomplete}个问题还有补充说明，详情见正文。` : '',
        ordered.length > 3 ? `${ordered.length - 3}个其余问题的答案见正文。` : '',
    ]
        .filter(Boolean)
        .map((text) => `\n\n${text}`)
        .join('');
    const questionWords = new Map(ordered.map((q) => [q.id, words(q.text)]));
    const frequency = new Map<string, number>();
    for (const terms of questionWords.values())
        for (const term of terms) {
            frequency.set(term, (frequency.get(term) ?? 0) + 1);
        }
    const selections = new Map(value.selections.map((s) => [s.claimIndex, s]));
    const rows = ordered.slice(0, 3).map((question, index) => {
        const candidates = question.claimIndexes.flatMap((claimIndex): SummaryAnswer[] => {
            const claim = claims[claimIndex];
            const selection = selections.get(claimIndex);
            if (
                !claim ||
                claim.kind === 'insufficient' ||
                selection?.placement !== 'main' ||
                !selection.questionIds.includes(question.id)
            )
                return [];
            // Conditions, gaps, kind and time scope distinguish claims that must not be merged.
            const key = JSON.stringify([
                claim.kind,
                normalize(claim.text),
                normalize(selection.assessment?.conditions ?? ''),
                normalize(selection.assessment?.gap ?? ''),
                selection.timeScope,
                selection.assessment?.support,
            ]);
            const sourceKey =
                [...new Set(claim.citations.map((citation) => citation.pageId))].sort().join('|') ||
                `claim:${claimIndex}`;
            return [{ claim, selection, key, sourceKey, words: words(claim.text) }];
        });
        const status = {
            supported: '已回答',
            provisional: '主要结论',
            disputed: '不同来源',
            unresolved: '暂无直接回答',
        }[question.status];
        // Long question labels must not consume the entire overview; full text remains in the body.
        const label =
            size(question.text) <= 80
                ? question.text
                : `问题${index + 1}（${question.priority === 'core' ? '核心' : '补充'}，题目见正文）`;
        return {
            question,
            candidates,
            prefix: `${label} · ${status}`,
            compactPrefix: `${question.priority === 'core' ? '核心' : '补充'}${index + 1}·${status}`,
            chosen: [] as SummaryAnswer[],
        };
    });
    let compact = false;
    const used = new Set<string>();
    const paragraph = (row: (typeof rows)[number]) => {
        const prefix = compact ? row.compactPrefix : row.prefix;
        if (row.chosen.length) {
            const groups = new Map<string, SummaryAnswer[]>();
            for (const answer of row.chosen)
                groups.set(answer.sourceKey, [...(groups.get(answer.sourceKey) ?? []), answer]);
            return `${prefix}：${[...groups.values()]
                .map((group) => group.map(answerBody).join('；'))
                .join(' ')}`;
        }
        if (row.candidates.length && row.candidates.every((c) => used.has(c.key))) {
            const previous = new Set(
                rows.slice(0, rows.indexOf(row)).flatMap((r) => r.chosen.map((c) => c.key)),
            );
            const location = row.candidates.every((c) => previous.has(c.key))
                ? '前文'
                : '其他问题中';
            return `${prefix}：相关回答已在${location}列出，详情见正文。`;
        }
        const gap =
            row.question.status === 'unresolved' && size(row.question.gap) <= 60
                ? row.question.gap
                : '';
        return gap
            ? `${prefix}：${gap.replace(/[。！？.!?]+$/u, '')}；详细回答见正文。`
            : `${prefix}，详细回答见正文。`;
    };
    const render = () => rows.map(paragraph).join('\n\n') + suffix;
    function select(row: (typeof rows)[number], limit: number, complementary: boolean) {
        const terms = questionWords.get(row.question.id)!;
        const covered = new Set(row.chosen.flatMap((c) => [...c.words]));
        // A broad comparison can mention every query word without explaining the mechanism.
        // Reserve one direct answer role for a core question before expanding conditions.
        const missingCoreAnswer =
            row.question.priority === 'core' &&
            !row.chosen.some((c) => c.selection.assessment?.role === 'answer');
        const gain = (c: SummaryAnswer) =>
            [...terms].reduce(
                (total, term) =>
                    total +
                    (!covered.has(term) && c.words.has(term) ? 1 / frequency.get(term)! : 0),
                0,
            );
        const score = (c: SummaryAnswer) =>
            gain(c) +
            (complementary && !missingCoreAnswer
                ? 0
                : c.selection.assessment?.role === 'answer'
                  ? 1.5
                  : c.selection.assessment?.role === 'comparison'
                    ? 0.5
                    : 0);
        const candidates = row.candidates
            .filter((c) => !used.has(c.key))
            .sort(
                (a, b) =>
                    Number(b.claim.kind === 'conflict') - Number(a.claim.kind === 'conflict') ||
                    Number(b.selection.assessment?.support === 'direct') -
                        Number(a.selection.assessment?.support === 'direct') ||
                    score(b) - score(a),
            );
        for (const candidate of candidates) {
            if (
                complementary &&
                gain(candidate) === 0 &&
                !(missingCoreAnswer && candidate.selection.assessment?.role === 'answer')
            )
                continue;
            row.chosen.push(candidate);
            used.add(candidate.key);
            if (size(paragraph(row)) <= limit && size(render()) <= 600) {
                return;
            }
            const previousCompact = compact;
            if (complementary) compact = true;
            if (complementary && size(render()) <= 600) return;
            if (complementary && row.question.priority === 'core') {
                const deferred = rows
                    .filter(
                        (other) =>
                            other.question.priority !== 'core' &&
                            other.question.status !== 'disputed' &&
                            other.chosen.length > 0 &&
                            other.chosen.every((answer) => answer.claim.kind !== 'conflict'),
                    )
                    .map((other) => ({ row: other, chosen: other.chosen }));
                for (const other of deferred) {
                    other.row.chosen = [];
                    for (const answer of other.chosen) used.delete(answer.key);
                }
                // Preserve whole core answers and their qualifications; supporting detail has
                // an explicit route to the body instead of squeezing out a core subquestion.
                if (deferred.length && size(render()) <= 600) return;
                for (const other of deferred) {
                    other.row.chosen = other.chosen;
                    for (const answer of other.chosen) used.add(answer.key);
                }
            }
            compact = previousCompact;
            used.delete(candidate.key);
            row.chosen.pop();
            // Never replace an oversized conflict with only one of its sides.
            if (candidate.claim.kind === 'conflict') return;
        }
    }
    // First reserve space for every question, then spend remaining space on missing subtopics.
    rows.forEach((row, i) =>
        select(
            row,
            size(paragraph(row)) + Math.floor((600 - size(render())) / (rows.length - i)),
            false,
        ),
    );
    for (const row of rows) if (!row.chosen.length) select(row, 600, false);
    for (const row of rows) {
        const maximum = row.question.priority === 'core' ? 3 : 2;
        while (row.chosen.length > 0 && row.chosen.length < maximum) {
            const before = row.chosen.length;
            select(row, 600, true);
            if (row.chosen.length === before) break;
        }
    }
    return render();
}

/** A short overview from already validated conclusions; never splice a sentence mid-output. */
export function reportSummary(claims: AgentClaim[], value?: ReportValue): string {
    if (value) return answerSummary(claims, value);
    const preferred = claims.some((claim) => claim.kind === 'inference')
        ? claims.filter((claim) => claim.kind === 'inference')
        : claims.filter((claim) => claim.kind !== 'insufficient');
    const uncertain = claims.filter((claim) => claim.kind === 'insufficient').length;
    const suffix =
        uncertain && preferred !== claims
            ? `\n\n另有${uncertain}条内容需要补充材料，详情见正文。`
            : '';
    const maximum = 600 - Array.from(suffix).length;
    const paragraphs: string[] = [];
    let length = 0;
    for (const claim of preferred) {
        const text = `${claim.kind === 'insufficient' ? '需要补充材料：' : claim.kind === 'conflict' ? '不同来源：' : ''}${claim.text.trim()}`;
        const size = Array.from(text).length;
        if (paragraphs.includes(text) || length + size > maximum) continue;
        paragraphs.push(text);
        length += size;
        if (paragraphs.length === 3) break;
    }
    const summary =
        paragraphs.join('\n\n') ||
        (uncertain
            ? '内容需要补充材料，请查看下方正文和来源。'
            : '已整理来源与结论，请查看下方正文和引用。');
    return summary + (paragraphs.length ? suffix : '');
}

/** Persist the default artifact's overview while retaining the union as immutable report evidence. */
type SummaryArtifact = NonNullable<Coverage['artifacts']>[number];

/** Lists and matrices summarize by their own synthesis claim or shape, never by gluing cells. */
function structuredSummary(claims: AgentClaim[], artifact: SummaryArtifact): string | undefined {
    const content = artifact.content;
    const values = content?.list
        ? content.list.entries.flatMap((entry) => entry.fields)
        : (content?.comparison?.cells ?? []);
    if (!content?.list && !content?.comparison) return;
    const overview = content.document?.sections
        .filter((section) => section.role === 'overview')
        .flatMap((section) => section.claimIndexes)
        .map((index) => claims[index]?.text.trim())
        .filter(Boolean)
        .join('\n\n');
    if (overview) return overview.slice(0, 2000);
    const unknown = values.filter((value) => value.status === 'unknown').length;
    const shape = content.list
        ? `共 ${content.list.entries.length} 项 · ${new Set(values.map((v) => ('label' in v ? v.label : ''))).size} 个字段`
        : `${content.comparison!.objects.length} 个对象 × ${content.comparison!.dimensions.length} 个维度`;
    return `${shape}${unknown ? ` · ${unknown} 项未知` : ''}`;
}

export function primaryArtifactSummary(
    claims: AgentClaim[],
    coverage: Pick<Coverage, 'artifacts' | 'reportValue'>,
): string {
    const artifact = coverage.artifacts?.[0];
    if (!artifact) return reportSummary(claims, coverage.reportValue);
    if (artifact.summary) return artifact.summary;
    const structured = structuredSummary(claims, artifact);
    if (structured) return structured;
    const requirements = artifact.coverage?.requirements;
    if (requirements?.some((r) => r.object.trim()) && coverage.reportValue) {
        const owned = new Set(artifact.claimIndexes);
        const selections = new Map(coverage.reportValue.selections.map((s) => [s.claimIndex, s]));
        const eligible = (index: number) =>
            owned.has(index) &&
            !!claims[index] &&
            claims[index]!.kind !== 'insufficient' &&
            selections.get(index)?.placement === 'main';
        const ordered = [
            ...requirements.filter((r) => r.required),
            ...requirements.filter((r) => !r.required),
        ];
        const chosen = new Set<number>();
        const used = new Set<string>();
        const paragraphs: string[] = [];
        const select = (requirement: (typeof ordered)[number]) => {
            if (
                requirement.status === 'unknown' ||
                requirement.claimIndexes.every((index) => chosen.has(index))
            )
                return;
            const candidates = requirement.claimIndexes.filter(eligible).map((index) => {
                const claim = claims[index]!;
                const selection = selections.get(index)!;
                const answer: SummaryAnswer = {
                    claim,
                    selection,
                    key: '',
                    sourceKey: '',
                    words: new Set(),
                };
                const body = answerBody(answer);
                const key = normalize(body);
                const text = `${claim.kind === 'conflict' ? '不同来源 · ' : ''}${body}`;
                return { index, key, text };
            });
            // A field may be answered by a chain of mechanisms, prerequisites and
            // consequences. Preserve its saved order and complete qualified claims;
            // selecting the shortest member can leave an action without its trigger.
            const additions: typeof candidates = [];
            const keys = new Set(used);
            for (const candidate of candidates) {
                if (!keys.has(candidate.key)) {
                    additions.push(candidate);
                    keys.add(candidate.key);
                }
            }
            const label = [
                requirement.object,
                size(requirement.field) <= 80 ? requirement.field : '所需信息',
            ]
                .filter(Boolean)
                .join(' · ');
            const paragraph = additions.length
                ? `${label}：${additions.map((c) => c.text).join('；')}`
                : '';
            if (size([...paragraphs, paragraph].filter(Boolean).join('\n\n')) > 1800) return;
            for (const candidate of candidates) {
                chosen.add(candidate.index);
                used.add(candidate.key);
            }
            if (paragraph) paragraphs.push(paragraph);
        };
        // Reserve a complete qualified answer for every object before spending the
        // overview on additional fields of one object or on the broad goal question.
        const objects = new Set<string>();
        for (const requirement of ordered) {
            const key = requirement.object || requirement.id;
            if (objects.has(key)) continue;
            objects.add(key);
            select(requirement);
        }
        for (const requirement of ordered) select(requirement);
        if (paragraphs.length) {
            const deferred = ordered.filter(
                (r) =>
                    r.status !== 'unknown' &&
                    r.claimIndexes.some(eligible) &&
                    r.claimIndexes.filter(eligible).some((i) => !chosen.has(i)),
            );
            const firstDeferred = deferred[0];
            const deferredLabel = firstDeferred
                ? [firstDeferred.object, firstDeferred.field].filter(Boolean).join(' · ')
                : '';
            const details = deferred.length
                ? `\n\n另有${deferred.length}项已取得的信息及完整条件见正文${deferredLabel && size(deferredLabel) <= 100 ? `（包括${deferredLabel}）` : ''}。`
                : '';
            return paragraphs.join('\n\n') + details;
        }
    }
    const indexes = artifact.claimIndexes.filter((index) => claims[index]);
    const remap = new Map(indexes.map((index, order) => [index, order]));
    const selected = indexes.map((index) => claims[index]!);
    const original = coverage.reportValue;
    const value: ReportValue | undefined = original
        ? {
              ...original,
              selections: original.selections.flatMap((selection) => {
                  const claimIndex = remap.get(selection.claimIndex);
                  return claimIndex === undefined ? [] : [{ ...selection, claimIndex }];
              }),
              questions: original.questions.map((question) => {
                  const claimIndexes = question.claimIndexes.flatMap((index) => {
                      const next = remap.get(index);
                      return next === undefined ? [] : [next];
                  });
                  return {
                      ...question,
                      claimIndexes,
                      status: !claimIndexes.length
                          ? 'unresolved'
                          : question.status === 'disputed' &&
                              !claimIndexes.some((index) => selected[index]?.kind === 'conflict')
                            ? 'provisional'
                            : question.status,
                      gap: !claimIndexes.length ? '本成果尚无该问题的直接回答。' : question.gap,
                  };
              }),
          }
        : undefined;
    return reportSummary(selected, value);
}
