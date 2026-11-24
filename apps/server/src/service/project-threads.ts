import {
    PROJECT_THREAD_PAGE_SIZE,
    type CreateProjectThread,
    type ProjectThread,
    type ProjectThreadItem,
    type ProjectThreadSnapshot,
    type UpdateProjectThread,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectConversationStore } from '@/repo/project-conversations.ts';
import { createProjectThreadStore } from '@/repo/project-threads.ts';
import { createProjectStore } from '@/repo/projects.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid } from '@/utils/security.ts';

const notFound = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
type Store = ReturnType<typeof createProjectThreadStore>;

function describeThread(row: NonNullable<Awaited<ReturnType<Store['find']>>>): ProjectThread {
    return {
        id: row.id,
        projectId: row.projectId,
        isDefault: row.isDefault,
        title: row.title,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        lastActivityAt: row.lastActivityAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
    };
}
function describeItem(row: Awaited<ReturnType<Store['items']>>[number]): ProjectThreadItem {
    const { userId: _owner, ...item } = row;
    return { ...item, createdAt: item.createdAt.toISOString() };
}

export function createProjectThreadService(services: ApiServices) {
    const store = (userId: string) => createProjectThreadStore(services.db(), userId);
    async function requireThread(userId: string, threadId: string) {
        const thread = await store(userId).find(threadId);
        if (!thread) throw notFound();
        return describeThread(thread);
    }
    async function describeItems(
        userId: string,
        projectId: string,
        rows: Awaited<ReturnType<Store['items']>>,
    ) {
        const result = rows.map(describeItem);
        const reportId = (ref: unknown) => {
            if (!ref || typeof ref !== 'object' || !('kind' in ref)) return undefined;
            const id =
                ref.kind === 'report' && 'id' in ref
                    ? ref.id
                    : ref.kind === 'source' && 'reportId' in ref
                      ? ref.reportId
                      : undefined;
            return typeof id === 'string' && isUuid(id) ? id.toLowerCase() : undefined;
        };
        const ids = [
            ...new Set(result.flatMap((item) => item.refs.flatMap((ref) => reportId(ref) ?? []))),
        ];
        if (!ids.length) return result;
        const legacy = createProjectConversationStore(services.db(), userId, projectId);
        const visible = new Set(await legacy.visibleReportIds(ids));
        return result.map((item) => {
            const refs = item.refs.filter((ref) => {
                const id = reportId(ref);
                return !id || visible.has(id);
            });
            if (refs.length === item.refs.length) return item;
            if (item.payload.role === 'user') return { ...item, refs };
            return {
                ...item,
                kind:
                    item.kind === 'plan' || item.kind === 'schedule'
                        ? ('disambiguation' as const)
                        : item.kind,
                payload:
                    item.kind === 'report'
                        ? { runId: item.payload.runId, unavailable: true }
                        : { role: 'assistant', text: '原引用报告已移出项目。' },
                refs: [],
            };
        });
    }
    async function items(userId: string, threadId: string, after: number, limit: number) {
        const thread = await requireThread(userId, threadId);
        return describeItems(
            userId,
            thread.projectId,
            await store(userId).items(threadId, after, limit),
        );
    }
    return {
        async list(userId: string, projectId: string) {
            if (!(await createProjectStore(services.db()).find(userId, projectId)))
                throw notFound();
            return { items: (await store(userId).list(projectId)).map(describeThread) };
        },
        async create(userId: string, projectId: string, input: CreateProjectThread) {
            return services.db().transaction(async (tx) => {
                if (!(await createProjectStore(tx).lockProject(userId, projectId)))
                    throw notFound();
                const thread = await createProjectThreadStore(tx, userId).create(
                    projectId,
                    input.title?.trim() ?? '新会话',
                    services.clock(),
                );
                if (!thread) throw new Error('创建会话失败');
                return describeThread(thread);
            });
        },
        async update(userId: string, threadId: string, input: UpdateProjectThread) {
            const thread = await store(userId).update(
                threadId,
                { ...input, title: input.title?.trim() },
                services.clock(),
            );
            if (!thread) throw notFound();
            return describeThread(thread);
        },
        async snapshot(
            userId: string,
            threadId: string,
            input: { after?: number; limit?: number } = {},
        ): Promise<ProjectThreadSnapshot> {
            const { after = 0, limit = PROJECT_THREAD_PAGE_SIZE } = input;
            const thread = await requireThread(userId, threadId);
            const rows = await store(userId).items(threadId, after, limit + 1);
            const page = rows.slice(0, limit);
            return {
                thread,
                items: await describeItems(userId, thread.projectId, page),
                lastSeq: page.at(-1)?.seq ?? after,
                hasMore: rows.length > limit,
            };
        },
        items,
        requireThread,
    };
}
