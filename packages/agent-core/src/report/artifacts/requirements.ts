import { object } from '../../utils/guards.ts';
import { type ReportArtifact } from '@scova/models';

export type Format = ReportArtifact['format'];

export interface PlannedRequirement {
    id: string;
    format: Format;
    questionIds: string[];
    object: string;
    field: string;
    required: boolean;
    verification?: 'stable' | 'current' | 'exact' | 'source_required';
    /** Optional display grouping for list entries and comparison dimensions. */
    group?: string;
}

export function plannedRequirements(
    data: unknown,
    formats: Format[],
    questions: { id: string; text: string }[],
    validateStructure = true,
    completeCoveragePlan = false,
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
            typeof r.required !== 'boolean' ||
            (r.group !== undefined && (typeof r.group !== 'string' || r.group.length > 40)) ||
            (r.verification !== undefined &&
                (typeof r.verification !== 'string' ||
                    !['stable', 'current', 'exact', 'source_required'].includes(r.verification)))
        )
            return null;
        const { group, ...rest } = r as unknown as PlannedRequirement;
        result.push(group?.trim() ? { ...rest, group: group.trim() } : rest);
    }
    if (completeCoveragePlan) {
        // Freeze a deterministic projection before retrieval. Keep the actual model
        // receipt unchanged; duplicate cells combine obligations, never drop them.
        const projected: PlannedRequirement[] = [];
        for (const requirement of result) {
            const same =
                requirement.object &&
                projected.find(
                    (r) =>
                        r.format === requirement.format &&
                        r.object === requirement.object &&
                        r.field === requirement.field,
                );
            if (same) {
                same.questionIds = [...new Set([...same.questionIds, ...requirement.questionIds])];
                same.required ||= requirement.required;
                if (same.verification === 'stable' || !same.verification)
                    same.verification = requirement.verification;
            } else projected.push(structuredClone(requirement));
        }
        for (const format of formats)
            for (const question of questions) {
                const matches = projected.filter(
                    (r) => r.format === format && r.questionIds.includes(question.id),
                );
                if (matches.some((r) => r.required)) continue;
                if (matches.length) matches[0]!.required = true;
                else {
                    let suffix = 0;
                    while (projected.some((r) => r.id === `coverage-${format}-${suffix}`)) suffix++;
                    projected.push({
                        id: `coverage-${format}-${suffix}`,
                        format,
                        questionIds: [question.id],
                        object: '',
                        field: question.text,
                        required: true,
                    });
                }
            }
        return plannedRequirements(
            { requirements: projected },
            formats,
            questions,
            validateStructure,
        );
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

export function requirementPlanSchema(formats: Format[], questionIds: string[], classify = false) {
    const schema = {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'format', 'questionIds', 'object', 'field', 'required', 'group'],
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
                group: { type: 'string', maxLength: 40 },
            },
        },
    };
    if (classify) {
        schema.items.required.push('verification');
        Object.assign(schema.items.properties, {
            verification: {
                type: 'string',
                enum: ['stable', 'current', 'exact', 'source_required'],
            },
        });
    }
    return schema;
}
