import { createHash } from 'node:crypto';
import type { AgentCandidate, ComparisonExtraction } from '../types.ts';
import type { GapAction } from './loop.ts';
import { evidenceLinks } from '../evidence/links.ts';
import { object } from '../utils/guards.ts';
import type { PlannedRequirement } from '../report/artifacts/index.ts';

export type GapTarget = {
    requirementId: string;
    questionIds: string[];
    action: GapAction;
    query: string;
    url?: string;
};
export type GapProgress = {
    supported: string[];
    bodies: string[];
    linkCount: number;
    targetLinks?: string[];
};
export type GapAttempt = {
    fingerprint: string;
    requirementId: string;
    action: GapAction;
    before: GapProgress;
    gain?: boolean;
};
export type GapLoop = {
    history: GapAttempt[];
    cursor: number;
    target?: GapTarget;
    pending?: number;
    stopped?: boolean;
    skipSynthesis?: boolean;
};
export const GAP_LOOP_PASSES = 64;
export const MAX_GAP_ACTIONS = 60;

// A one-call budget cannot reserve a later call without starving initial discovery.
export const initialSearchLimit = (maxSearches: number) =>
    Math.min(10, Math.max(1, maxSearches - 2), maxSearches);
export const initialReadLimit = (maxPages: number) =>
    Math.min(maxPages, Math.max(1, Math.floor(Math.min(20, maxPages) * 0.6)));

