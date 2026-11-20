import { createHash } from 'node:crypto';
import {
    CreateProjectInputSchema,
    InstantSchema,
    PageQuerySchema,
    ProjectDetailResponseSchema,
    ProjectListResponseSchema,
    UuidSchema,
    parseContract,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectStore, type ProjectCursor } from '@/repo/projects';
import { ApiError } from '@/utils/errors.ts';

const recentLimit = 5;
const notFound = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
const projectItem = (row: { id: string; name: string; createdAt: Date }) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
});

function pageOptions(userId: string, projectId: string | null, input: unknown) {
    const { cursor: token, limit } = parseContract(PageQuerySchema, input);
    const scope = createHash('sha256')
        .update(JSON.stringify(['projects', userId, projectId]))
        .digest('hex');
    let cursor: ProjectCursor | undefined;
    if (token) {
        try {
            const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
            if (
                parsed.scope !== scope ||
                typeof parsed.time !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.time)
            )
                throw new Error('Invalid project cursor');
            cursor = {
                id: parseContract(UuidSchema, parsed.id),
                time: parseContract(InstantSchema, parsed.time),
            };
        } catch {
            throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效或与查询范围不一致');
        }
    }
    const take = Math.min(limit ?? 50, 100);
    return {
        cursor,
        take,
        nextCursor(rows: { id: string; cursorTime: string }[]) {
            if (rows.length <= take) return null;
            const { id, cursorTime } = rows[take - 1]!;
            return Buffer.from(JSON.stringify({ id, time: cursorTime, scope })).toString(
                'base64url',
            );
        },
    };
}

export function createProjectService({ db }: Pick<ApiServices, 'db'>) {
    const store = () => createProjectStore(db());
    return {
        async create(userId: string, input: unknown) {
            const { name } = parseContract(CreateProjectInputSchema, input);
            return projectItem(await store().create(userId, name.trim()));
        },
        async list(userId: string, query: unknown) {
            const page = pageOptions(userId, null, query);
            const rows = await store().list(userId, page.take + 1, page.cursor);
            return parseContract(ProjectListResponseSchema, {
                items: rows.slice(0, page.take).map(projectItem),
                nextCursor: page.nextCursor(rows),
            });
        },
        detail(userId: string, projectId: string, query: unknown) {
            return db().transaction(
                async (tx) => {
                    const projectStore = createProjectStore(tx);
                    const project = await projectStore.find(userId, projectId);
                    if (!project) throw notFound();
                    const page = pageOptions(userId, project.id, query);
                    const rows = await projectStore.listTasks(
                        userId,
                        project.id,
                        page.take + 1,
                        page.cursor,
                    );
                    const recentRuns = await projectStore.recentRuns(
                        userId,
                        project.id,
                        recentLimit,
                    );
                    const recentReports = await projectStore.recentReports(
                        userId,
                        project.id,
                        recentLimit,
                    );
                    return parseContract(ProjectDetailResponseSchema, {
                        project: projectItem(project),
                        tasks: {
                            items: rows
                                .slice(0, page.take)
                                .map(({ id, title, status, nextRunAt }) => ({
                                    id,
                                    title,
                                    status,
                                    nextRunAt: nextRunAt?.toISOString() ?? null,
                                })),
                            nextCursor: page.nextCursor(rows),
                        },
                        recentRuns: recentRuns.map((run) => ({
                            ...run,
                            queuedAt: run.queuedAt.toISOString(),
                        })),
                        recentReports: recentReports.map((report) => ({
                            ...report,
                            publishedAt: report.publishedAt.toISOString(),
                        })),
                    });
                },
                { isolationLevel: 'repeatable read', accessMode: 'read only' },
            );
        },
        async remove(userId: string, projectId: string) {
            if (!(await store().remove(userId, projectId))) throw notFound();
        },
        async setMembership(userId: string, projectId: string, taskId: string, associate: boolean) {
            await db().transaction(async (tx) => {
                const projectStore = createProjectStore(tx);
                if (!(await projectStore.lockProject(userId, projectId))) throw notFound();
                if (!(await projectStore.lockTask(userId, taskId))) throw notFound();
                if (associate) await projectStore.associate(userId, projectId, taskId);
                else await projectStore.unlink(userId, projectId, taskId);
            });
        },
    };
}
