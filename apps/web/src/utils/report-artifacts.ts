import { classifyReportDelivery, type Report, type ReportValue } from '@scova/models';

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
    return projected;
}
