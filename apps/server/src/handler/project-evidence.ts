import type { Context } from 'elysia';
import type { ApiServices } from '@/app/services';
import { requireSession } from '@/handler/http/session.ts';
import { createProjectEvidenceService } from '@/service/project-evidence.ts';

type ProjectContext<Params = object> = Pick<Context, 'request' | 'set'> & {
    params: { projectId: string } & Params;
};

export function createProjectEvidenceHandlers(services: ApiServices) {
    const evidence = createProjectEvidenceService(services);
    async function authenticate({ request, set }: ProjectContext) {
        const session = await requireSession(request, services);
        set.headers['cache-control'] = 'private, no-store';
        return session;
    }
    return {
        async search(this: void, context: ProjectContext & { query: unknown }) {
            const session = await authenticate(context);
            return evidence.search(session.userId, context.params.projectId, context.query);
        },
        async report(this: void, context: ProjectContext<{ reportId: string }>) {
            const session = await authenticate(context);
            const { projectId, reportId } = context.params;
            return evidence.report(session.userId, projectId, reportId);
        },
        async source(
            this: void,
            context: ProjectContext<{ reportId: string; snapshotId: string }>,
        ) {
            const session = await authenticate(context);
            const { projectId, reportId, snapshotId } = context.params;
            return evidence.source(session.userId, projectId, reportId, snapshotId);
        },
    };
}
