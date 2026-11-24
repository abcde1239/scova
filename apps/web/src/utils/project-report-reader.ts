import type { Report } from '@scova/models';
import { savedArtifactDocument } from '@/utils/report/artifacts';

export interface ProjectReportCitation {
    reportId: string;
    source: 'claim' | 'summary' | 'limitation';
    sectionId: string | null;
    sectionTitle: string;
    claimId: string | null;
    paragraphIndex: number;
    text: string;
}

export type ProjectReportSourceCitation = {
    reportId: string;
    snapshotId: string;
    title: string;
};

type Paragraph = { reference: ProjectReportCitation; label?: string };
type Section = { key: string; title: string; paragraphs: Paragraph[] };

export function projectReportSections(report: Report): Section[] {
    function paragraphs(
        text: string,
        sectionTitle: string,
        sectionId: string | null,
        claimId: string | null,
        label?: string,
    ): Paragraph[] {
        return text.split(/\r?\n[\t ]*\r?\n/).flatMap((value, paragraphIndex) => {
            if (!value.trim()) return [];
            return [
                {
                    reference: {
                        reportId: report.id,
                        source: claimId === null ? 'summary' : 'claim',
                        sectionTitle,
                        sectionId,
                        claimId,
                        paragraphIndex,
                        text: value.trim(),
                    },
                    label,
                },
            ];
        });
    }

    const document = savedArtifactDocument(report);
    const outline = document?.sections ?? [
        {
            id: null,
            title: '报告正文',
            claimIndexes: report.claims.map((_, index) => index),
        },
    ];
    const labels = {
        model_answer: '模型自回答',
        insufficient: '证据不足',
        conflict: '来源存在分歧',
    };
    const body = outline.flatMap((section) => {
        const content = section.claimIndexes.flatMap((index) => {
            const claim = report.claims[index];
            return claim
                ? paragraphs(
                      claim.text,
                      section.title,
                      section.id,
                      claim.id,
                      claim.kind in labels ? labels[claim.kind as keyof typeof labels] : undefined,
                  )
                : [];
        });
        return content.length
            ? [{ key: `body-${section.id ?? 'legacy'}`, title: section.title, paragraphs: content }]
            : [];
    });
    return [
        {
            key: 'summary',
            title: '报告摘要',
            paragraphs: paragraphs(report.summary, '报告摘要', null, null),
        },
        ...body,
        ...(report.limitations.length
            ? [
                  {
                      key: 'limitations',
                      title: '报告限制',
                      paragraphs: report.limitations.map<Paragraph>((text, paragraphIndex) => ({
                          reference: {
                              reportId: report.id,
                              source: 'limitation',
                              sectionTitle: '报告限制',
                              sectionId: null,
                              claimId: null,
                              paragraphIndex,
                              text,
                          },
                      })),
                  },
              ]
            : []),
    ];
}
