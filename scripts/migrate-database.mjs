import { migrateDatabase } from '@scova/db/migrate';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('缺少 DATABASE_URL；迁移前先备份并停止 API/Worker');
const result = await migrateDatabase({ connectionString });
console.log(JSON.stringify({ database: result.migrated ? 'migrated' : 'current', ...result }));
