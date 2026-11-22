import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import { eq, toolCalls as dbToolCalls } from '@scova/db';
import { expect, it } from 'vite-plus/test';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { setup, search, takeover, fixture, usage } from './fixture.ts';

export function registerLeaseFencing() {
    it('C14-ST02 接管把在途变 unknown，旧 epoch settle 拒绝且无法污染新结果', async () => {
        const seed = await setup();
        const old = await seed.repo.reserve(search('interrupted'));
        const next = await takeover(seed.run.id);
        expect(await next.repo.markInterruptedUnknown()).toBe(1);
        expect(await next.repo.markInterruptedUnknown()).toBe(0);
        const retried = await next.repo.reserve(search('interrupted'));
        expect(retried).toMatchObject({ attemptNo: 2, usage: { searches: 2 } });
        expect(await next.repo.markInterruptedUnknown()).toBe(0);
        await expect(
            seed.repo.settle({ toolCallId: old.toolCallId, output: { stale: true } }),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await expect(
            next.repo.settle({ toolCallId: old.toolCallId, output: { stale: true } }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
        await next.repo.settle({ toolCallId: retried.toolCallId, output: { current: true } });
        expect(await next.repo.reserve(search('interrupted'))).toMatchObject({
            kind: 'reused',
            output: { current: true },
        });
        expect(
            await fixture.db.query.toolCalls
                .findFirst({ where: eq(dbToolCalls.id, old.toolCallId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ status: 'unknown', outputRef: null });
    });

    it('C14-ERR05 不同 owner 的相同 operationKey 不复用结果，工具id与伪造token均隔离', async () => {
        const first = await setup();
        const other = await setup();
        const held = await first.repo.reserve(search('shared-key'));
        await first.repo.settle({
            toolCallId: held.toolCallId,
            output: { private: first.user.id },
        });
        const page = await first.repo.reserve({
            operationKey: 'private-page',
            tool: 'read',
            reserved: usage({ pages: 1 }),
        });
        await first.repo.settle({
            toolCallId: page.toolCallId,
            output: { private: 'owner-only-evidence' },
        });
        expect(await other.repo.reserve(search('shared-key'))).toMatchObject({
            kind: 'reserved',
            attemptNo: 1,
            usage: { searches: 1 },
        });
        await expect(
            other.repo.settle({ toolCallId: held.toolCallId, output: { overwritten: true } }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_CALL' });
        expect(await other.repo.readPages()).toEqual([]);
        const forged = createAgentRepository(fixture.db, {
            ...first.current.token,
            userId: other.user.id,
        });
        await expect(forged.reserve(search('forged'))).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(forged.readAuthorizedCheckpoint()).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(forged.comparison({ allowDeadline: true })).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        await expect(forged.readPages({ allowDeadline: true })).rejects.toMatchObject({
            code: 'LEASE_LOST',
        });
        expect(await first.repo.reserve(search('shared-key'))).toMatchObject({
            kind: 'reused',
            output: { private: first.user.id },
        });
    });

    it('C14-E03 仅可信实际 token 结算退差额，estimated 与超额结果不释放预留', async () => {
        const seed = await setup();
        const reserveModel = (operationKey: string) =>
            seed.repo.reserve({
                operationKey,
                tool: 'model',
                reserved: usage({ inputTokens: 100, outputTokens: 40 }),
            });
        const first = await reserveModel('model:actual');
        await seed.repo.settle({
            toolCallId: first.toolCallId,
            output: { ok: true },
            actualUsage: usage({ inputTokens: 60, outputTokens: 20, estimated: false }),
        });
        const second = await reserveModel('model:estimated');
        await seed.repo.settle({
            toolCallId: second.toolCallId,
            output: { ok: true },
            actualUsage: usage({ inputTokens: 1, outputTokens: 1 }),
        });
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 160, outputTokens: 60 });
        const third = await reserveModel('model:invalid');
        await expect(
            seed.repo.settle({
                toolCallId: third.toolCallId,
                output: {},
                actualUsage: usage({ inputTokens: 101, outputTokens: 1, estimated: false }),
            }),
        ).rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT' });
        expect(await seed.repo.usage()).toMatchObject({ inputTokens: 260, outputTokens: 100 });
        expect(
            await fixture.db.query.toolCalls
                .findFirst({ where: eq(dbToolCalls.id, third.toolCallId) })
                .then((row) => requiredDatabaseValue(row)),
        ).toMatchObject({ status: 'running', outputRef: null });
    });
}
