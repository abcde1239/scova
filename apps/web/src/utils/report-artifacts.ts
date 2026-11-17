import {
    classifyReportDelivery,
    researchCoverageMetrics,
    validReportArtifacts,
    type ArtifactDocument,
    type Report,
    type ReportValue,
} from '@scova/models';

/** Use only complete saved outlines; legacy or incomplete snapshots retain their original view. */
export function savedArtifactDocument(report: Report, format = report.format) {
    const artifact = report.coverage.artifacts?.find((entry) => entry.format === format);
    const document = artifact?.content?.document;
    if (!artifact || !document || document.version !== 1 || !document.sections.length)
        return undefined;
    return validReportArtifacts([artifact], report.claims, report.coverage.reportValue)
        ? document
        : undefined;
}

type DocumentSection = ArtifactDocument['sections'][number];
const unnumbered = new Set<DocumentSection['role']>(['overview', 'key_findings']);

/** Research chapters are numbered after the abstract; the directory reuses the same numbers. */
export function documentSectionNumbers(document: ArtifactDocument, format: Report['format']) {
    const numbers = new Map<string, number>();
    if (format !== 'research_report') return numbers;
    for (const section of document.sections)
        if (!unnumbered.has(section.role)) numbers.set(section.id, numbers.size + 1);
    return numbers;
}

/** Structured formats place their scope or core difference above the table, the rest below. */
export function splitStructuredDocument(document: ArtifactDocument | undefined) {
    if (!document) return { lead: undefined, tail: undefined };
    const leadSections = document.sections.filter((section) => section.role === 'overview');
    const tailSections = document.sections.filter((section) => section.role !== 'overview');
    return {
        lead: leadSections.length ? { ...document, sections: leadSections } : undefined,
        tail: tailSections.length ? { ...document, sections: tailSections } : undefined,
    };
}

/** A saved artifact is a content snapshot, never a client-side layout conversion. */
export function savedArtifactFormats(report: Report): Report['format'][] {
    return report.coverage.artifacts?.map((artifact) => artifact.format) ?? [report.format];
}

/** A display-only fallback for old snapshots whose stored summary predates citation demotion. */
export function reportSummary(report: Report): string {
    const saved = report.coverage.artifacts?.find(
        (entry) => entry.format === report.format,
    )?.summary;
    if (saved) return saved;
    if (!report.claims.some((claim) => claim.kind === 'insufficient')) return report.summary;
    return coveredSummary(report.claims, report.coverage.reportValue);
}

function coveredSummary(claims: Report['claims'], reportValue: ReportValue | undefined): string {
    const mainIndexes = new Set(
        reportValue?.selections
            .filter((entry) => entry.placement === 'main')
            .map((entry) => entry.claimIndex),
    );
    const eligible = (index: number) =>
        !!claims[index] &&
        claims[index]!.kind !== 'insufficient' &&
        claims[index]!.kind !== 'conflict' &&
        (!reportValue || mainIndexes.has(index));
    const selected = new Set<number>();
    for (const question of reportValue?.questions ?? []) {
        const index = question.claimIndexes.find(eligible);
        if (index !== undefined) selected.add(index);
    }
    for (let index = 0; index < claims.length && selected.size < 3; index++) {
        if (eligible(index)) selected.add(index);
    }
    return (
        [...selected].map((index) => claims[index]!.text).join('\n') ||
        '本形式尚未取得可交付内容，相关限制见下方。'
    );
}

