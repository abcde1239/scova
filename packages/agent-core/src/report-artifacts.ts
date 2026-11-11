import {
    primaryArtifactSummary,
    selectedOutputFormats,
    type ReportArtifact,
    type ReportValue,
} from '@scova/models';
import type { AgentClaim, AgentContext, ComparisonExtraction } from './types.ts';
import { isDeepStrictEqual } from 'node:util';

type Format = ReportArtifact['format'];
export interface PlannedRequirement {
    id: string;
    format: Format;
    questionIds: string[];
    object: string;
    field: string;
    required: boolean;
}
const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** A display-text repair must stay with the explicitly linked object's own evidence. */
function mentionsObject(name: string, claim: AgentClaim): boolean {
    if (!name.trim()) return true;
    // Permit the grammatical insertion in “回调中创建”, without dropping scope or version.
    const normalize = (text: string) =>
        text
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/中(?=创建|建立|注册|启动|生成|定义)/g, '');
    const label = normalize(name);
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /[a-z0-9_]/;
    const pattern = new RegExp(
        `${boundary.test(label[0]!) ? '(?<![a-z0-9_])' : ''}${escaped}${boundary.test(label.at(-1)!) ? '(?![a-z0-9_])' : ''}`,
    );
    return [
        claim.text,
        claim.assessment?.conditions ?? '',
        ...claim.citations.map((c) => c.quote),
    ].some((fragment) => pattern.test(normalize(fragment)));
}
export function plannedRequirements(
    data: unknown,
    formats: Format[],
    questions: { id: string; text: string }[],
    validateStructure = true,
): PlannedRequirement[] | null {
    if (
        !object(data) ||
        !Array.isArray(data.requirements) ||
        !data.requirements.length ||
        data.requirements.length > 60
    )
        return null;
    const result: PlannedRequirement[] = [];
    for (const r of data.requirements) {
        if (
            !object(r) ||
            typeof r.id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) ||
            result.some((item) => item.id === r.id) ||
            !formats.includes(r.format as Format) ||
            !Array.isArray(r.questionIds) ||
            !r.questionIds.length ||
            r.questionIds.length > 20 ||
            r.questionIds.some(
                (id) => typeof id !== 'string' || !questions.some((q) => q.id === id),
            ) ||
            typeof r.object !== 'string' ||
            r.object.length > 200 ||
            typeof r.field !== 'string' ||
            !r.field.trim() ||
            r.field.length > 1000 ||
            typeof r.required !== 'boolean'
        )
            return null;
        result.push(r as unknown as PlannedRequirement);
    }
    // Every frozen question must remain required in every requested artifact.
    if (
        formats.some((format) =>
            questions.some(
                (q) =>
                    !result.some(
                        (r) => r.format === format && r.required && r.questionIds.includes(q.id),
                    ),
            ),
        )
    )
        return null;
    for (const format of validateStructure ? formats : []) {
        const entries = result.filter((r) => r.format === format && r.object);
        const names = [...new Set(entries.map((r) => r.object))];
        const fields = [...new Set(entries.map((r) => r.field))];
        if (
            names.length > 20 ||
            fields.length > 20 ||
            new Set(entries.map((r) => JSON.stringify([r.object, r.field]))).size !== entries.length
        )
            return null;
        if (
            format === 'comparison' &&
            entries.length &&
            entries.length !== names.length * fields.length
        )
            return null;
    }
    return result;
}
export function fallbackRequirements(
    formats: Format[],
    questions: { id: string; text: string }[],
): PlannedRequirement[] {
    return formats.flatMap((format) =>
        questions.map((q) => ({
            id: `${format}-${q.id}`,
            format,
            questionIds: [q.id],
            object: '',
            field: q.text,
            required: true,
        })),
    );
}
export function requirementPlanSchema(formats: Format[], questionIds: string[]) {
    return {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'format', 'questionIds', 'object', 'field', 'required'],
            properties: {
                id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' },
                format: { type: 'string', enum: formats },
                questionIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    uniqueItems: true,
                    items: { type: 'string', enum: questionIds },
                },
                object: { type: 'string', maxLength: 200 },
                field: { type: 'string', minLength: 1, maxLength: 1000 },
                required: { type: 'boolean' },
            },
        },
    };
}
export function artifactSynthesisSchema(formats: Format[]) {
    return {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['format', 'requirements'],
            properties: {
                format: { type: 'string', enum: formats },
                requirements: {
                    type: 'array',
                    maxItems: 60,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['id', 'text', 'claimIndexes'],
                        properties: {
                            id: { type: 'string', minLength: 1, maxLength: 80 },
                            text: { type: 'string', maxLength: 2000 },
                            claimIndexes: {
                                type: 'array',
                                maxItems: 30,
                                uniqueItems: true,
                                items: { type: 'integer', minimum: 0, maximum: 29 },
                            },
                        },
                    },
                },
            },
        },
    };
}

