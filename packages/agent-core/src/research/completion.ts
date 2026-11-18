import type { Coverage } from '@scova/models';

export type VerificationStopReason = NonNullable<Coverage['completion']>['stopReason'];

/** Shared by graph validation and final delivery; knowledge answers do not end verification. */
export function researchCompletion(
    coverage: Pick<Coverage, 'delivery' | 'artifacts' | 'reportValue'>,
    stopReason?: VerificationStopReason,
): NonNullable<Coverage['completion']> {
    const delivery = coverage.delivery;
    const answerReady =
        !!delivery?.questionCount &&
        delivery.answeredQuestions === delivery.questionCount &&
        !coverage.reportValue?.questions.some((q) => q.status === 'disputed');
    const fields =
        coverage.artifacts
            ?.flatMap((a) => a.coverage?.requirements ?? [])
            .filter((r) => r.required) ?? [];
    const externalEvidenceComplete =
        answerReady && fields.length > 0 && fields.every((r) => r.status === 'supported');
    const reason = externalEvidenceComplete
        ? 'verified'
        : stopReason === 'verified'
          ? undefined
          : stopReason;
    return {
        version: 1,
        answerReady,
        externalEvidenceComplete,
        verificationDone: !!reason,
        ...(reason ? { stopReason: reason } : {}),
    };
}
