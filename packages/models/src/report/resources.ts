import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from '../common/schema.ts';

export const REPORT_CHART_MAX_BYTES = 256 * 1024;

const ChartSourceSchema = Type.Object(
    {
        sourceId: UuidSchema,
        evidenceIds: Type.Array(UuidSchema, { minItems: 1, description: '可定位的报告引用标识' }),
    },
    { additionalProperties: false },
);

export const ReportSourceHostRowSchema = Type.Object(
    {
        hostname: Type.String({ minLength: 1, description: '网页主机名' }),
        count: Type.Integer({ minimum: 1, description: '主机内去重来源数' }),
        sources: Type.Array(ChartSourceSchema, {
            minItems: 1,
            description: '去重来源与引用对应关系',
        }),
    },
    { additionalProperties: false },
);
export type ReportSourceHostRow = Static<typeof ReportSourceHostRowSchema>;

export const ReportSourceHostChartSchema = Type.Object(
    {
        id: UuidSchema,
        reportId: UuidSchema,
        reportVersion: InstantSchema,
        rendererVersion: Type.Integer({ minimum: 1, description: '生成该图表的渲染器版本' }),
        expiresAt: InstantSchema,
        downloadUrl: Type.String({ minLength: 1, description: '需要本人会话的临时下载路径' }),
        rows: Type.Array(ReportSourceHostRowSchema, {
            description: '供表格阅读的来源统计和引用出处',
        }),
    },
    { additionalProperties: false, description: '私有报告来源图表及可读表格数据' },
);
export type ReportSourceHostChart = Static<typeof ReportSourceHostChartSchema>;
