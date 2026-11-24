import type { DatabaseExecutor } from '@scova/db';
import {
    parseContract,
    PROJECT_REPORT_SEARCH_QUERY_LIMIT,
    ProjectReportSearchQuerySchema,
    type ProjectReportEvidence,
    type ProjectReportEvidenceSearch,
    type ProjectSourceEvidence,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectConversationStore } from '@/repo/project-conversations.ts';
import { createProjectEvidenceStore } from '@/repo/project-evidence.ts';
import { createProjectThreadStore } from '@/repo/project-threads.ts';
import { createProjectStore } from '@/repo/projects.ts';
import { projectResourceMissing, readProjectSettings } from '@/service/project-settings.ts';
import { isUuid } from '@/utils/security.ts';

type Store = ReturnType<typeof createProjectEvidenceStore>;
type SourceContextRef = { reportId: string; snapshotId: string };
type History = { role: 'user' | 'assistant'; text: string };
export type ProjectEvidenceContextInput = {
    threadId: string;
    reportIds?: readonly string[];
    sourceRefs?: readonly SourceContextRef[];
    query?: string;
    beforeTool?: (tool: 'read_report' | 'read_source' | 'search_reports') => void;
};
const historyLimit = 6;
const explicitLimit = 3;
const discoveredLimit = 2;
const dependencyLimit = 12;
const queryWords = new Intl.Segmenter('zh', { granularity: 'word' });
const queryStopWords = new Set([
    '一下',
    '帮我',
    '能否',
    '可以',
    '总结',
    '概括',
    '整理',
    '梳理',
    '关于',
    '已有',
    '研究',
    '报告',
    '结论',
    '结果',
    '项目',
    '哪些',
    '什么',
    '信息',
    '资料',
    '查看',
    '之前',
    '告诉',
    'the',
    'and',
    'about',
    'please',
    'summarize',
    'summary',
    'find',
    'show',
    'report',
    'reports',
    'research',
    'results',
    'project',
    'existing',
    'what',
    'which',
    'information',
]);

function reportQueryTerms(message: string) {
    const keywords = Array.from(queryWords.segment(message))
        .filter(
            ({ segment, isWordLike }) =>
                isWordLike && segment.length >= 2 && !queryStopWords.has(segment.toLowerCase()),
        )
        .map(({ segment }) => segment.toLowerCase());
    return [...new Set([message.toLowerCase(), ...keywords])].slice(0, 8);
}

const projectReport = <T extends { publishedAt: Date }>(row: T) => ({
    ...row,
    publishedAt: row.publishedAt.toISOString(),
});
const projectSource = (
    row: NonNullable<Awaited<ReturnType<Store['source']>>>,
): ProjectSourceEvidence => ({
    ...row,
    publishedAt: row.publishedAt?.toISOString() ?? null,
});

function reportDependencies(refs: readonly unknown[]) {
    const ids: string[] = [];
    for (const ref of refs) {
        if (!ref || typeof ref !== 'object' || !('kind' in ref)) continue;
        if (ref.kind === 'report' || ref.kind === 'source') {
            const id =
                ref.kind === 'report' && 'id' in ref
                    ? ref.id
                    : 'reportId' in ref
                      ? ref.reportId
                      : undefined;
            if (typeof id !== 'string' || !isUuid(id)) return;
            ids.push(id.toLowerCase());
        }
    }
    return [...new Set(ids)];
}

export async function requireVisibleProjectEvidence(
    db: DatabaseExecutor,
    userId: string,
    projectId: string,
    refs: readonly unknown[],
) {
    const ids = reportDependencies(refs);
    if (
        !ids ||
        (ids.length &&
            (await createProjectConversationStore(db, userId, projectId).visibleReportIds(ids))
                .length !== ids.length)
    )
        throw projectResourceMissing();
}

