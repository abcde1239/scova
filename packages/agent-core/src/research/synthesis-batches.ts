import type { TaskConfig } from '@scova/models';
import type { PlannedRequirement } from '../report/artifacts/index.ts';
import type { AgentPage } from '../types.ts';
import { searchRelevance } from '@scova/connectors';

export interface SynthesisBatch {
    format: TaskConfig['outputFormat'];
    requirements: PlannedRequirement[];
    maxClaims: number;
}

/** Stable plan: at most eight calls per pass; legacy executions share thirty claim slots. */
export function synthesisBatches(
    formats: TaskConfig['outputFormat'][],
    requirements: PlannedRequirement[],
    coverageDriven = false,
): SynthesisBatch[] {
    const batches = formats.flatMap((format) => {
        const entries = requirements.filter((r) => r.format === format);
        const count = Math.max(
            1,
            Math.min(Math.floor(8 / formats.length), Math.ceil(entries.length / 8)),
        );
        const size = Math.ceil(entries.length / count);
        return Array.from({ length: count }, (_, i) => ({
            format,
            requirements: entries.slice(i * size, (i + 1) * size),
            maxClaims: 0,
        }));
    });
    return batches.map((batch, index) => ({
        ...batch,
        maxClaims: coverageDriven
            ? Math.min(
                  batch.format === 'brief' ? 8 : 24,
                  Math.max(4, batch.requirements.length * 2),
              )
            : Math.min(
                  batch.format === 'brief' ? 24 : 30,
                  Math.floor(30 / batches.length) + (index < 30 % batches.length ? 1 : 0),
              ),
    }));
}

export function synthesisOperation(index: number, attempt: number) {
    return index === 0 ? `synthesize-${attempt}` : `synthesize-batch-${index}-${attempt}`;
}
export function isSynthesisOperation(operation: string, passes = 2, batches = 8) {
    const match =
        /^synthesize-(?:([0-9]|[1-5][0-9]|6[0-3])|batch-([1-9]|[1-5][0-9])-([0-9]|[1-5][0-9]|6[0-3]))$/.exec(
            operation,
        );
    return !!match && Number(match[1] ?? match[3]) < passes && Number(match[2] ?? 0) < batches;
}

/** Stable question groups keep retrieval scope aligned; only unresolved fields are requested later. */
export function fieldSynthesisBatches(
    formats: TaskConfig['outputFormat'][],
    requirements: PlannedRequirement[],
): SynthesisBatch[] {
    return formats.flatMap((format) => {
        const groups = new Map<string, PlannedRequirement[]>();
        for (const requirement of requirements.filter((r) => r.format === format)) {
            const key = JSON.stringify([...requirement.questionIds].sort());
            groups.set(key, [...(groups.get(key) ?? []), requirement]);
        }
        return [...groups.values()].flatMap((entries) =>
            Array.from({ length: Math.ceil(entries.length / 6) }, (_, i) => ({
                format,
                requirements: entries.slice(i * 6, (i + 1) * 6),
                maxClaims: Math.min(
                    format === 'brief' ? 8 : 24,
                    Math.max(
                        4,
                        entries
                            .slice(i * 6, (i + 1) * 6)
                            .reduce((n, r) => n + r.questionIds.length * 2, 0),
                    ),
                ),
            })),
        );
    });
}

/** Two passes per evidence set, with one further evidence set when coverage still has gaps. */
export const COVERAGE_PASSES = 4;

/** Scope stays attached to immutable reads; selection never grants new question IDs. */
export function synthesisBatchSources(batch: SynthesisBatch, pages: AgentPage[]) {
    const ids = new Set(batch.requirements.flatMap((r) => r.questionIds));
    const focus = batch.requirements.map((r) => `${r.object} ${r.field}`).join(' ');
    const ranked = pages
        .filter((p) => p.questionIds.some((id) => ids.has(id)))
        .sort(
            (a, b) =>
                searchRelevance(focus, { url: b.url, title: b.title, snippet: b.text }) -
                searchRelevance(focus, { url: a.url, title: a.title, snippet: a.text }),
        );
    const selected = new Set<AgentPage>();
    for (const id of ids) {
        const page = ranked.find((p) => p.questionIds.includes(id));
        if (page) selected.add(page);
    }
    for (const page of ranked) {
        if (selected.size >= Math.max(8, ids.size)) break;
        selected.add(page);
    }
    return [...selected];
}

