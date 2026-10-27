import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { historyFixture, seedHistoryRows } from "./support/history-fixture.ts";

const fixture = historyFixture();
beforeAll(() => fixture.setup(), 120000);
afterAll(() => fixture.cleanup());
type Frame = {
  id: string;
  event: string;
  data: { seq: number; runId: string; [key: string]: unknown };
};
function eventReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let buffered = "";
  async function next(milliseconds = 1900): Promise<Frame> {
    const started = performance.now();
    while (true) {
      const separator = buffered.indexOf("\n\n");
      if (separator >= 0) {
        const block = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        const fields = block.split("\n");
        const data = fields
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        return {
          id:
            fields
              .find((line) => line.startsWith("id:"))
              ?.slice(3)
              .trim() ?? "",
          event:
            fields
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? "message",
          data: JSON.parse(data),
        };
      }
      const remaining = milliseconds - (performance.now() - started);
      if (remaining <= 0) throw new Error("SSE event not visible within deadline");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("SSE event not visible within deadline")),
              remaining,
            );
          }),
        ]);
        if (chunk.done) throw new Error("SSE ended before the newly committed event");
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { next, cancel: () => reader.cancel() };
}
describe("真实socket持续SSE两秒可见性与续传", () => {
  it("已打开连接收到新提交事件小于2秒，Last-Event-ID去重且owner隔离", async () => {
    const owner = await fixture.register(),
      other = await fixture.register();
    const data = await seedHistoryRows(fixture.db, owner, 1, 1),
      run = data.runs[0]!;
    await fixture.db.run.update({
      where: { id: run.id },
      data: { status: "running", outcome: null, coverageJson: undefined, finishedAt: null },
    });
    const first = await fixture.db.runEvent.create({
      data: {
        userId: owner.id,
        runId: run.id,
        seq: 1,
        type: "step.started",
        payload: { step: "plan" },
      },
    });
    const controller = new AbortController();
    const response = await fixture.request(`/runs/${run.id}/events`, owner, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = eventReader(response.body!);
    try {
      const replay = await stream.next();
      expect(replay).toMatchObject({
        id: first.id,
        event: "step.started",
        data: { seq: 1, runId: run.id },
      });
      const second = await fixture.db.runEvent.create({
        data: {
          userId: owner.id,
          runId: run.id,
          seq: 2,
          type: "step.completed",
          payload: { step: "plan", durationMs: 1 },
        },
      });
      const committedAt = performance.now();
      const visible = await stream.next();
      const latencyMs = performance.now() - committedAt;
      expect(visible).toMatchObject({
        id: second.id,
        event: "step.completed",
        data: { seq: 2, runId: run.id },
      });
      expect(latencyMs).toBeLessThan(2000);
      expect(JSON.stringify(visible)).not.toContain("private-");
      console.log(
        JSON.stringify({
          benchmark: "sse-committed-event-visibility",
          transport: "Node HTTP loopback; persistent authenticated SSE",
          latencyMs: Number(latencyMs.toFixed(3)),
          upperBoundMs: 2000,
        }),
      );
      controller.abort();
      await stream.cancel().catch(() => undefined);
      const third = await fixture.db.runEvent.create({
        data: {
          userId: owner.id,
          runId: run.id,
          seq: 3,
          type: "step.started",
          payload: { step: "search" },
        },
      });
      const reconnectController = new AbortController();
      const reconnect = await fixture.request(`/runs/${run.id}/events`, owner, {
        headers: { "last-event-id": second.id },
        signal: reconnectController.signal,
      });
      expect(reconnect.status).toBe(200);
      const resumed = eventReader(reconnect.body!);
      try {
        expect(await resumed.next()).toMatchObject({ id: third.id, data: { seq: 3 } });
      } finally {
        reconnectController.abort();
        await resumed.cancel().catch(() => undefined);
      }
      expect((await fixture.request(`/runs/${run.id}/events`, other)).status).toBe(404);
    } finally {
      controller.abort();
      await stream.cancel().catch(() => undefined);
    }
  });
});
