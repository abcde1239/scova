import { relations } from 'drizzle-orm';
import { reportQuestions, questionEvidence } from '../questions.ts';
import { users } from '../identity.ts';
import { reports } from '../reports.ts';
import { runs } from '../runs.ts';
import { evidence } from '../sources.ts';

export const reportQuestionsRelations = relations(reportQuestions, ({ one, many }) => ({
    owner: one(users, {
        relationName: 'User_ReportQuestion',
        fields: [reportQuestions.userId],
        references: [users.id],
    }),
    report: one(reports, {
        relationName: 'ReportQuestion_report',
        fields: [reportQuestions.userId, reportQuestions.reportId],
        references: [reports.userId, reports.id],
    }),
    followupRun: one(runs, {
        relationName: 'ReportQuestion_followupRun',
        fields: [reportQuestions.userId, reportQuestions.followupRunId],
        references: [runs.userId, runs.id],
    }),
    evidence: many(questionEvidence, { relationName: 'QuestionEvidence_question' }),
}));

export const questionEvidenceRelations = relations(questionEvidence, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_QuestionEvidence',
        fields: [questionEvidence.userId],
        references: [users.id],
    }),
    question: one(reportQuestions, {
        relationName: 'QuestionEvidence_question',
        fields: [questionEvidence.userId, questionEvidence.questionId],
        references: [reportQuestions.userId, reportQuestions.id],
    }),
    evidence: one(evidence, {
        relationName: 'QuestionEvidence_evidence',
        fields: [questionEvidence.userId, questionEvidence.evidenceId],
        references: [evidence.userId, evidence.id],
    }),
}));