export function validGapLoop(
    value: unknown,
    requirements: PlannedRequirement[],
    questionCount: number,
    quality = false,
) {
    if (
        !object(value) ||
        !Array.isArray(value.history) ||
        value.history.length > MAX_GAP_ACTIONS ||
        !Number.isInteger(value.cursor) ||
        Number(value.cursor) < 0 ||
        Number(value.cursor) >= questionCount ||
        (value.stopped !== undefined && typeof value.stopped !== 'boolean') ||
        (value.skipSynthesis !== undefined && typeof value.skipSynthesis !== 'boolean')
    )
        return false;
    const action = (v: unknown) =>
        ['repair', 'rebind', 'search', 'conflict', ...(quality ? ['read'] : [])].includes(
            String(v),
        );
    const strings = (v: unknown, max: number) =>
        Array.isArray(v) &&
        v.length <= max &&
        v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 80);
    if (
        value.history.some(
            (h) =>
                !object(h) ||
                typeof h.fingerprint !== 'string' ||
                !/^[a-f0-9]{64}$/.test(h.fingerprint) ||
                !action(h.action) ||
                !requirements.some((r) => r.id === h.requirementId) ||
                (h.gain !== undefined && typeof h.gain !== 'boolean') ||
                !object(h.before) ||
                !strings(h.before.supported, 60) ||
                !strings(h.before.bodies, 20) ||
                (h.before.targetLinks !== undefined &&
                    (!quality || !strings(h.before.targetLinks, 7680))) ||
                !Number.isInteger(h.before.linkCount) ||
                Number(h.before.linkCount) < 0 ||
                Number(h.before.linkCount) > 7680,
        )
    )
        return false;
    if (new Set(value.history.map((h) => h.fingerprint)).size !== value.history.length)
        return false;
    if (value.target !== undefined) {
        const target = value.target;
        if (
            !object(target) ||
            !action(target.action) ||
            typeof target.query !== 'string' ||
            (target.action === 'read' &&
                (typeof target.url !== 'string' ||
                    target.url.length > 4000 ||
                    !/^https?:\/\//.test(target.url))) ||
            (target.action !== 'read' && target.url !== undefined) ||
            target.query.length > 200 ||
            !strings(target.questionIds, 20) ||
            !requirements.some(
                (r) =>
                    r.id === target.requirementId &&
                    JSON.stringify(r.questionIds) === JSON.stringify(target.questionIds),
            )
        )
            return false;
    }
    return (
        value.pending === undefined ||
        (Number.isInteger(value.pending) &&
            value.pending === value.history.length - 1 &&
            Number(value.pending) >= 0 &&
            value.history[Number(value.pending)]?.gain === undefined &&
            object(value.target) &&
            value.history[Number(value.pending)]?.requirementId === value.target.requirementId &&
            value.history[Number(value.pending)]?.action === value.target.action)
    );
}

export function gapProgress(
    candidate: AgentCandidate,
    receipts: ComparisonExtraction[],
    requirementId?: string,
): GapProgress {
    const links =
        candidate.coverage.propositions?.flatMap((p) =>
            (!requirementId || p.requirementIds.includes(requirementId)) && p.support !== 'none'
                ? p.passages.map((s) =>
                      createHash('sha256')
                          .update(JSON.stringify([s.pageId, s.contentHash, s.start, s.end]))
                          .digest('hex'),
                  )
                : [],
        ) ?? [];
    return {
        supported: (candidate.coverage.artifacts ?? []).flatMap((a) =>
            (a.coverage?.requirements ?? [])
                .filter((r) => r.status === 'supported')
                .map((r) => r.id),
        ),
        bodies: [...new Set(candidate.pages.map((p) => p.contentHash))].sort(),
        linkCount: new Set(
            evidenceLinks(
                receipts,
                candidate.pages,
                candidate.coverage.reportValue?.questions.map((q) => q.id) ?? [],
            ).map((l) => JSON.stringify([l.pageId, l.questionId, l.quote])),
        ).size,
        ...(requirementId ? { targetLinks: [...new Set(links)].sort() } : {}),
    };
}
export function gained(before: GapProgress, after: GapProgress, requirementId?: string) {
    if (requirementId)
        return (
            (!before.supported.includes(requirementId) &&
                after.supported.includes(requirementId)) ||
            (after.targetLinks ?? []).some((link) => !before.targetLinks?.includes(link))
        );
    return (
        after.linkCount > before.linkCount ||
        (['supported', 'bodies'] as const).some((key) =>
            after[key].some((value) => !before[key].includes(value)),
        )
    );
}
export function gapFingerprint(target: GapTarget, candidate: AgentCandidate, errors: string[]) {
    return createHash('sha256')
        .update(
            JSON.stringify([
                target.requirementId,
                target.action,
                target.query.trim().replace(/\s+/g, ' ').toLowerCase(),
                ...(target.url ? [target.url] : []),
                candidate.pages
                    .map((p) => [p.url, p.contentHash])
                    .sort((a, b) => a[0]!.localeCompare(b[0]!)),
                candidate.coverage.propositions?.flatMap((p) =>
                    p.passages.map((s) => [s.pageId, s.contentHash, s.start, s.end]),
                ) ?? [],
                [...new Set(errors)].sort(),
            ]),
        )
        .digest('hex');
}

/** Core obligations first; rotate questions within each priority rather than retrying q0. */
export function chooseGap(
    actions: GapTarget[],
    memory: GapLoop,
    candidate: AgentCandidate,
    errors: string[],
) {
    const questions = candidate.coverage.reportValue?.questions ?? [];
    const order = questions.map((q) => q.id);
    const core = new Set(questions.filter((q) => q.priority === 'core').map((q) => q.id));
    return actions
        .map((action) => ({ action, fingerprint: gapFingerprint(action, candidate, errors) }))
        .filter(
            ({ action, fingerprint }) =>
                !memory.history.some((h) => h.fingerprint === fingerprint) &&
                memory.history.filter(
                    (h) => h.requirementId === action.requirementId && h.gain === false,
                ).length < 2,
        )
        .sort((a, b) => {
            const priority = (t: GapTarget) => Number(t.questionIds.some((id) => core.has(id)));
            const distance = (t: GapTarget) =>
                Math.min(
                    ...t.questionIds.map((id) => {
                        const index = order.indexOf(id);
                        return index < 0
                            ? order.length
                            : (index - memory.cursor + order.length) % order.length;
                    }),
                );
            return (
                priority(b.action) - priority(a.action) || distance(a.action) - distance(b.action)
            );
        })[0];
}