export function artifactReport(report: Report, format: Report['format']): Report {
    const artifact = report.coverage.artifacts?.find((entry) => entry.format === format);
    if (!artifact) return report;
    const indexes = artifact.claimIndexes.filter((index) => report.claims[index]);
    const remap = new Map(indexes.map((index, order) => [index, order]));
    const claims = indexes.map((index) => report.claims[index]!);
    const evidenceIds = new Set(claims.flatMap((claim) => claim.evidenceIds));
    for (const change of report.changes) {
        for (const id of [...change.oldEvidenceIds, ...change.newEvidenceIds]) evidenceIds.add(id);
    }
    const originalValue = report.coverage.reportValue;
    const reportValue: ReportValue | undefined = originalValue
        ? {
              ...originalValue,
              selections: originalValue.selections.flatMap((selection) => {
                  const claimIndex = remap.get(selection.claimIndex);
                  return claimIndex === undefined ? [] : [{ ...selection, claimIndex }];
              }),
              questions: originalValue.questions.map((question) => {
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
                              !claimIndexes.some((index) => claims[index]?.kind === 'conflict')
                            ? 'provisional'
                            : question.status,
                      gap: !claimIndexes.length ? '本成果尚无该问题的直接回答。' : question.gap,
                  };
              }),
          }
        : undefined;
    // First cover the saved questions, then fill remaining space. Array order alone
    // can otherwise spend every summary slot on one subquestion.
    const generatedSummary = coveredSummary(claims, reportValue);
    const single = report.coverage.artifacts?.length === 1;
    const safeSavedSummary = single && !claims.some((claim) => claim.kind === 'insufficient');
    const projected: Report = {
        ...report,
        format,
        claims,
        // Run-level history is rendered from the original immutable report below the artifact.
        changes: [],
        evidence: report.evidence.filter((entry) => evidenceIds.has(entry.id)),
        summary:
            (artifact.summary ?? (safeSavedSummary ? report.summary : generatedSummary)) ||
            '本形式尚未取得可交付内容，相关限制见下方。',
        coverage: {
            ...report.coverage,
            artifacts: [
                {
                    ...artifact,
                    format,
                    claimIndexes: claims.map((_, index) => index),
                    ...(artifact.coverage
                        ? {
                              coverage: {
                                  ...artifact.coverage,
                                  requirements: artifact.coverage.requirements.map((entry) => ({
                                      ...entry,
                                      claimIndexes: entry.claimIndexes.flatMap(
                                          (index) => remap.get(index) ?? [],
                                      ),
                                  })),
                              },
                          }
                        : {}),
                    ...(artifact.content
                        ? {
                              content: {
                                  ...artifact.content,
                                  ...(artifact.content.document
                                      ? {
                                            document: {
                                                ...artifact.content.document,
                                                sections: artifact.content.document.sections.map(
                                                    (section) => ({
                                                        ...section,
                                                        claimIndexes: section.claimIndexes.flatMap(
                                                            (index) => remap.get(index) ?? [],
                                                        ),
                                                    }),
                                                ),
                                            },
                                        }
                                      : {}),
                                  ...(artifact.content.list
                                      ? {
                                            list: {
                                                entries: artifact.content.list.entries.map(
                                                    (entry) => ({
                                                        ...entry,
                                                        fields: entry.fields.map((field) => ({
                                                            ...field,
                                                            claimIndexes:
                                                                field.claimIndexes.flatMap(
                                                                    (index) =>
                                                                        remap.get(index) ?? [],
                                                                ),
                                                        })),
                                                    }),
                                                ),
                                            },
                                        }
                                      : {}),
                                  ...(artifact.content.comparison
                                      ? {
                                            comparison: {
                                                ...artifact.content.comparison,
                                                cells: artifact.content.comparison.cells.map(
                                                    (entry) => ({
                                                        ...entry,
                                                        claimIndexes: entry.claimIndexes.flatMap(
                                                            (index) => remap.get(index) ?? [],
                                                        ),
                                                    }),
                                                ),
                                            },
                                        }
                                      : {}),
                              },
                          }
                        : {}),
                },
            ],
            ...(reportValue ? { reportValue } : {}),
        },
    };
    projected.coverage.delivery = classifyReportDelivery(
        reportValue,
        claims,
        projected.coverage.artifacts,
    );
    if (report.coverage.metrics)
        projected.coverage.metrics = researchCoverageMetrics(
            reportValue,
            claims,
            projected.coverage.artifacts,
        );
    if (report.coverage.propositions)
        projected.coverage.propositions = report.coverage.propositions.flatMap((p) => {
            const index = remap.get(p.claimIndex);
            const ids = new Set(
                projected.coverage.artifacts?.flatMap(
                    (a) => a.coverage?.requirements.map((r) => r.id) ?? [],
                ),
            );
            return index === undefined
                ? []
                : [
                      {
                          ...p,
                          claimIndex: index,
                          requirementIds: p.requirementIds.filter((id) => ids.has(id)),
                      },
                  ];
        });
    return projected;
}

