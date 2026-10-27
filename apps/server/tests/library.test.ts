import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ContractValidationError } from "@scova/contracts";
import {
  libraryScope,
  readLibraryCursor,
  writeLibraryCursor,
  librarySearchTerms,
  libraryExcerpt,
} from "../src/utils/library.ts";
import { createLibraryService } from "../src/service/library.ts";
import { createDefaultServices } from "../src/app/context.ts";

const repo = vi.hoisted(() => ({
  target: vi.fn(),
  createBookmark: vi.fn(),
  bookmark: vi.fn(),
  bookmarks: vi.fn(),
  bookmarkAnchor: vi.fn(),
  deleteBookmark: vi.fn(),
  noteCommand: vi.fn(),
  note: vi.fn(),
  notes: vi.fn(),
  noteAnchor: vi.fn(),
  changeNote: vi.fn(),
  snapshot: vi.fn(),
  snapshots: vi.fn(),
  snapshotAnchor: vi.fn(),
  quotes: vi.fn(),
  search: vi.fn(),
  searchAnchor: vi.fn(),
  purgeExpiredBodies: vi.fn(),
}));
vi.mock("../src/repo/library.ts", () => ({ createLibraryRepo: () => repo }));
const owner = "019a0000-0000-7000-8000-000000000001",
  source = "019a0000-0000-7000-8000-000000000002",
  recordId = "019a0000-0000-7000-8000-000000000003";
