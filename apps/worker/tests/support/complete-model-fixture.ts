import type { StructuredInput } from '@scova/connectors';

/** Old lifecycle fixtures still return the full current planning/binding protocol. */
export function completeModelFixture() {
    let requirements: Record<string, unknown>[] = [];
    return (input: StructuredInput, data: Record<string, unknown>) => {
        const properties = input.schema.properties as Record<string, any>;
        if (properties.queries) {
            const formats: string[] = properties.requirements.items.properties.format.enum;
            const ids: string[] = properties.queries.items.properties.questionIds.items.enum;
            requirements = formats.flatMap((format) =>
                ids.map((id) => ({
                    id: `fixture-${format}-${id}`,
                    format,
                    questionIds: [id],
                    object: '',
                    field: '受控公告内容',
                    required: true,
                    verification: 'stable',
                })),
            );
            return { ...data, requirements, knowledgePlan: [] };
        }
        if (properties.answers)
            return {
                answers: properties.answers.items.properties.requirementId.enum.map(
                    (requirementId: string) => ({
                        requirementId,
                        canAnswer: false,
                        text: '',
                        reason: '受控夹具不提供模型知识',
                    }),
                ),
            };
        if (!properties.claims || !Array.isArray(data.claims)) return data;
        const ids: string[] =
            properties.artifacts.items.properties.requirements.items.properties.id.enum;
        const active = requirements.filter((r) => !ids || ids.includes(String(r.id)));
        const claims = (data.claims as Record<string, any>[]).map((claim) => ({
            ...claim,
            text: String(claim.text),
            outputFormat: properties.claims.items.properties.outputFormat.enum[0],
            questionIds: claim.questionIds.filter((id: string) =>
                properties.claims.items.properties.questionIds.items.enum.includes(id),
            ),
            assessment: {
                ...(claim.assessment ?? {
                    relevance: 'direct',
                    support: 'direct',
                    role: 'answer',
                    sourceRelation: 'original',
                    reason: '受控公告逐字提供本测试事实',
                    conditions: '',
                    gap: '',
                }),
                ...(properties.claims.items.properties.assessment?.properties.gapKind
                    ? { gapKind: claim.assessment?.gap ? 'missing_core' : 'none' }
                    : {}),
            },
        }));
        return {
            ...data,
            claims,
            evidenceLinks: [],
            fieldChecks: active.map((r) => ({
                requirementId: r.id,
                status: 'supported',
                query: '',
                reason: '受控公告原文已绑定',
            })),
            artifacts: [...new Set(active.map((r) => r.format))].map((format) => ({
                format,
                document: null,
                requirements: active
                    .filter((r) => r.format === format)
                    .map((r) => ({
                        id: r.id,
                        text: claims[0]?.text ?? '',
                        claimIndexes: claims.length ? [0] : [],
                    })),
            })),
        };
    };
}
