import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema, UuidSchema } from './common.ts';

const ProviderFields = {
    protocol: Type.Union(
        [
            Type.Literal('openai_chat_completions'),
            Type.Literal('openai_json'),
            Type.Literal('anthropic_messages'),
            Type.Literal('gemini'),
        ],
        { description: '供应商接口协议' },
    ),
    name: Type.String({
        minLength: 1,
        maxLength: 80,
        pattern: '\\S',
        description: '供应商配置名称',
    }),
    baseUrl: Type.String({
        minLength: 8,
        maxLength: 500,
        description: '供应商HTTPS服务根地址，包含API版本路径',
    }),
    model: Type.String({
        minLength: 1,
        maxLength: 160,
        pattern: '^\\S+$',
        description: '供应商实际模型ID',
    }),
};
const Secret = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern: '^\\S+$',
    description: 'API密钥，仅写入且不回显',
});
export const AgentProviderInputSchema = Type.Object(
    { ...ProviderFields, apiKey: Secret },
    { additionalProperties: false, description: '当前账号的供应商配置' },
);
export const AgentProviderUpdateSchema = Type.Object(
    {
        ...ProviderFields,
        apiKey: Type.Optional(Secret),
        revision: Type.Integer({ minimum: 1, description: '编辑时读取的修订号' }),
    },
    { additionalProperties: false, description: '更新供应商；不传密钥保留原值' },
);
export const AgentProviderSchema = Type.Object(
    {
        id: UuidSchema,
        ...ProviderFields,
        hasApiKey: Type.Boolean({ description: '是否保存密钥，不返回密钥内容或片段' }),
        active: Type.Boolean({ description: '是否用于研究执行与报告问答' }),
        draftActive: Type.Boolean({ description: '是否用于任务需求整理' }),
        revision: Type.Integer({ minimum: 1, description: '修订号' }),
        updatedAt: InstantSchema,
    },
    { additionalProperties: false, description: '脱敏的账号级供应商配置' },
);
export const AgentProviderListSchema = Type.Object(
    {
        items: Type.Array(AgentProviderSchema, { description: '当前账号的供应商配置列表' }),
        systemConfigured: Type.Boolean({ description: '部署默认模型是否配置完整' }),
        storageReady: Type.Boolean({ description: '服务端是否配置密钥加密主密钥' }),
    },
    { additionalProperties: false, description: '仅当前账号可见的供应商列表' },
);
export const AgentProviderRevisionSchema = Type.Object(
    { revision: Type.Integer({ minimum: 1, description: '操作前读取的修订号' }) },
    { additionalProperties: false, description: '供应商操作并发校验' },
);
export const AgentProviderPurposeSchema = Type.Union(
    [Type.Literal('research'), Type.Literal('task_draft')],
    { description: '模型用途：研究执行（含报告问答）或任务需求整理' },
);
export const AgentProviderActivationSchema = Type.Object(
    {
        revision: Type.Integer({ minimum: 1, description: '操作前读取的修订号' }),
        purpose: Type.Optional(AgentProviderPurposeSchema),
    },
    { additionalProperties: false, description: '仅切换指定用途，省略用途时切换研究执行模型' },
);
export type AgentProviderPurpose = Static<typeof AgentProviderPurposeSchema>;
export type AgentProvider = Static<typeof AgentProviderSchema>;
export type AgentProviderInput = Static<typeof AgentProviderInputSchema>;
export type AgentProviderUpdate = Static<typeof AgentProviderUpdateSchema>;
export type AgentProviderList = Static<typeof AgentProviderListSchema>;

export const AgentModelCatalogInputSchema = Type.Object(
    {
        baseUrl: ProviderFields.baseUrl,
        protocol: ProviderFields.protocol,
        apiKey: Type.Optional(Secret),
        providerId: Type.Optional(UuidSchema),
        revision: Type.Optional(Type.Integer({ minimum: 1, description: '已保存配置的修订号' })),
    },
    {
        additionalProperties: false,
        description: '读取供应商模型目录；新配置需传密钥，已有配置可复用本人密钥',
    },
);
export const AgentModelCatalogSchema = Type.Object(
    {
        items: Type.Array(
            Type.Object(
                {
                    id: ProviderFields.model,
                    name: Type.String({
                        minLength: 1,
                        maxLength: 200,
                        description: '模型显示名称',
                    }),
                },
                { additionalProperties: false, description: '供应商返回的模型条目' },
            ),
            { maxItems: 1000, description: '可选模型；目录可见不代表具备研究所需能力' },
        ),
        truncated: Type.Boolean({ description: '是否因数量或分页限制仅返回部分模型' }),
    },
    { additionalProperties: false, description: '供应商模型目录；不包含密钥或上游原始响应' },
);
export type AgentModelCatalogInput = Static<typeof AgentModelCatalogInputSchema>;
export type AgentModelCatalog = Static<typeof AgentModelCatalogSchema>;

export const AgentProviderBalanceInputSchema = Type.Object(
    {
        revision: Type.Integer({ minimum: 1, description: '查询时读取的供应商修订号' }),
        template: Type.Optional(
            Type.Union([Type.Literal('auto'), Type.Literal('new_api'), Type.Literal('sub2api')], {
                description: '余额模板；默认仅识别已支持的官方供应商',
            }),
        ),
    },
    {
        additionalProperties: false,
        description: '手动读取本人已存供应商的余额或Key额度，不调用生成接口',
    },
);
export const AgentProviderBalanceSchema = Type.Object(
    {
        adapter: Type.Union(
            [
                Type.Literal('deepseek'),
                Type.Literal('openrouter'),
                Type.Literal('siliconflow'),
                Type.Literal('new_api'),
                Type.Literal('sub2api'),
            ],
            { description: '实际使用的额度查询适配器' },
        ),
        checkedAt: InstantSchema,
        items: Type.Array(
            Type.Object(
                {
                    label: Type.String({
                        minLength: 1,
                        maxLength: 80,
                        description: '额度类型说明',
                    }),
                    scope: Type.Union(
                        [
                            Type.Literal('account'),
                            Type.Literal('key'),
                            Type.Literal('subscription'),
                        ],
                        { description: '额度所属范围，Key上限不代表账号余额' },
                    ),
                    unit: Type.String({
                        minLength: 1,
                        maxLength: 24,
                        description: '供应商计费币种或额度单位，不作汇率换算',
                    }),
                    remaining: Type.Optional(
                        Type.Number({ description: '可用余额或额度，负数表示欠额' }),
                    ),
                    used: Type.Optional(
                        Type.Number({ minimum: 0, description: '供应商返回的已用额度' }),
                    ),
                    total: Type.Optional(
                        Type.Number({ minimum: 0, description: '供应商返回的总额度或上限' }),
                    ),
                    unlimited: Type.Optional(
                        Type.Boolean({ description: 'Key没有单独限额，不表示账号免费或余额无限' }),
                    ),
                },
                { additionalProperties: false, description: '一项供应商余额或额度' },
            ),
            { minItems: 1, maxItems: 10, description: '仅保留归一化额度，不公开上游原始响应' },
        ),
    },
    {
        additionalProperties: false,
        description: '供应商额度查询结果快照，不保证执行时仍有相同余额',
    },
);
export type AgentProviderBalanceInput = Static<typeof AgentProviderBalanceInputSchema>;
export type AgentProviderBalance = Static<typeof AgentProviderBalanceSchema>;
