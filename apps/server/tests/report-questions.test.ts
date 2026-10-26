import { describe, it, expect } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import {
  parseContract,
  ReportQuestionInputSchema,
  QuestionFollowupInputSchema,
} from "@scova/contracts";
import { validateQuestionAnswer } from "../src/utils/report-questions.ts";
const usage = { attempts: 1, inputTokens: 100, outputTokens: 50, estimated: false };
describe("报告问答引用授权", () => {
  it("拒绝不在授权证据内的ID和伪造原文", () => {
    const id = randomUUID(),
      make = (evidenceId: string, quote: string) => ({
        statements: [{ text: "回答", citations: [{ evidenceId, quote }] }],
        needsResearch: false,
      });
    for (const raw of [make(randomUUID(), "免费"), make(id, "付费"), make(id, "  ")])
      expect(() => validateQuestionAnswer(raw, [{ id, quote: "免费" }], usage)).toThrow();
  });
  it("即使引用合法也拒绝引用未支持的生成事实", () => {
    const id = randomUUID();
    expect(() =>
      validateQuestionAnswer(
        {
          statements: [
            { text: "奖励一百抽", citations: [{ evidenceId: id, quote: "活动时间未定" }] },
          ],
          needsResearch: false,
        },
        [{ id, quote: "活动时间未定" }],
        usage,
      ),
    ).toThrow();
  });
  it("保留逐字引用与独立用量，无证据明确需要研究", () => {
    const id = randomUUID();
    expect(
      validateQuestionAnswer(
        {
          statements: [{ text: "免费", citations: [{ evidenceId: id, quote: "免费" }] }],
          needsResearch: false,
        },
        [{ id, quote: "目前免费" }],
        usage,
      ),
    ).toMatchObject({ status: "answered", usage });
    expect(
      validateQuestionAnswer({ statements: [], needsResearch: false }, [], usage),
    ).toMatchObject({ status: "insufficient", needsResearch: true });
  });
  it("拒绝空白、额外目标、未明确确认", () => {
    for (const value of [{ question: " " }, { question: "问题", sourceId: randomUUID() }])
      expect(() => parseContract(ReportQuestionInputSchema, value)).toThrow();
    expect(() => parseContract(QuestionFollowupInputSchema, { confirm: false })).toThrow();
    expect(parseContract(QuestionFollowupInputSchema, { confirm: true })).toEqual({
      confirm: true,
    });
  });
});
