import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRunConsumer } from "../src/queue/runs.ts";
import { createWorkerApp } from "../src/app/index.ts";
import { readWorkerConfig } from "../src/app/config.ts";

const mock = vi.hoisted(() => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let runPromise: Promise<void>;
  let processJob!: (job: { name: string; data: unknown }) => Promise<unknown>;
  const disconnect = vi.fn();
  const close = vi.fn(async () => {
    resolve();
  });
  return {
    disconnect,
    close,
    initialize() {
      runPromise = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    },
    reject(error: Error) {
      reject(error);
    },
    resolve() {
      resolve();
    },
    processJob(job: { name: string; data: unknown }) {
      return processJob(job);
    },
    Redis: class {
      on() {}
      disconnect = disconnect;
    },
    Worker: class {
      constructor(_name: string, processor: typeof processJob) {
        processJob = processor;
      }
      on() {}
      async waitUntilReady() {}
      run() {
        return runPromise;
      }
      close = close;
    },
  };
});
vi.mock("bullmq", () => ({ Worker: mock.Worker }));
vi.mock("ioredis", () => ({ Redis: mock.Redis }));

describe("Run consumer意外退出与停止的故障传播", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.initialize();
  });

  it.each(["reject", "resolve"])("主循环意外%s使finished明确失败且脱敏", async (kind) => {
    const consumer = createRunConsumer(
      "redis://secret@private-host",
      "unit-queue",
      async () => undefined,
    );
    await consumer.start();
    const assertion = expect(consumer.finished()).rejects.toThrow("Run consumer 循环意外停止");
    if (kind === "reject") mock.reject(new Error("redis://secret@private-host"));
    else mock.resolve();
    await assertion;
    await consumer.stop();
    expect(mock.close).toHaveBeenCalledWith(true);
    expect(mock.disconnect).toHaveBeenCalled();
  });

  it("stop先发信号并等待领域handler收敛，再关闭连接；重复停止幂等", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const consumer = createRunConsumer(
      "redis://localhost",
      "unit-queue",
      async (_name, _data, value) => {
        signal = value;
        entered();
        await barrier;
      },
    );
    await consumer.start();
    const job = mock.processJob({ name: "run.enqueue", data: {} });
    await started;
    const stopping = consumer.stop();
    expect(signal?.aborted).toBe(true);
    expect(mock.close).not.toHaveBeenCalled();
    release();
    await job;
    await Promise.all([stopping, consumer.stop()]);
    await consumer.finished();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("consumer故障传到app.finished并停止新poll，清理仍会完成", async () => {
    let fail!: (error: Error) => void;
    let release!: () => void;
    const dispatching = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const resources = {
      connect: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        await dispatching;
        return 0;
      }),
      finished: () => finished,
      stop: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const app = createWorkerApp({
      config: readWorkerConfig({
        DATABASE_URL: "postgresql://localhost/scova",
        REDIS_URL: "redis://localhost",
      }),
      resources,
      logger: { info() {}, error() {} },
    });
    await app.start();
    const assertion = expect(app.finished()).rejects.toThrow("consumer failed");
    fail(new Error("consumer failed"));
    await assertion;
    const stopping = app.stop();
    const rejected = expect(stopping).rejects.toThrow("Worker 在途操作停止失败");
    await Promise.resolve();
    expect(resources.close).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(resources.stop).toHaveBeenCalledTimes(1);
    expect(resources.close).toHaveBeenCalledTimes(1);
    expect(resources.dispatch).toHaveBeenCalledTimes(1);
  });
});
