import { Type, type Static } from '@sinclair/typebox';
import {
    InstantSchema,
    NotificationPreferenceSchema,
    TimezoneSchema,
    UuidSchema,
    describeProperties,
} from './common.ts';

const EmailSchema = Type.String({
    minLength: 3,
    maxLength: 254,
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    description: '邮箱地址，账号服务负责规范化与唯一性判断',
});
const PasswordSchema = Type.String({
    minLength: 8,
    maxLength: 128,
    description: '8 至 128 位密码，不要求特定组合，禁止写入日志或返回体',
});
export const RegisterInputSchema = Type.Object(
    {
        email: EmailSchema,
        password: PasswordSchema,
        defaultTimezone: TimezoneSchema,
    },
    { additionalProperties: false, description: '邮箱密码注册输入；不接受客户端 userId' },
);
export const LoginInputSchema = Type.Object(
    {
        email: EmailSchema,
        password: Type.String({
            minLength: 1,
            maxLength: 128,
            description: '登录密码，不在客户端重新应用注册强度策略',
        }),
    },
    { additionalProperties: false, description: '登录输入，Cookie 由服务端安全设置' },
);
export const PreferencesSchema = Type.Object(
    {
        defaultTimezone: TimezoneSchema,
        notificationPreference: NotificationPreferenceSchema,
    },
    { additionalProperties: false, description: '账号默认偏好；只影响后续创建的任务草稿' },
);
export const UpdatePreferencesInputSchema = Type.Partial(PreferencesSchema, {
    additionalProperties: false,
    minProperties: 1,
    description: '至少修改一个账号偏好，不追溯改写已有配置版本',
});
export const UserSchema = Type.Object(
    {
        id: UuidSchema,
        email: EmailSchema,
        preferences: PreferencesSchema,
        avatarVersion: Type.Optional(
            Type.Union([UuidSchema, Type.Null()], {
                description: '当前头像的不可变版本；为空或缺省时显示账号首字母',
            }),
        ),
        createdAt: InstantSchema,
    },
    {
        additionalProperties: false,
        description: '当前会话用户，不返回密码、token 或数据库内部字段',
    },
);
export const SessionResponseSchema = Type.Object(
    {
        user: UserSchema,
        csrfToken: Type.String({
            minLength: 1,
            description: '后续写请求提交的 CSRF 校验值，不是会话 token',
        }),
    },
    {
        additionalProperties: false,
        description: '登录或恢复会话结果；凭据只通过 HttpOnly Cookie 传递',
    },
);
for (const schema of [
    RegisterInputSchema,
    LoginInputSchema,
    PreferencesSchema,
    UpdatePreferencesInputSchema,
    UserSchema,
    SessionResponseSchema,
])
    describeProperties(schema);
export type RegisterInput = Static<typeof RegisterInputSchema>;
export type LoginInput = Static<typeof LoginInputSchema>;
export type Preferences = Static<typeof PreferencesSchema>;
export type UpdatePreferencesInput = Static<typeof UpdatePreferencesInputSchema>;
export type User = Static<typeof UserSchema>;
export type SessionResponse = Static<typeof SessionResponseSchema>;
