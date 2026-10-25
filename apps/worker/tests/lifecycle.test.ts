import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkerApp } from "../src/app/index.ts";
import { readWorkerConfig } from "../src/app/config.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const config = readWorkerConfig({
  DATABASE_URL: "postgresql://worker:secret@localhost/scova",
  REDIS_URL: "redis://:secret@localhost:6379",
  WORKER_POLL_INTERVAL_MS: "100",
  WORKER_FAILURE_DELAY_MS: "500",
});

function harness(
  overrides: {
    connect?: () => Promise<void>;
    dispatch?: (signal: AbortSignal) => Promise<number>;
    close?: () => Promise<void>;
  } = {},
) {
  const resources = {
    connect: vi.fn(overrides.connect ?? (async () => {})),
    dispatch: vi.fn(overrides.dispatch ?? (async (_signal: AbortSignal) => 0)),
    close: vi.fn(overrides.close ?? (async () => {})),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const app = createWorkerApp({ config, resources, logger });
  return { app, resources, logger };
}

describe("Worker 启动、串行轮询与停止", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("构造不连接，重复 start 共用一次初始化，连接成功后才开始投递", async () => {
    const connecting = deferred();
    const { app, resources } = harness({ connect: () => connecting.promise });
    expect(resources.connect).not.toHaveBeenCalled();
    expect(resources.dispatch).not.toHaveBeenCalled();
    const first = app.start();
    const second = app.start();
    expect(resources.connect).toHaveBeenCalledTimes(1);
    expect(resources.dispatch).not.toHaveBeenCalled();
    connecting.resolve();
    try {
      await Promise.all([first, second]);
      expect(resources.dispatch).toHaveBeenCalledTimes(1);
      await app.start();
      expect(resources.connect).toHaveBeenCalledTimes(1);
    } finally {
      await app.stop();
    }
    expect(resources.close).toHaveBeenCalledTimes(1);
  });

  it("投递时间超过轮询间隔仍保持单批在途，完成后才计算下一次等待", async () => {
    const dispatching = deferred();
    let active = 0;
    let maximumActive = 0;
    const { app, resources } = harness({
      dispatch: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await dispatching.promise;
          return 0;
        } finally {
          active -= 1;
        }
      },
    });
    try {
      await app.start();
      await vi.advanceTimersByTimeAsync(config.pollIntervalMs * 5);
      expect(resources.dispatch).toHaveBeenCalledTimes(1);
      dispatching.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(config.pollIntervalMs - 1);
      expect(resources.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(resources.dispatch).toHaveBeenCalledTimes(2);
      expect(maximumActive).toBe(1);
    } finally {
      dispatching.resolve();
      await app.stop();
    }
  });

  it("stop 先发出取消信号，等待在途投递结束后仅关闭资源一次", async () => {
    const dispatching = deferred();
    let signal: AbortSignal | undefined;
    const events: string[] = [];
    const { app, resources } = harness({
      dispatch: async (value) => {
        signal = value;
        await dispatching.promise;
        events.push("dispatch:end");
        return 0;
      },
      close: async () => {
        events.push("close");
      },
    });
    await app.start();
    const stopping = app.stop();
    const repeated = app.stop();
    expect(signal?.aborted).toBe(true);
    expect(resources.close).not.toHaveBeenCalled();
    try {
      await vi.advanceTimersByTimeAsync(config.pollIntervalMs * 5);
      expect(resources.dispatch).toHaveBeenCalledTimes(1);
      expect(resources.close).not.toHaveBeenCalled();
    } finally {
      dispatching.resolve();
      await Promise.all([stopping, repeated]);
    }
    expect(events).toEqual(["dispatch:end", "close"]);
    await app.stop();
    expect(resources.close).toHaveBeenCalledTimes(1);
    await expect(app.start()).rejects.toThrow("已停止");
  });

  it.each(["idle", "failed"] as const)("stop 可唤醒 %s 等待，不再创建新批次", async (state) => {
    const { app, resources } = harness({
      dispatch: async () => {
        if (state === "failed") throw new Error("redis://user:secret@private-host");
        return 0;
      },
    });
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await app.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(config.failureDelayMs * 2);
    expect(resources.dispatch).toHaveBeenCalledTimes(1);
    expect(resources.close).toHaveBeenCalledTimes(1);
  });

  it("批次失败按独立退避重试，日志不包含错误原文或连接凭据", async () => {
    let attempts = 0;
    const { app, resources, logger } = harness({
      dispatch: async () => {
        if (attempts++ === 0) throw new Error("postgresql://user:secret@private-host/scova");
        return 1;
      },
    });
    try {
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(config.failureDelayMs - 1);
      expect(resources.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(resources.dispatch).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls).toEqual([["Worker Outbox 批次失败，将退避后重试"]]);
      expect(logger.info.mock.calls).toEqual([["Scova worker ready; Outbox dispatcher running"]]);
      await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
      expect(resources.dispatch).toHaveBeenCalledTimes(3);
    } finally {
      await app.stop();
    }
  });

  it("启动连接失败自动清理，重复停止不重复关闭且不发布就绪日志", async () => {
    const failure = new Error("postgresql://user:secret@private-host/scova");
    const { app, resources, logger } = harness({
      connect: async () => {
        throw failure;
      },
    });
    await expect(app.start()).rejects.toBe(failure);
    expect(resources.dispatch).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(resources.close).toHaveBeenCalledTimes(1);
    await app.stop();
    await app.stop();
    expect(resources.close).toHaveBeenCalledTimes(1);
  });

  it("初始化尚未完成时停止，等待初始化后清理且不进入轮询", async () => {
    const connecting = deferred();
    const { app, resources, logger } = harness({ connect: () => connecting.promise });
    const starting = app.start();
    const stopping = app.stop();
    expect(resources.close).not.toHaveBeenCalled();
    connecting.resolve();
    await Promise.all([starting, stopping]);
    expect(resources.dispatch).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(resources.close).toHaveBeenCalledTimes(1);
  });
});
