import { requiredDatabaseValue } from '@/utils/database.ts';
import {
    type Run,
    eq,
    and,
    claims as dbClaims,
    claimEvidence as dbClaimEvidence,
    type DatabaseTransaction,
} from '@scova/db';
import { type AgentCandidate } from '@scova/agent-core';
import type { SaveEvidence } from '@/repo/delivery/evidence.ts';

export async function saveClaims(
    tx: DatabaseTransaction,
    run: Run,
    reportId: string,
    candidate: AgentCandidate,
    saveEvidence: SaveEvidence,
) {
    for (const [order, item] of candidate.claims.entries()) {
        const claim = await tx
            .insert(dbClaims)
            .values({
                userId: run.userId,
                taskId: run.taskId,
                reportId: reportId,
                kind: item.kind,
                text: item.text,
                order: order,
                confidenceLabel: item.uncertainty?.length
                    ? `待核实：${item.uncertainty.map((code) => ({ quote_unmatched: '部分引用未能定位到原文', missing_citation: '缺少直接引用', question_scope: '引用与问题的对应关系未确认', conflict_incomplete: '冲突双方证据不齐' })[code]).join('；')}。保留模型结论供参考，不作为已核验事实`
                    : {
                          fact: '采集原文事实',
                          inference: '模型归纳与推断，引用不代表推理已经独立核实',
                          conflict: '来源存在冲突，待核验',
                          insufficient: '待核实：证据不足，内容仅供参考',
                          model_answer: '模型自回答',
                          conflict_review: '冲突复核',
                      }[item.kind],
            })
            .returning()
            .then((rows) => requiredDatabaseValue(rows[0]));
        for (const [index, citation] of item.citations.entries()) {
            const evidenceId = await saveEvidence(citation);
            await tx
                .insert(dbClaimEvidence)
                .values({
                    userId: run.userId,
                    claimId: claim.id,
                    evidenceId: evidenceId,
                    relation: item.kind === 'conflict' && index > 0 ? 'contradicts' : 'supports',
                })
                .onConflictDoNothing({
                    target: [dbClaimEvidence.claimId, dbClaimEvidence.evidenceId],
                })
                .returning()
                .then(
                    async (rows) =>
                        rows[0] ??
                        requiredDatabaseValue(
                            await tx.query.claimEvidence.findFirst({
                                where: and(
                                    eq(dbClaimEvidence.claimId, claim.id),
                                    eq(dbClaimEvidence.evidenceId, evidenceId),
                                ),
                            }),
                        ),
                );
        }
    }
}
