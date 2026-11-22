import { requiredDatabaseValue } from '../../../server/src/utils/execution/database.ts';
import {
    reports as dbReports,
    eq,
    count as dbCount,
    evidence as dbEvidence,
    runs as dbRuns,
    sql,
    baselines as dbBaselines,
    toolCalls as dbToolCalls,
    claims as dbClaims,
    sources as dbSources,
    and,
} from '@scova/db';
import { expect, it } from 'vite-plus/test';
import {
    candidateFromCheckpoint,
    type AgentCandidate,
    type ComparisonExtraction,
} from '@scova/agent-core';
import { createAgentRepository } from '../../../server/src/repo/execution/agent.ts';
import { liveResearch } from './live-research.ts';
import { delivery, fixture, saver, assertEmpty, research } from './fixture.ts';
import { checkpointWithBodies } from './checkpoint.ts';

export function registerComparisonAuthentication() {
    it('篡改已提升manifest重要性或候选oldEvidenceIds无法绕过成功模型账本/冻结证据授权', async () => {
        const first = await liveResearch();
        await delivery.deliver(first.claimed.token, first.candidate);
        const second = await liveResearch({
            previous: first,
            body: '内容已变化。',
            importance: 'non_material',
        });
        const other = await liveResearch();
        await delivery.deliver(other.claimed.token, other.candidate);
        const foreign = await fixture.db.query.evidence
            .findFirst({ where: eq(dbEvidence.runId, other.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const forged = structuredClone(second.candidate);
        forged.changes![0].oldEvidenceIds = [foreign.id];
        await expect(delivery.deliver(second.claimed.token, forged)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        const row = await fixture.db.query.runs
            .findFirst({ where: eq(dbRuns.id, second.run.id) })
            .then((row) => requiredDatabaseValue(row));
        const ref = row.checkpointRef as {
            threadId: string;
            namespace: '';
            checkpointId: string;
            leaseEpoch: number;
        };
        const config = {
            configurable: {
                thread_id: ref.threadId,
                checkpoint_ns: '',
                checkpoint_id: ref.checkpointId,
            },
        };
        const tuple = (await saver.getTuple(config))!;
        const checkpoint = structuredClone(tuple.checkpoint);
        const state = checkpoint.channel_values.research as {
            manifest: AgentCandidate['manifest'];
            comparisonExtractions: ComparisonExtraction[];
        };
        state.manifest!.pages[0].facts[0].importance = 'important';
        const comparisonBefore = await createAgentRepository(
            fixture.db,
            second.claimed.token,
        ).comparison();
        expect(() =>
            candidateFromCheckpoint(
                { ...second.context, ...comparisonBefore },
                checkpointWithBodies(state, second.candidate.pages),
            ),
        ).toThrow();
        // Even forging both projections cannot bypass the independent committed tool result.
        (
            state.comparisonExtractions[0]!.response.data as {
                pages: { facts: { importance: string }[] }[];
            }
        ).pages[0]!.facts[0]!.importance = 'important';
        checkpoint.id = crypto.randomUUID();
        const saved = await saver.put(
            config,
            checkpoint,
            tuple.metadata!,
            checkpoint.channel_versions,
        );
        await createAgentRepository(fixture.db, second.claimed.token).promoteCheckpoint({
            ...ref,
            checkpointId: saved.configurable!.checkpoint_id as string,
        });
        const comparison = await createAgentRepository(
            fixture.db,
            second.claimed.token,
        ).comparison();
        const promotedForgery = candidateFromCheckpoint(
            { ...second.context, ...comparison },
            checkpointWithBodies(state, second.candidate.pages),
        );
        await expect(delivery.deliver(second.claimed.token, promotedForgery)).rejects.toMatchObject(
            {
                code: 'INVALID_DELIVERY_EVIDENCE',
            },
        );
        await assertEmpty(second.run.id);
    });

    it.each(['clipped', 'removed'] as const)(
        '比较覆盖元数据须与不可变模型账本一致，checkpoint不能篡改或剥离 (%s)',
        async (tampering) => {
            const seed = await liveResearch();
            const row = requiredDatabaseValue(
                await fixture.db.query.runs.findFirst({ where: eq(dbRuns.id, seed.run.id) }),
            );
            const ref = row.checkpointRef as {
                threadId: string;
                namespace: '';
                checkpointId: string;
                leaseEpoch: number;
            };
            const config = {
                configurable: {
                    thread_id: ref.threadId,
                    checkpoint_ns: '',
                    checkpoint_id: ref.checkpointId,
                },
            };
            const tuple = (await saver.getTuple(config))!;
            const checkpoint = structuredClone(tuple.checkpoint);
            const state = checkpoint.channel_values.research as {
                comparisonExtractions: ComparisonExtraction[];
            };
            expect(state.comparisonExtractions[0]!.sourceCoverage).toMatchObject({
                version: 1,
                pages: [{ clipped: false }],
            });
            const receipt = state.comparisonExtractions[0]!;
            const call = requiredDatabaseValue(
                await fixture.db.query.toolCalls.findFirst({
                    where: and(
                        eq(dbToolCalls.runId, seed.run.id),
                        sql`${dbToolCalls.operationKey} LIKE 'compare-facts-v1:%'`,
                    ),
                }),
            );
            expect(
                (call.outputRef as { result: { sourceCoverage: unknown } }).result.sourceCoverage,
            ).toEqual(receipt.sourceCoverage);
            if (tampering === 'clipped') receipt.sourceCoverage!.pages[0]!.clipped = true;
            else delete receipt.sourceCoverage;
            checkpoint.id = crypto.randomUUID();
            const saved = await saver.put(
                config,
                checkpoint,
                tuple.metadata!,
                checkpoint.channel_versions,
            );
            await createAgentRepository(fixture.db, seed.claimed.token).promoteCheckpoint({
                ...ref,
                checkpointId: saved.configurable!.checkpoint_id as string,
            });
            const comparison = await createAgentRepository(
                fixture.db,
                seed.claimed.token,
            ).comparison();
            const forged = candidateFromCheckpoint(
                { ...seed.context, ...comparison },
                checkpointWithBodies(state, seed.candidate.pages),
            );
            if (tampering === 'clipped')
                expect(
                    [...forged.coverage.gaps, ...(forged.coverage.notes ?? [])].join(' '),
                ).toContain('比较输入受预算限制');
            await expect(delivery.deliver(seed.claimed.token, forged)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );

    it.each(['inference', 'conflict'] as const)(
        '%s以明确标签和真实引用保存，冲突保留双方引用',
        async (kind) => {
            const seed = await liveResearch({ claimKind: kind });
            const result = await delivery.deliver(seed.claimed.token, seed.candidate);
            const claims = await fixture.db.query.claims.findMany({
                where: eq(dbClaims.reportId, result.reportId),
                with: { citations: true },
            });
            expect(claims).toHaveLength(1);
            expect(claims[0]).toMatchObject({
                kind,
                confidenceLabel:
                    kind === 'inference'
                        ? '模型归纳与推断，引用不代表推理已经独立核实'
                        : '来源存在冲突，待核验',
            });
            const report = await fixture.db.query.reports.findFirst({
                where: eq(dbReports.id, result.reportId),
            });
            const status = kind === 'conflict' ? '不同来源' : '已回答';
            const gap = kind === 'conflict' ? ' 补充说明：来源说法存在差异，尚未解决分歧。' : '';
            expect(report!.summary).toBe(
                `查找可追溯资料 · ${status}：${claims[0].text}${gap}` +
                    `\n\n来源 · ${status}：相关回答已在前文列出，详情见正文。` +
                    (kind === 'conflict' ? '\n\n尚有2项所需信息未完整取得，详见覆盖说明。' : ''),
            );
            expect(report!.summary.length).toBeLessThanOrEqual(600);
            expect(claims[0].citations).toHaveLength(kind === 'conflict' ? 2 : 1);
            if (kind === 'conflict') {
                expect(new Set(claims[0].citations.map((citation) => citation.relation))).toEqual(
                    new Set(['supports', 'contradicts']),
                );
                expect(
                    await fixture.db.query.runs
                        .findFirst({ where: eq(dbRuns.id, seed.run.id) })
                        .then((row) => requiredDatabaseValue(row)),
                ).toMatchObject({ status: 'partial', outcome: 'inconclusive' });
            }
        },
    );

    it('only uncertain claims still deliver with an unlinked real source excerpt and no complete baseline', async () => {
        const seed = await liveResearch({ claimKind: 'insufficient' });
        expect(seed.candidate.claims[0]).toMatchObject({ kind: 'insufficient', citations: [] });
        const { reportId } = await delivery.deliver(seed.claimed.token, seed.candidate);
        const report = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, reportId),
        });
        expect(report?.completeness).toBe('partial');
        expect(report?.summary).toContain('暂无直接回答');
        const claims = await fixture.db.query.claims.findMany({
            where: eq(dbClaims.reportId, reportId),
            with: { citations: true },
        });
        expect(
            claims.every((claim) => claim.kind === 'insufficient' && claim.citations.length === 0),
        ).toBe(true);
        expect(
            await fixture.db.query.evidence.findMany({ where: eq(dbEvidence.runId, seed.run.id) }),
        ).toHaveLength(1);
        expect(
            await fixture.db
                .select({ count: dbCount() })
                .from(dbSources)
                .where(eq(dbSources.userId, seed.user.id))
                .then((rows) => rows[0]!.count),
        ).toBe(1);
        expect(
            await fixture.db.query.baselines.findFirst({
                where: eq(dbBaselines.taskId, seed.task.id),
            }),
        ).toBeUndefined();
    });

    it.each(['unknown', 'failed'] as const)('%s的read结果不可升级成报告证据', async (status) => {
        const seed = await research();
        await fixture.db
            .update(dbToolCalls)
            .set({ status: status })
            .where(and(eq(dbToolCalls.runId, seed.run.id), eq(dbToolCalls.tool, 'read')))
            .returning({ id: dbToolCalls.id })
            .then((rows) => ({ count: rows.length }));
        await expect(delivery.deliver(seed.claimed.token, seed.candidate)).rejects.toMatchObject({
            code: 'INVALID_DELIVERY_EVIDENCE',
        });
        await assertEmpty(seed.run.id);
    });
}