const now = new Date("2026-10-26T00:00:00Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const services = () =>
  createDefaultServices({
    db: () => {
      throw new Error("不允许连接数据库");
    },
  });
const service = () => createLibraryService(services());
beforeEach(() => {
  vi.resetAllMocks();
  repo.target.mockResolvedValue({ id: source });
});

describe("数据库精度游标与纯文本工具", () => {
  it("数据库微秒原样往返，不经JS Date截断", () => {
    const scope = libraryScope(owner, "bookmarks", null),
      cursor = { id: recordId, time: "2026-10-26T12:00:00.123456Z" };
    expect(readLibraryCursor(writeLibraryCursor(cursor, scope), scope)).toEqual(cursor);
    expect(readLibraryCursor(undefined, scope)).toBeUndefined();
  });
  it("scope绑定owner/资源/筛选，拒绝错误scope与非法时间", () => {
    const scope = libraryScope(owner, "search", ["中文", "source", true]);
    const encoded = writeLibraryCursor(
      { id: recordId, time: "2026-10-26T12:00:00.123456Z", kind: "source" },
      scope,
    );
    expect(() =>
      readLibraryCursor(encoded, libraryScope(source, "search", ["中文", "source", true])),
    ).toThrow();
    expect(() =>
      readLibraryCursor(encoded, libraryScope(owner, "search", ["其他", "source", true])),
    ).toThrow();
    expect(() =>
      readLibraryCursor(
        writeLibraryCursor({ id: recordId, time: "2026-10-26T12:00:00.123Z" }, scope),
        scope,
      ),
    ).toThrow();
    expect(() => readLibraryCursor("not-json", scope)).toThrow();
  });
  it("子串关键词保持百分号/下划线/引号字面值，并限制词数和字节", () => {
    expect(librarySearchTerms("  中文  100%_ 'quoted' ")).toEqual(["中文", "100%_", "'quoted'"]);
    expect(() => librarySearchTerms("a b c d e f g h i")).toThrow();
    expect(() => librarySearchTerms("中".repeat(267))).toThrow();
  });
  it("片段围绕命中词且最大500字符，不生成HTML高亮", () => {
    const result = libraryExcerpt("前".repeat(1000) + "关键词" + "后".repeat(1000), ["关键词"]);
    expect(result).toContain("关键词");
    expect(result).toHaveLength(500);
    expect(result).not.toContain("<mark>");
  });
});

describe("资料库业务边界", () => {
  it("无效目标/空白/未知字段在持久化前拒绝", async () => {
    for (const body of [
      { target: { kind: "source", id: source }, body: " " },
      { target: { kind: "source", id: source, reportId: recordId }, body: "笔记" },
      { sourceId: source, reportId: recordId, body: "笔记" },
      { target: { kind: "source", id: source }, body: "笔记", userId: owner },
    ])
      await expect(
        service().createNote(owner, body, "library-unit-note-key"),
      ).rejects.toBeInstanceOf(ContractValidationError);
    expect(repo.target).not.toHaveBeenCalled();
    expect(repo.noteCommand).not.toHaveBeenCalled();
  });
  it("其他owner或缺失目标统一404，收藏不创建来源", async () => {
    repo.target.mockResolvedValue(null);
    await expect(service().createBookmark(owner, { sourceId: source })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service().createNote(
        owner,
        { target: { kind: "source", id: source }, body: "笔记" },
        "library-unit-note-key",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.createBookmark).not.toHaveBeenCalled();
    expect(repo.noteCommand).not.toHaveBeenCalled();
  });
  it("笔记CAS冲突与删除不覆盖新修订，目标不可修改", async () => {
    repo.changeNote.mockResolvedValue({ changed: false, current: { revision: 2 } });
    await expect(service().patchNote(owner, recordId, { body: "新正文" }, 1)).rejects.toMatchObject(
      { status: 409, code: "REVISION_CONFLICT" },
    );
    await expect(service().deleteNote(owner, recordId, 1)).rejects.toMatchObject({ status: 409 });
    await expect(
      service().patchNote(
        owner,
        recordId,
        { body: "新正文", target: { kind: "source", id: source } },
        1,
      ),
    ).rejects.toBeInstanceOf(ContractValidationError);
    repo.changeNote.mockResolvedValue({ changed: false, current: null });
    await expect(service().deleteNote(owner, recordId, 1)).rejects.toMatchObject({ status: 404 });
  });
  it("历史正文清理后只返回保留引用、指纹与位置", async () => {
    const text = "保留的原文引用";
    repo.snapshot.mockResolvedValue({
      id: recordId,
      userId: owner,
      sourceId: source,
      title: "标题",
      contentHash: sha(text),
      extractorVersion: "reader-v1",
      textExpiresAt: now,
      textBody: null,
      bodyAvailable: false,
      canonicalUrl: "https://example.com",
      observationId: recordId,
      runId: recordId,
      originalUrl: "https://example.com",
      fetchedUrl: "https://example.com",
      observedAt: now,
      metadata: { mode: "demo", truncated: false },
      mode: "demo",
    });
    repo.quotes.mockResolvedValue([
      {
        id: recordId,
        runId: recordId,
        quote: text,
        quoteHash: sha(text),
        selectorJson: {
          type: "text_offset",
          start: 0,
          end: text.length,
          extractorVersion: "reader-v1",
        },
      },
    ]);
    const result = await service().snapshot(owner, source, recordId);
    expect(result.textBody).toBeNull();
    expect(result.snapshot.bodyStatus).toBe("expired");
    expect(result.quotes[0]!.quote).toBe(text);
    expect(result.quotes[0]!.selector.end).toBe(text.length);
  });
  it("正文指纹、观测模式或引用错误拒绝整个详情，不部分返回", async () => {
    const row = {
      id: recordId,
      userId: owner,
      sourceId: source,
      title: "标题",
      contentHash: sha("原文"),
      extractorVersion: "reader-v1",
      textExpiresAt: null,
      textBody: "原文",
      bodyAvailable: true,
      canonicalUrl: "https://example.com",
      observationId: recordId,
      runId: recordId,
      originalUrl: "https://example.com",
      fetchedUrl: "https://example.com",
      observedAt: now,
      metadata: { mode: "demo", truncated: false },
      mode: "demo",
    };
    repo.snapshot.mockResolvedValue({ ...row, textBody: "被修改" });
    await expect(service().snapshot(owner, source, recordId)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_SOURCE_SNAPSHOT",
    });
    repo.snapshot.mockResolvedValue({ ...row, metadata: { mode: "live", truncated: false } });
    await expect(service().snapshot(owner, source, recordId)).rejects.toMatchObject({
      status: 409,
    });
    repo.snapshot.mockResolvedValue(row);
    repo.quotes.mockResolvedValue([
      {
        id: recordId,
        runId: recordId,
        quote: "原文",
        quoteHash: sha("错误"),
        selectorJson: { type: "text_offset", start: 0, end: 2, extractorVersion: "reader-v1" },
      },
    ]);
    await expect(service().snapshot(owner, source, recordId)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("内部清理有界且无公开HTTP入口", async () => {
    repo.purgeExpiredBodies.mockResolvedValue({ cleared: 3 });
    expect(await service().purgeExpiredSnapshotBodies({ limit: 10, userId: owner })).toEqual({
      cleared: 3,
    });
    expect(repo.purgeExpiredBodies).toHaveBeenCalledWith(10, owner);
    await expect(service().purgeExpiredSnapshotBodies({ limit: 1001 })).rejects.toThrow();
    await expect(service().purgeExpiredSnapshotBodies({ limit: 0 })).rejects.toThrow();
  });
});
