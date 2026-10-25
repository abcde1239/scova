import assert from "node:assert/strict";
import pg from "pg";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// 独立进程只接收测试 schema 和 run ID，不接受任意 SQL 或恢复引用。
const [phase, schema, runId] = process.argv.slice(2);
assert.match(schema ?? "", /^runtime_[a-f0-9]{24}$/);
assert.match(runId ?? "", /^[a-f0-9-]{36}$/);
const pool = new pg.Pool({
  connectionString: process.env.RUNTIME_DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
});
const saver = new PostgresSaver(pool, undefined, { schema });
const table = `"${schema}"`;
const state = Annotation.Root({
  value: Annotation({ reducer: (_previous, next) => next, default: () => "" }),
});
const makeConfig = (epoch) => ({
  configurable: { thread_id: `run-${runId}-epoch-${epoch}`, checkpoint_ns: "" },
});

async function promote(config, epoch) {
  const checkpointRef = {
    threadId: config.configurable.thread_id,
    namespace: config.configurable.checkpoint_ns ?? "",
    checkpointId: config.configurable.checkpoint_id,
    leaseEpoch: epoch,
  };
  const result = await pool.query(
    `UPDATE ${table}.runs SET checkpoint_ref = $1::jsonb
     WHERE id = $2 AND lease_epoch = $3 AND lease_owner = $4
       AND lease_expires_at > now()`,
    [JSON.stringify(checkpointRef), runId, epoch, `worker-${epoch}`],
  );
  return result.rowCount;
}

async function getAuthorizedRef() {
  const result = await pool.query(`SELECT * FROM ${table}.runs WHERE id = $1`, [runId]);
  assert.equal(result.rowCount, 1);
  assert.ok(result.rows[0].checkpoint_ref?.checkpointId, "恢复只能使用已提升的显式 checkpoint");
  return result.rows[0];
}

function configFromRef(ref) {
  return {
    configurable: {
      thread_id: ref.threadId,
      checkpoint_ns: ref.namespace,
      checkpoint_id: ref.checkpointId,
    },
  };
}

function graph(epoch, interruptAfter) {
  return new StateGraph(state)
    .addNode("first", async () => {
      // 主键让任何意外重跑都直接失败，不能用 upsert 掩盖节点重复执行。
      await pool.query(`INSERT INTO ${table}.node_calls (run_id, node) VALUES ($1, 'first')`, [
        runId,
      ]);
      return { value: "first-result" };
    })
    .addNode("second", async (current) => {
      assert.equal(current.value, "first-result", "不能读取旧 worker 迟到污染的最新状态");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lease = await client.query(
          `SELECT id FROM ${table}.runs WHERE id = $1 AND lease_epoch = $2
             AND lease_owner = $3 AND lease_expires_at > now() FOR UPDATE`,
          [runId, epoch, `worker-${epoch}`],
        );
        assert.equal(lease.rowCount, 1, "交付前必须通过 fencing");
        await client.query(`INSERT INTO ${table}.node_calls (run_id, node) VALUES ($1, 'second')`, [
          runId,
        ]);
        await client.query(`INSERT INTO ${table}.deliveries (run_id, value) VALUES ($1, $2)`, [
          runId,
          current.value,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { value: "delivered" };
    })
    .addEdge(START, "first")
    .addEdge("first", "second")
    .addEdge("second", END)
    .compile({ checkpointer: saver, interruptAfter });
}

try {
  await saver.setup();
  if (phase === "failure") {
    await pool.query("SELECT 1");
    throw new Error("expected-runtime-failure");
  } else if (phase === "prepare") {
    const interrupted = graph(1, ["first"]);
    await interrupted.invoke({ value: "initial" }, makeConfig(1));
    const snapshot = await interrupted.getState(makeConfig(1));
    assert.deepEqual(snapshot.next, ["second"]);
    assert.equal(await promote(snapshot.config, 1), 1);
    console.log(
      JSON.stringify({
        phase,
        checkpointId: snapshot.config.configurable.checkpoint_id,
        pid: process.pid,
      }),
    );
  } else if (phase === "takeover") {
    // 接管故意只改租约，不改合法恢复指针；旧 epoch 的 saver 仍可能接受迟到 checkpoint。
    await pool.query(
      `UPDATE ${table}.runs SET lease_epoch = 2, lease_owner = 'worker-2', lease_expires_at = now() + interval '2 minutes' WHERE id = $1`,
      [runId],
    );
    const run = await getAuthorizedRef();
    const oldConfig = configFromRef(run.checkpoint_ref);
    const tuple = await saver.getTuple(oldConfig);
    assert.ok(tuple);
    const lateConfig = await graph(1).updateState(oldConfig, { value: "stale-worker-result" });
    const latest = await saver.getTuple(makeConfig(1));
    assert.equal(latest.checkpoint.channel_values.value, "stale-worker-result");
    assert.equal(await promote(lateConfig, 1), 0, "旧 worker 必须无法提升引用");
    const stable = await getAuthorizedRef();
    assert.equal(stable.checkpoint_ref.checkpointId, run.checkpoint_ref.checkpointId);
    const authorized = await saver.getTuple(configFromRef(stable.checkpoint_ref));
    assert.equal(authorized.checkpoint.channel_values.value, "first-result");
    console.log(JSON.stringify({ phase, stalePromotionRejected: true, pid: process.pid }));
  } else if (phase === "resume") {
    const run = await getAuthorizedRef();
    assert.equal(run.lease_epoch, 2);
    const tuple = await saver.getTuple(configFromRef(run.checkpoint_ref));
    assert.ok(tuple);
    const fork = await saver.put(
      makeConfig(2),
      tuple.checkpoint,
      { ...tuple.metadata, source: "fork" },
      tuple.checkpoint.channel_versions,
    );
    // 在隔离 thread 中复制 pending writes，保留完整恢复语义。
    for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
      await saver.putWrites(fork, [[channel, value]], taskId);
    }
    assert.equal(await promote(fork, 2), 1);
    const resumed = graph(2);
    const result = await resumed.invoke(null, fork);
    assert.equal(result.value, "delivered");
    const complete = await resumed.getState(makeConfig(2));
    assert.deepEqual(complete.next, []);
    assert.equal(await promote(complete.config, 2), 1);
    console.log(JSON.stringify({ phase, value: result.value, pid: process.pid }));
  } else {
    throw new Error(`未知 runtime 阶段：${phase}`);
  }
} finally {
  // saver 持有同一个 pg Pool，只关闭一次。
  await saver.end();
}
