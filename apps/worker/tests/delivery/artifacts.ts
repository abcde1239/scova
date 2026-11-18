import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    reports as dbReports,
    eq,
    taskVersions as dbTaskVersions,
    tasks as dbTasks,
    runs as dbRuns,
    sql,
    toolCalls as dbToolCalls,
    claims as dbClaims,
    and,
} from '@scova/db';
import type { Report } from '@scova/models';
import { expect, it } from 'vite-plus/test';
import { candidateFromCheckpoint } from '@scova/agent-core';
import { checkpointWithBodies } from './checkpoint.ts';
import { createAgentRepository } from '../../src/repo/agent.ts';
import { liveResearch } from './live-research.ts';
import { delivery, fixture, assertEmpty, saver } from './fixture.ts';

export function registerArtifacts() {
    it('persists independent artifact indexes and the primary summary without rewriting saved output after task edits', async () => {
        const seed = await liveResearch({
            outputFormats: ['list', 'brief'],
            claimKind: 'inference',
        });
        const artifacts = seed.candidate.coverage.artifacts!;
        expect(artifacts.map((artifact) => artifact.format)).toEqual(['list', 'brief']);
        expect(
            artifacts[0].claimIndexes.map((index) => seed.candidate.claims[index].text),
            JSON.stringify(seed.candidate.coverage),
        ).toEqual(['list独立归纳：申请期限需要结合原公告确认。']);
        expect(artifacts[1].claimIndexes.map((index) => seed.candidate.claims[index].text)).toEqual(
            ['brief独立归纳：申请期限需要结合原公告确认。'],
        );
        const result = await delivery.deliver(seed.claimed.token, seed.candidate);
        const saved = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(saved?.format).toBe('list');
        expect(saved?.summary).toContain('list独立归纳');
        expect(saved?.summary).not.toContain('brief独立归纳');
        const storedRun = await fixture.db.query.runs
            .findFirst({
                where: eq(dbRuns.id, seed.run.id),
            })
            .then((row) => requiredDatabaseValue(row));
        expect((storedRun.coverageJson as Report['coverage']).artifacts).toEqual(artifacts);
        const storedClaims = await fixture.db.query.claims.findMany({
            where: eq(dbClaims.reportId, result.reportId),
        });
        expect(storedClaims.map((entry) => entry.text).sort()).toEqual(
            seed.candidate.claims.map((entry) => entry.text).sort(),
        );
        const nextVersion = await fixture.db
            .insert(dbTaskVersions)
            .values({
                userId: seed.user.id,
                taskId: seed.task.id,
                version: seed.version.version + 1,
                configJson: {
                    ...seed.config,
                    outputFormat: 'research_report',
                    outputFormats: ['research_report'],
                },
                comparisonScopeHash: seed.version.comparisonScopeHash,
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        await fixture.db
            .update(dbTasks)
            .set({ currentVersionId: nextVersion.id })
            .where(eq(dbTasks.id, seed.task.id));
        const unchanged = await fixture.db.query.reports.findFirst({
            where: eq(dbReports.id, result.reportId),
        });
        expect(unchanged).toEqual(saved);
        expect(unchanged?.taskVersionId).toBe(seed.version.id);
        expect(await delivery.deliver(seed.claimed.token, seed.candidate)).toEqual({
            reportId: result.reportId,
            reused: true,
        });
    });

    it.each([false, true])(
        'persists question answers and authenticates synthesis assessments (tampered=%s)',
        async (tampered) => {
            const seed = await liveResearch();
            expect(seed.candidate.coverage.reportValue?.questions.map((q) => q.status)).toEqual([
                'supported',
                'supported',
            ]);
            const call = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'synthesize-0:%'`,
                ),
            });
            expect(call?.status).toBe('succeeded');
            if (tampered) {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, call!.id));
                await expect(
                    delivery.deliver(seed.claimed.token, seed.candidate),
                ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_EVIDENCE' });
                await assertEmpty(seed.run.id);
            } else {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const row = await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                });
                expect((row!.coverageJson as Report['coverage']).reportValue).toEqual(
                    seed.candidate.coverage.reportValue,
                );
                const report = await fixture.db.query.reports.findFirst({
                    where: eq(dbReports.id, result.reportId),
                });
                expect(report?.summary).toContain('查找可追溯资料');
            }
        },
    );

    it.each(['valid', 'ledger_unknown', 'strip_plan', 'alter_required', 'forge_content'] as const)(
        'authenticates frozen artifact requirements independently of checkpoint (%s)',
        async (attack) => {
            const seed = await liveResearch();
            expect(seed.candidate.coverage.artifacts?.[0]?.coverage?.requirements).toHaveLength(2);
            const call = await fixture.db.query.toolCalls.findFirst({
                where: and(
                    eq(dbToolCalls.runId, seed.run.id),
                    sql`${dbToolCalls.operationKey} LIKE 'plan-0:%'`,
                ),
            });
            expect(call?.status).toBe('succeeded');
            if (attack === 'valid') {
                const result = await delivery.deliver(seed.claimed.token, seed.candidate);
                const saved = await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                });
                expect((saved!.coverageJson as Report['coverage']).artifacts).toEqual(
                    seed.candidate.coverage.artifacts,
                );
                expect(result.reportId).toBeTruthy();
                return;
            }
            let candidate = seed.candidate;
            if (attack === 'ledger_unknown') {
                await fixture.db
                    .update(dbToolCalls)
                    .set({ status: 'unknown' })
                    .where(eq(dbToolCalls.id, call!.id));
            } else if (attack === 'forge_content') {
                candidate = structuredClone(candidate);
                candidate.coverage.artifacts![0]!.coverage!.requirements[0]!.required = false;
            } else {
                const run = (await fixture.db.query.runs.findFirst({
                    where: eq(dbRuns.id, seed.run.id),
                }))!;
                const ref = run.checkpointRef as {
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
                    artifactPolicy?: number;
                    planningExtraction?: {
                        response: { data: { requirements: { required: boolean }[] } };
                    };
                };
                const repository = createAgentRepository(fixture.db, seed.claimed.token);
                const context = {
                    ...seed.context,
                    ...(await repository.comparison()),
                    usage: await repository.usage(),
                };
                expect(
                    candidateFromCheckpoint(
                        context,
                        checkpointWithBodies(state, seed.candidate.pages),
                    ),
                ).toEqual(seed.candidate);
                if (attack === 'strip_plan') {
                    delete state.artifactPolicy;
                    delete state.planningExtraction;
                } else state.planningExtraction!.response.data.requirements[0]!.required = false;
                checkpoint.id = crypto.randomUUID();
                checkpoint.channel_versions.research = saver.getNextVersion(
                    Number(checkpoint.channel_versions.research),
                );
                const saved = await saver.put(
                    config,
                    checkpoint,
                    tuple.metadata!,
                    checkpoint.channel_versions,
                );
                const persisted = (await saver.getTuple(saved))!;
                expect(persisted.checkpoint.channel_values.research).toEqual(state);
                await repository.promoteCheckpoint({
                    ...ref,
                    checkpointId: saved.configurable!.checkpoint_id as string,
                });
                candidate = candidateFromCheckpoint(
                    context,
                    checkpointWithBodies(state, seed.candidate.pages),
                );
            }
            await expect(delivery.deliver(seed.claimed.token, candidate)).rejects.toMatchObject({
                code: 'INVALID_DELIVERY_EVIDENCE',
            });
            await assertEmpty(seed.run.id);
        },
    );
}
