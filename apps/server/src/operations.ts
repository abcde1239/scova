import { operations } from '@/handler/operations.ts';

try {
    const args = process.argv.slice(2);
    // db:migrate is an explicit offline request; the service still checks active DB sessions.
    if (args[0] === 'migrate') process.env.SCOVA_MAINTENANCE ??= '1';
    console.log(JSON.stringify(await operations(args)));
} catch {
    console.error(
        '后端维护失败；请检查命令、维护窗口、依赖与备份文件。未输出连接地址或供应商信息。',
    );
    process.exitCode = 1;
}
