import { verifyDatabase } from '@scova/db/migrate';
import { executionTokenPattern } from '@scova/execution/protocol';

const { WORKER_EXECUTION_TOKEN, DATABASE_URL } = process.env;

if (!WORKER_EXECUTION_TOKEN) {
    console.error('缺少 WORKER_EXECUTION_TOKEN。运行 vp run local:init 补齐本地令牌。');
    process.exitCode = 1;
} else if (!executionTokenPattern.test(WORKER_EXECUTION_TOKEN)) {
    console.error('WORKER_EXECUTION_TOKEN 无效。请为 Server 和 Worker 配置相同的有效令牌。');
    process.exitCode = 1;
} else if (!DATABASE_URL) {
    console.error('缺少 DATABASE_URL。运行 vp run local:up 准备本地基础服务。');
    process.exitCode = 1;
} else {
    try {
        await verifyDatabase({ connectionString: DATABASE_URL });
    } catch (error) {
        console.error(
            error instanceof Error && error.message === '业务数据库存在待执行迁移'
                ? '业务数据库存在待执行迁移。停止旧 Server 和 Worker 后运行 vp run db:migrate，再启动开发环境。'
                : '业务数据库未就绪。请检查 vp run local:status、DATABASE_URL 和数据库迁移状态。',
        );
        process.exitCode = 1;
    }
}
