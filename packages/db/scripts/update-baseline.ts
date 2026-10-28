import { writeFile } from 'node:fs/promises';
import { generateSchemaBaseline } from '../src/migrate.ts';

const connectionString = process.env.SCOVA_TEST_DATABASE_URL;
if (!connectionString)
    throw new Error(
        '设置专用 SCOVA_TEST_DATABASE_URL 后生成候选基线；禁止默认使用业务 DATABASE_URL',
    );
const baseline = await generateSchemaBaseline({ connectionString });
await writeFile(
    new URL('../schema-baseline.json', import.meta.url),
    `${JSON.stringify(baseline, null, 4)}\n`,
);
console.log(
    '候选 schema-baseline.json 已生成；必须审查 SQL、journal、snapshot 和基线差异后一起提交。',
);