export function coverageBatchLimits(
    inputTotal: number,
    outputTotal: number,
    count: number,
    consumed = 0,
    remainingBatches = count,
) {
    // Reclaim unused caps from committed receipts instead of dividing every batch by
    // four hypothetical full-length responses. The Worker fences actual cumulative usage.
    const output = Math.max(
        1,
        Math.floor((Math.max(0, outputTotal - consumed) * 0.8) / Math.max(1, remainingBatches)),
    );
    return {
        // A small Run must still fit the repeated prompt/schema overhead. Dividing its
        // entire input envelope by hypothetical calls can prevent even a short answer.
        input: Math.min(
            128_000,
            Math.max(
                1,
                Math.floor(
                    Math.max(Math.min(inputTotal * 0.6, 32_000), inputTotal / (count * 2 + 2)),
                ),
            ),
        ),
        initial: Math.min(16_000, output),
        repair: Math.min(24_000, output),
    };
}

/** Output reservations share one envelope; the ledger also fences cumulative actual input. */
export function synthesisBatchLimits(inputTotal: number, outputTotal: number, count: number) {
    const output = Math.max(1, Math.floor(outputTotal / count));
    return {
        // Prompt/schema overhead repeats per call; cumulative usage is fenced by the ledger.
        input: Math.min(256_000, Math.max(1, Math.floor(inputTotal * 0.6))),
        initial: Math.min(32_000, Math.max(1, Math.floor(output / 3))),
        repair: Math.min(64_000, Math.max(1, Math.floor((output * 2) / 3))),
    };
}

export function batchSynthesisSchema(
    base: Record<string, unknown>,
    batch: SynthesisBatch,
    questionIds: string[],
    pageIds: string[],
    coverageDriven = false,
    sharedQuestions = false,
) {
    type Leaf = { maximum: number };
    type Indexes = { items: Leaf };
    type Claim = {
        required: string[];
        properties: {
            outputFormat: object;
            questionIds: { items: object; maxItems?: number };
            citations: { maxItems?: number; items: { properties: { pageId: object } } };
        };
    };
    type Artifact = {
        properties: {
            format: object;
            requirements: {
                maxItems: number;
                items: { properties: { id: object; claimIndexes: Indexes } };
            };
            document: {
                anyOf: [
                    {
                        properties: {
                            sections: { items: { properties: { claimIndexes: Indexes } } };
                        };
                    },
                    unknown,
                ];
            };
        };
    };
    const schema = structuredClone(base) as Record<string, unknown> & {
        properties: {
            claims: { maxItems: number; items: Claim };
            artifacts?: { minItems: number; maxItems: number; items: Artifact };
        };
    };
    const claims = schema.properties.claims;
    claims.maxItems = batch.maxClaims;
    const item = claims.items;
    item.required = [...new Set([...item.required, 'assessment', 'outputFormat'])];
    item.properties.outputFormat = { type: 'string', enum: [batch.format] };
    item.properties.questionIds.items = {
        type: 'string',
        ...(questionIds.length ? { enum: questionIds } : {}),
    };
    if (!questionIds.length) item.properties.questionIds.maxItems = 0;
    if (coverageDriven)
        item.properties.questionIds.maxItems = sharedQuestions ? questionIds.length : 1;
    item.properties.citations.items.properties.pageId = {
        type: 'string',
        ...(pageIds.length ? { enum: pageIds } : {}),
    };
    if (!pageIds.length) item.properties.citations.maxItems = 0;
    const artifacts = schema.properties.artifacts;
    if (artifacts) {
        artifacts.minItems = artifacts.maxItems = 1;
        artifacts.items.properties.format = { type: 'string', enum: [batch.format] };
        const requirements = artifacts.items.properties.requirements;
        requirements.maxItems = batch.requirements.length;
        requirements.items.properties.id = {
            type: 'string',
            ...(batch.requirements.length ? { enum: batch.requirements.map((r) => r.id) } : {}),
        };
        requirements.items.properties.claimIndexes.items.maximum = batch.maxClaims - 1;
        const document = artifacts.items.properties.document.anyOf[0];
        document.properties.sections.items.properties.claimIndexes.items.maximum =
            batch.maxClaims - 1;
    }
    return schema;
}
