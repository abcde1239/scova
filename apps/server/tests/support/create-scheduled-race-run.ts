import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@scova/models';
import { createDefaultServices } from '../../src/app/context.ts';
import { createRunService } from '../../src/service/runs.ts';

const url = process.env.SCOVA_SCHEDULER_PROBE_DATABASE_URL;
const userId = process.env.SCOVA_SCHEDULER_PROBE_USER_ID;
const taskId = process.env.SCOVA_SCHEDULER_PROBE_TASK_ID;
if (!url || !userId || !taskId) throw new Error('调度竞争测试缺少必要配置');
const database = new PrismaClient({ datasources: { db: { url } } });
try {
    await database.$connect();
    if (process.send) {
        const go = new Promise<void>((resolve) => process.once('message', () => resolve()));
        process.send({ phase: 'ready' });
        await go;
    }
    const result = await createRunService(createDefaultServices({ db: () => database })).create(
        userId,
        taskId,
        { mode: 'demo' },
        randomUUID(),
    );
    process.stdout.write(JSON.stringify(result));
} finally {
    await database.$disconnect();
    if (process.connected) process.disconnect();
}
