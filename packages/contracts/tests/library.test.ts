import { describe, expect, it } from "vite-plus/test";
import {
  BookmarkInputSchema,
  NoteInputSchema,
  NotePatchInputSchema,
  LibrarySearchQuerySchema,
  parseContract,
} from "../src/index.ts";
const id = "019a0000-0000-7000-8000-000000000001";
describe("资料库公开契约", () => {
  it("收藏只接受已有来源ID，不接受URL或owner", () => {
    expect(parseContract(BookmarkInputSchema, { sourceId: id })).toEqual({ sourceId: id });
    expect(() => parseContract(BookmarkInputSchema, { url: "https://example.com" })).toThrow();
    expect(() => parseContract(BookmarkInputSchema, { sourceId: id, userId: id })).toThrow();
  });
  it("笔记恰有一种目标，可为来源或报告，正文原样纯文本保留", () => {
    for (const kind of ["source", "report"]) {
      const body = { target: { kind, id }, body: "  <script>文本</script>\n纯文本笔记  " };
      expect(parseContract(NoteInputSchema, body)).toBe(body);
    }
    for (const target of [{}, { kind: "source", id, reportId: id }, { kind: "unknown", id }])
      expect(() => parseContract(NoteInputSchema, { target, body: "笔记" })).toThrow();
    expect(() => parseContract(NoteInputSchema, { body: "笔记" })).toThrow();
  });
  it("修改笔记不能替换目标或直接设置revision", () => {
    expect(() => parseContract(NotePatchInputSchema, { body: "新正文", revision: 2 })).toThrow();
    expect(() =>
      parseContract(NotePatchInputSchema, { body: "新正文", target: { kind: "report", id } }),
    ).toThrow();
    expect(() => parseContract(NotePatchInputSchema, { body: " " })).toThrow();
    expect(() => parseContract(NotePatchInputSchema, { body: "x".repeat(20001) })).toThrow();
  });
  it("搜索限制长度并不接受指定租户", () => {
    expect(
      parseContract(LibrarySearchQuerySchema, {
        q: "小样本学习",
        kind: "source",
        bookmarked: true,
      }),
    ).toMatchObject({ q: "小样本学习" });
    expect(() => parseContract(LibrarySearchQuerySchema, { q: " ", userId: id })).toThrow();
    expect(() => parseContract(LibrarySearchQuerySchema, { q: "x".repeat(201) })).toThrow();
  });
});