type ArtifactContent = NonNullable<NonNullable<Report['coverage']['artifacts']>[number]['content']>;
export type StructuredValue = Pick<
    NonNullable<ArtifactContent['list']>['entries'][number]['fields'][number],
    'text' | 'claimIndexes' | 'status' | 'gap'
>;

const uniqueText = (values: (string | undefined)[]) => [
    ...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value)),
];

/** Conditions, gaps and evidence notices attached to one saved field or cell. */
export function structuredValueNotes(report: Report, value: StructuredValue) {
    if (value.status === 'model_answered')
        return { conditions: [], gaps: [], notices: [], visibleGap: '' };
    const indexes = [...new Set(value.claimIndexes)].filter((index) => report.claims[index]);
    const selections = (report.coverage.reportValue?.selections ?? []).filter((entry) =>
        indexes.includes(entry.claimIndex),
    );
    const visibleText = value.status === 'unknown' ? '' : value.text;
    const visibleGap = value.status === 'supported' ? '' : value.gap;
    const conditions = uniqueText(selections.map((entry) => entry.assessment?.conditions)).filter(
        (condition) => !visibleText.includes(condition) && !visibleGap.includes(condition),
    );
    const gaps = uniqueText(selections.map((entry) => entry.assessment?.gap)).filter(
        (gap) => !visibleGap.includes(gap) && !visibleText.includes(gap),
    );
    const notices = uniqueText(
        indexes.map((index) => {
            const selection = selections.find((entry) => entry.claimIndex === index);
            if (report.claims[index]?.kind === 'insufficient')
                return '关联内容待核实，尚不能作为已确认结论';
            if (selection?.placement === 'reference')
                return `关联内容为参考材料，未作为当前结论${selection.reason ? `：${selection.reason}` : ''}`;
            return undefined;
        }),
    );
    return { conditions, gaps, notices, visibleGap };
}

/** Footnote texts for compact table cells, in reading order. */
export function structuredValueFootnotes(report: Report, value: StructuredValue): string[] {
    const notes = structuredValueNotes(report, value);
    return uniqueText([
        notes.visibleGap,
        ...notes.notices,
        ...notes.conditions,
        ...notes.gaps.map((gap) => `补充说明：${gap}`),
    ]);
}

/** Lists read as a table only when every entry shares short, identical fields. */
export function tabularList(list: NonNullable<ArtifactContent['list']>) {
    const labels = (entry: (typeof list.entries)[number]) =>
        visibleFields(entry).map((field) => field.label);
    const first = list.entries[0];
    if (!first) return undefined;
    const columns = labels(first);
    const short = (text: string) => Array.from(text).length <= 40;
    if (
        !columns.length ||
        columns.length > 6 ||
        list.entries.some(
            (entry) =>
                labels(entry).join('\u0000') !== columns.join('\u0000') ||
                visibleFields(entry).some(
                    (field) => field.status !== 'unknown' && !short(field.text),
                ),
        )
    )
        return undefined;
    return columns;
}

/** A field that only repeats the entry name adds no information. */
export function visibleFields(entry: NonNullable<ArtifactContent['list']>['entries'][number]) {
    const fields = entry.fields.filter(
        (field) => !(field.status === 'supported' && field.text.trim() === entry.name.trim()),
    );
    return fields.length ? fields : entry.fields;
}

/** Consecutive group headings; entries without a group stay in an unnamed run. */
export function groupRuns<T extends { group?: string }>(items: readonly T[]) {
    const runs: { group: string; items: T[] }[] = [];
    for (const item of items) {
        const group = item.group ?? '';
        const last = runs.at(-1);
        if (last && last.group === group) last.items.push(item);
        else runs.push({ group, items: [item] });
    }
    return runs;
}
