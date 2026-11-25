import { createHash } from 'node:crypto';
import type { WorkspaceHome, WorkspaceIntakeInput, WorkspaceIntakeResult } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectThreadStore } from '@/repo/project-threads';
import { createProjectStore } from '@/repo/projects';
import { createRunStore } from '@/repo/runs';
import { createWorkspaceIntakeStore } from '@/repo/workspace-intake';
import { ApiError } from '@/utils/errors';

type Destination = { id: string; name: string };
const scope = 'workspace:intake';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalized = (value: string) =>
    value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const notFound = () => new ApiError(404, 'NOT_FOUND', '资源不存在');

function matchProjectDestinations(message: string, projects: Destination[]) {
    const text = normalized(message);
    if (
        /(?:不要|别|不能|不想|先不要|排除|暂不|不要选|让我选择|不在|不归入|不放到)|\b(?:not|never|exclude|avoid|except|do not|don['’]t|let me choose)\b/iu.test(
            text,
        )
    )
        return [];
    return projects.filter((project) => {
        const name = normalized(project.name);
        if (!name) return false;
        if (text === name) return true;
        const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const quotes = [
            ['「', '」'],
            ['『', '』'],
            ['“', '”'],
            ['"', '"'],
        ];
        if (quotes.some(([open, close]) => text.includes(`${open}${name}${close}`))) return true;
        const letters = name.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
        const han = /\p{Script=Han}/u;
        if (letters < (han.test(name) ? 4 : 3)) return false;
        // A Latin or numeric edge must end at a word boundary. Han text need not use spaces.
        const boundary = String.raw`[^\p{L}\p{N}]|\p{Script=Han}`;
        const start = han.test(name[0]!) ? '' : `(^|${boundary})`;
        const end = han.test(name.at(-1)!) ? '' : `($|${boundary})`;
        return new RegExp(`${start}${literal}${end}`, 'u').test(text);
    });
}

export function createWorkspaceIntakeService(services: ApiServices) {
    return {
        async home(userId: string): Promise<WorkspaceHome> {
            const store = createWorkspaceIntakeStore(services.db(), userId);
            const [recent, pending] = await Promise.all([
                store.recentProjects(),
                store.pendingPlans(),
            ]);
            return {
                recentProjects: recent.map((project) => ({
                    ...project,
                    createdAt: project.createdAt.toISOString(),
                    lastActivityAt: project.lastActivityAt.toISOString(),
                })),
                pending,
            };
        },
        async intake(
            userId: string,
            input: WorkspaceIntakeInput,
            key: string,
        ): Promise<WorkspaceIntakeResult> {
            const target = input.destination;
            const destination =
                target.kind === 'new-project' ? { ...target, name: target.name.trim() } : target;
            const identity =
                destination.kind === 'project'
                    ? destination.projectId
                    : destination.kind === 'new-project'
                      ? destination.name
                      : null;
            const payloadHash = hash(
                JSON.stringify([input.message.trim(), destination.kind, identity]),
            );
            const keyHash = hash(key);
            const now = services.clock();
            return services.db().transaction(async (tx) => {
                const receipts = createRunStore(tx);
                const projectStore = createProjectStore(tx);
                const threads = createProjectThreadStore(tx, userId);
                const ready = (thread: { id: string; projectId: string }, turnId: string) =>
                    ({
                        kind: 'ready',
                        projectId: thread.projectId,
                        threadId: thread.id,
                        turnId,
                    }) as const;
                async function replay() {
                    const receipt = await receipts.findIdempotency(userId, scope, keyHash);
                    if (!receipt) return undefined;
                    if (receipt.payloadHash !== payloadHash)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_CONFLICT',
                            '此提交标识已用于另一条输入',
                        );
                    if (receipt.status !== 'completed' || !receipt.resourceId)
                        throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', '此提交正在处理中');
                    const thread = await threads.find(receipt.resourceId);
                    if (!thread) throw notFound();
                    return ready(thread, receipt.id);
                }

                const existing = await replay();
                if (existing) return existing;
                let projectId;
                if (destination.kind === 'auto') {
                    const projects = await createWorkspaceIntakeStore(tx, userId).destinations();
                    const matches = matchProjectDestinations(input.message, projects);
                    if (matches.length !== 1)
                        return {
                            kind: 'choose-project',
                            candidates: (matches.length ? matches : projects).slice(0, 5),
                        };
                    projectId = matches[0]!.id;
                } else if (destination.kind === 'project') projectId = destination.projectId;

                const reservation = await receipts.reserveIdempotency({
                    userId,
                    scope,
                    keyHash,
                    payloadHash,
                    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                });
                if (!reservation) {
                    const replayed = await replay();
                    if (!replayed) throw new Error('会话提交回执不存在');
                    return replayed;
                }
                if (destination.kind === 'new-project')
                    projectId = (await projectStore.create(userId, destination.name)).id;
                else if (!projectId || !(await projectStore.lockProject(userId, projectId)))
                    throw notFound();
                if (!projectId) throw new Error('会话所属项目不存在');
                const thread = await threads.create(projectId, '新会话', now);
                if (!thread) throw new Error('创建会话失败');
                await receipts.completeIdempotency(reservation.id, thread.id, 200);
                return ready(thread, reservation.id);
            });
        },
    };
}
