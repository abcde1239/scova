import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, describeProperties } from './common.ts';

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const AvatarVersionQuerySchema = describeProperties(
    Type.Object(
        {
            expectedVersion: Type.Union([UuidSchema, Type.Literal('none')], {
                description: '当前头像版本；未设置头像时传none，防止并发覆盖',
            }),
        },
        { additionalProperties: false, description: '头像写入的预期版本' },
    ),
);
export const AvatarStateSchema = describeProperties(
    Type.Object(
        {
            available: Type.Boolean({ description: '当前部署是否已配置头像存储' }),
            version: Type.Union([UuidSchema, Type.Null()], {
                description: '当前账号头像版本，未设置为空',
            }),
        },
        { additionalProperties: false, description: '当前账号头像状态' },
    ),
);
export type AvatarState = Static<typeof AvatarStateSchema>;
export type AvatarVersionQuery = Static<typeof AvatarVersionQuerySchema>;
