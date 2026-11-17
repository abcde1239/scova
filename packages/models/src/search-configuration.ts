import { Type, type Static } from '@sinclair/typebox';
import { InstantSchema } from './common.ts';

const SearchApiFields = {
    protocol: Type.Union(
        [Type.Literal('deepseek'), Type.Literal('perplexity'), Type.Literal('tavily')],
        { description: '独立搜索 API 协议' },
    ),
    baseUrl: Type.String({
        minLength: 8,
        maxLength: 500,
        description: '搜索 API 公网 HTTPS 根地址',
    }),
    contentMode: Type.Union([Type.Literal('reader'), Type.Literal('prefer_api')], {
        description: '兼容历史字段；两值均由 Search API 搜索和读取，不调用本地 Reader',
    }),
};
const Mode = Type.Union([Type.Literal('api'), Type.Literal('searxng')], {
    description: '账号默认搜索方式，与解析和任务执行模型独立',
});
const Revision = Type.Integer({ minimum: 1, description: '上次读取的修订号；仅首次保存省略' });

export const SearchConfigurationInputSchema = Type.Object(
    {
        revision: Type.Optional(Revision),
        defaultMode: Mode,
        api: Type.Optional(
            Type.Union(
                [
                    Type.Object(
                        {
                            ...SearchApiFields,
                            apiKey: Type.Optional(
                                Type.String({
                                    minLength: 1,
                                    maxLength: 4096,
                                    pattern: '^\\S+$',
                                    description: '独立搜索密钥，只写不回显',
                                }),
                            ),
                        },
                        { additionalProperties: false },
                    ),
                    Type.Null(),
                ],
                { description: '省略保留 API 配置，null 移除；地址或协议变更必须重新填写密钥' },
            ),
        ),
    },
    { additionalProperties: false, description: '保存账号独立搜索与正文提取配置' },
);
export const SearchConfigurationSchema = Type.Object(
    {
        revision: Revision,
        defaultMode: Mode,
        api: Type.Union(
            [
                Type.Object(
                    {
                        ...SearchApiFields,
                        hasApiKey: Type.Literal(true, { description: '已保存独立搜索密钥' }),
                    },
                    { additionalProperties: false },
                ),
                Type.Null(),
            ],
            { description: '脱敏搜索 API 配置；空值表示尚未保存' },
        ),
        updatedAt: InstantSchema,
    },
    { additionalProperties: false, description: '独立搜索配置，不包含密钥或模型配置' },
);
export const SearchConfigurationResultSchema = Type.Object(
    {
        configuration: Type.Union([SearchConfigurationSchema, Type.Null()], {
            description: '账号独立搜索配置；空值表示尚未配置',
        }),
        storageReady: Type.Boolean({ description: '账号凭据加密是否可用' }),
    },
    { additionalProperties: false, description: '仅当前账号可见；不读取服务器默认搜索配置' },
);
export const SearchConfigurationImportSchema = Type.Object(
    { revision: Type.Optional(Revision), providerRevision: Revision },
    { additionalProperties: false, description: '将本人旧模型配置中的搜索 API 复制为独立配置' },
);
export type SearchConfiguration = Static<typeof SearchConfigurationSchema>;
export type SearchConfigurationInput = Static<typeof SearchConfigurationInputSchema>;
export type SearchConfigurationResult = Static<typeof SearchConfigurationResultSchema>;