/** Uses the caller's transaction when provided. Revalidate reportRefs before publishing generated output. */
export async function buildProjectEvidenceContext(
    db: DatabaseExecutor,
    userId: string,
    projectId: string,
    input: ProjectEvidenceContextInput,
    now: Date,
) {
    const evidence = createProjectEvidenceStore(db, userId, projectId);
    const threads = createProjectThreadStore(db, userId);
    if (!isUuid(input.threadId) || (await threads.find(input.threadId))?.projectId !== projectId)
        throw projectResourceMissing();

    const reportIds = input.reportIds ?? [];
    const sourceRefs = input.sourceRefs ?? [];
    if (
        reportIds.length + sourceRefs.length > explicitLimit ||
        reportIds.some((id) => !isUuid(id)) ||
        sourceRefs.some(({ reportId, snapshotId }) => !isUuid(reportId) || !isUuid(snapshotId))
    )
        throw projectResourceMissing();

    const reports = new Map<string, NonNullable<Awaited<ReturnType<Store['report']>>>>();
    const reportRefs = new Set<string>();
    const settings = await readProjectSettings(db, userId, projectId);
    const wantedReports = [...new Set(reportIds.map((id) => id.toLowerCase()))];
    if (wantedReports.length) {
        input.beforeTool?.('read_report');
        const rows = await evidence.reports(wantedReports);
        if (rows.length !== wantedReports.length) throw projectResourceMissing();
        for (const row of rows) {
            reports.set(row.id, row);
            reportRefs.add(row.id);
        }
    }
    const sources: ProjectSourceEvidence[] = [];
    for (const ref of sourceRefs) {
        input.beforeTool?.('read_source');
        const row = await evidence.source(ref.reportId, ref.snapshotId, now);
        if (!row) throw projectResourceMissing();
        sources.push(projectSource(row));
        reportRefs.add(row.reportId);
    }
    const query = input.query?.trim().slice(0, PROJECT_REPORT_SEARCH_QUERY_LIMIT);
    if (query) input.beforeTool?.('search_reports');
    const discovered = query ? await evidence.search(reportQueryTerms(query), discoveredLimit) : [];
    for (const { matchingClaim: _claim, matchingSource: _source, ...row } of discovered) {
        reportRefs.add(row.id);
        reports.set(row.id, row);
    }

    const candidates = (await threads.recentItems(input.threadId, historyLimit)).map((item) => ({
        role: item.payload.role,
        text: item.payload.text,
        dependencies:
            item.refs.length <= dependencyLimit ? reportDependencies(item.refs) : undefined,
    }));
    const ids = [...new Set(candidates.flatMap(({ dependencies }) => dependencies ?? []))];
    const visible = new Set(
        await createProjectConversationStore(db, userId, projectId).visibleReportIds(ids),
    );
    const history: History[] = [];
    for (const { role, text, dependencies } of candidates) {
        if (
            (role !== 'user' && role !== 'assistant') ||
            typeof text !== 'string' ||
            !dependencies?.every((id) => visible.has(id))
        )
            continue;
        const additional = dependencies.filter((id) => !reportRefs.has(id));
        if (reportRefs.size + additional.length > dependencyLimit) continue;
        history.push({ role, text: text.slice(0, 400) });
        for (const id of additional) reportRefs.add(id);
    }
    return {
        settings,
        history: history.reverse(),
        reports: [...reports.values()].map(projectReport),
        matches: discovered.map(projectReport),
        sources,
        reportRefs: [...reportRefs].map((id) => ({ kind: 'report' as const, id })),
    };
}

export function createProjectEvidenceService(services: ApiServices) {
    return {
        async search(
            userId: string,
            projectId: string,
            input: unknown,
        ): Promise<ProjectReportEvidenceSearch> {
            const { q, limit } = parseContract(ProjectReportSearchQuerySchema, input);
            const db = services.db();
            if (!(await createProjectStore(db).find(userId, projectId)))
                throw projectResourceMissing();
            const result = await createProjectEvidenceStore(db, userId, projectId).search(
                q.trim(),
                Number(limit ?? 5),
            );
            return { items: result.map(projectReport) };
        },
        async report(
            userId: string,
            projectId: string,
            reportId: string,
        ): Promise<ProjectReportEvidence> {
            const store = createProjectEvidenceStore(services.db(), userId, projectId);
            const report = await store.report(reportId);
            if (!report) throw projectResourceMissing();
            return { ...projectReport(report), sources: await store.listSources(reportId) };
        },
        async source(
            userId: string,
            projectId: string,
            reportId: string,
            snapshotId: string,
        ): Promise<ProjectSourceEvidence> {
            const row = await createProjectEvidenceStore(services.db(), userId, projectId).source(
                reportId,
                snapshotId,
                services.clock(),
            );
            if (!row) throw projectResourceMissing();
            return projectSource(row);
        },
    };
}