/** Only retire an older answer to the exact same field when source evidence overlaps. */
export function supersededArtifactClaims(
    claims: AgentClaim[],
    value: ReportValue | undefined,
    artifacts: ReportArtifact[],
    extractions: ComparisonExtraction[],
    validateClaim: (raw: unknown) => AgentClaim | undefined,
): Set<number> {
    const current = artifacts.flatMap((a) => a.coverage?.requirements ?? []);
    const owners = new Map(
        artifacts.flatMap((a) =>
            (a.coverage?.requirements ?? []).map((r) => [r.id, a.format] as const),
        ),
    );
    const active = new Set(current.flatMap((r) => r.claimIndexes));
    const previous = new Map<number, Set<string>>();
    for (const receipt of extractions) {
        const data = receipt.response.data;
        if (!object(data) || !Array.isArray(data.artifacts) || !Array.isArray(data.claims))
            continue;
        const rawClaims = data.claims;
        for (const artifact of data.artifacts) {
            if (!object(artifact) || !Array.isArray(artifact.requirements)) continue;
            for (const requirement of artifact.requirements) {
                if (
                    !object(requirement) ||
                    typeof requirement.id !== 'string' ||
                    owners.get(requirement.id) !== artifact.format ||
                    typeof requirement.text !== 'string' ||
                    !requirement.text.trim() ||
                    !Array.isArray(requirement.claimIndexes)
                )
                    continue;
                const duplicates = data.artifacts.flatMap((group) =>
                    object(group) &&
                    group.format === artifact.format &&
                    Array.isArray(group.requirements)
                        ? group.requirements.filter((r) => object(r) && r.id === requirement.id)
                        : [],
                );
                if (duplicates.length !== 1) continue;
                for (const local of requirement.claimIndexes) {
                    if (
                        !Number.isSafeInteger(local) ||
                        Number(local) < 0 ||
                        Number(local) >= rawClaims.length
                    )
                        continue;
                    const checked = validateClaim(rawClaims[Number(local)]);
                    const index = checked
                        ? claims.findIndex((claim) => isDeepStrictEqual(claim, checked))
                        : -1;
                    if (
                        index < 0 ||
                        active.has(index) ||
                        !checked?.text.includes(requirement.text) ||
                        value?.selections.find((s) => s.claimIndex === index)?.placement !== 'main'
                    )
                        continue;
                    const ids = previous.get(index) ?? new Set<string>();
                    ids.add(requirement.id);
                    previous.set(index, ids);
                }
            }
        }
    }
    const result = new Set<number>();
    for (const [index, ids] of previous) {
        const claim = claims[index]!;
        if (claim.kind === 'conflict' || claim.kind === 'insufficient') continue;
        const replaced = [...ids].every((id) => {
            const next = current.find((r) => r.id === id);
            return (
                next?.status === 'supported' &&
                next.claimIndexes.some((replacement) => {
                    const newer = claims[replacement]!;
                    const selection = value?.selections.find((s) => s.claimIndex === replacement);
                    return (
                        newer.kind !== 'conflict' &&
                        selection?.placement === 'main' &&
                        selection.assessment?.support === 'direct' &&
                        claim.citations.some(
                            (oldQuote) =>
                                oldQuote.quote.length >= 24 &&
                                newer.citations.some(
                                    (newQuote) =>
                                        newQuote.pageId === oldQuote.pageId &&
                                        newQuote.quote.length >= 24 &&
                                        (newQuote.quote.includes(oldQuote.quote) ||
                                            oldQuote.quote.includes(newQuote.quote)),
                                ),
                        )
                    );
                })
            );
        });
        if (replaced) result.add(index);
    }
    return result;
}

/** Rebuild from successful immutable extractions; synthesized coverage cannot alter the plan. */
export function buildReportArtifacts(
    context: AgentContext,
    questions: { id: string; text: string }[],
    claims: AgentClaim[],
    value: ReportValue | undefined,
    plan: ComparisonExtraction | undefined,
    extractions: ComparisonExtraction[],
    validateClaim: (raw: unknown) => AgentClaim | undefined,
): ReportArtifact[] {
    const formats = selectedOutputFormats(context.config);
    const planned =
        plannedRequirements(plan?.response.data, formats, questions, false) ??
        fallbackRequirements(formats, questions);
    return formats.map((format) => {
        const validPlan =
            !!plannedRequirements(
                { requirements: planned.filter((r) => r.format === format) },
                [format],
                questions,
            ) && !!plannedRequirements(plan?.response.data, formats, questions, false);
        const claimIndexes = claims.flatMap((claim, index) =>
            (claim.outputFormat ?? formats[0]) === format ? [index] : [],
        );
        const requirements = planned
            .filter((r) => r.format === format)
            .map((requirement) => {
                let indexes: number[] = [];
                let text = '';
                // A repair's explicit requirement value supersedes its predecessor only if valid.
                for (const receipt of extractions) {
                    const data = receipt.response.data;
                    if (
                        !object(data) ||
                        !Array.isArray(data.artifacts) ||
                        !Array.isArray(data.claims)
                    )
                        continue;
                    const answers = data.artifacts.flatMap((artifact) =>
                        object(artifact) &&
                        artifact.format === format &&
                        Array.isArray(artifact.requirements)
                            ? artifact.requirements.filter(
                                  (r) => object(r) && r.id === requirement.id,
                              )
                            : [],
                    );
                    // Split groups of one format are compatible; duplicate IDs are ambiguous.
                    if (answers.length !== 1) continue;
                    const answer = answers[0];
                    if (
                        !object(answer) ||
                        typeof answer.text !== 'string' ||
                        answer.text.length > 2000 ||
                        !Array.isArray(answer.claimIndexes)
                    )
                        continue;
                    const rawClaims = data.claims;
                    const mapped = answer.claimIndexes.flatMap((index): number[] => {
                        if (
                            !Number.isSafeInteger(index) ||
                            Number(index) < 0 ||
                            Number(index) >= rawClaims.length
                        )
                            return [];
                        const checked = validateClaim(rawClaims[Number(index)]);
                        const global = checked
                            ? claims.findIndex((claim) => isDeepStrictEqual(claim, checked))
                            : -1;
                        const selection = value?.selections.find((s) => s.claimIndex === global);
                        return global >= 0 &&
                            claimIndexes.includes(global) &&
                            checked?.kind !== 'insufficient' &&
                            !checked?.uncertainty?.length &&
                            selection?.placement === 'main' &&
                            requirement.questionIds.some((id) => selection.questionIds.includes(id))
                            ? [global]
                            : [];
                    });
                    const unique = [...new Set(mapped)];
                    if (!unique.length || !answer.text.trim()) continue;
                    const exactSource = unique.find((index) =>
                        claims[index]!.text.includes(answer.text as string),
                    );
                    const safeFallback =
                        mapped.length === answer.claimIndexes.length &&
                        unique.map((index) => claims[index]!.text).join('\n\n').length <= 2000 &&
                        unique.every((index) => {
                            const selection = value?.selections.find(
                                (item) => item.claimIndex === index,
                            );
                            return (
                                selection?.assessment?.relevance === 'direct' &&
                                ['direct', 'partial'].includes(selection.assessment.support) &&
                                selection.assessment.role !== 'lead' &&
                                mentionsObject(requirement.object, claims[index]!)
                            );
                        });
                    const fallbackSource = safeFallback
                        ? unique.find((source) =>
                              unique.every((index) =>
                                  claims[source]!.text.includes(claims[index]!.text),
                              ),
                          )
                        : undefined;
                    if (exactSource !== undefined || fallbackSource !== undefined) {
                        indexes = unique;
                        // The field's display paraphrase is not evidence. Reuse only a complete
                        // validated claim from this receipt's explicit group, never another object.
                        const source = exactSource ?? fallbackSource!;
                        const claim = claims[source]!;
                        const selection = value?.selections.find((s) => s.claimIndex === source);
                        const conditional =
                            !!selection?.assessment?.conditions.trim() ||
                            /\b(?:if|when|unless|except|only|however|but)\b|但|除非|例外|仅|若|条件/u.test(
                                claim.text,
                            );
                        text =
                            exactSource === undefined ||
                            (format === 'comparison' && claim.text !== answer.text && conditional)
                                ? claim.text
                                : answer.text;
                    }
                }
                const coveredQuestions = new Set(
                    indexes.flatMap(
                        (index) =>
                            value?.selections.find((selection) => selection.claimIndex === index)
                                ?.questionIds ?? [],
                    ),
                );
                const supported =
                    validPlan &&
                    requirement.questionIds.every((id) => coveredQuestions.has(id)) &&
                    indexes.length > 0 &&
                    indexes.every((index) => {
                        const selection = value?.selections.find((s) => s.claimIndex === index);
                        return (
                            selection?.assessment?.support === 'direct' && !selection.assessment.gap
                        );
                    });
                const status = supported
                    ? ('supported' as const)
                    : indexes.length
                      ? ('partial' as const)
                      : ('unknown' as const);
                const gap = !validPlan
                    ? '规划未形成可核验的对象与字段范围，不能确认本成果完整覆盖。'
                    : status === 'supported'
                      ? ''
                      : indexes.length
                        ? '仅找到部分支持，仍需核对所需字段。'
                        : '本次未取得该对象和字段的可核验回答。';
                return { ...requirement, status, claimIndexes: indexes, gap, text };
            });
        const artifact: ReportArtifact = {
            format,
            claimIndexes,
            coverage: {
                version: 1,
                requirements: requirements.map(({ format: _format, text: _text, ...r }) => r),
            },
        };
        const names = [...new Set(requirements.map((r) => r.object).filter(Boolean))];
        const dimensions = [...new Set(requirements.filter((r) => r.object).map((r) => r.field))];
        const fieldValue = (r: (typeof requirements)[number] | undefined) => ({
            text: r?.text ?? '',
            claimIndexes: r?.claimIndexes ?? [],
            status: r?.status ?? ('unknown' as const),
            gap: r?.gap ?? '本次未取得该对象和字段的可核验回答。',
        });
        if (format === 'list' && names.length)
            artifact.content = {
                version: 1,
                list: {
                    entries: names.map((name, index) => ({
                        id: `o${index}`,
                        name,
                        fields: requirements
                            .filter((r) => r.object === name)
                            .map((r) => ({ id: r.id, label: r.field, ...fieldValue(r) })),
                    })),
                },
            };
        if (
            validPlan &&
            format === 'comparison' &&
            names.length &&
            dimensions.length &&
            names.length * dimensions.length <= 60
        )
            artifact.content = {
                version: 1,
                comparison: {
                    objects: names.map((name, index) => ({ id: `o${index}`, name })),
                    dimensions: dimensions.map((label, index) => ({ id: `d${index}`, label })),
                    cells: names.flatMap((name, oi) =>
                        dimensions.map((field, di) => ({
                            objectId: `o${oi}`,
                            dimensionId: `d${di}`,
                            ...fieldValue(
                                requirements.find((r) => r.object === name && r.field === field),
                            ),
                        })),
                    ),
                },
            };
        artifact.summary = primaryArtifactSummary(claims, {
            artifacts: [artifact],
            reportValue: value,
        });
        const missing = requirements.filter((r) => r.required && r.status !== 'supported');
        if (missing.length)
            artifact.summary =
                `${artifact.summary}\n\n尚有${missing.length}项所需信息未完整取得，详见覆盖说明。`.slice(
                    0,
                    2000,
                );
        return artifact;
    });
}
