import { Type } from '@sinclair/typebox';
import { InstantSchema, refineSchema } from './common.ts';

export const SourceDateSchema = refineSchema(
    Type.Object(
        {
            status: Type.Union([
                Type.Literal('known'),
                Type.Literal('unknown'),
                Type.Literal('conflict'),
            ]),
            instant: Type.Union([InstantSchema, Type.Null()]),
            value: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
            precision: Type.Union([
                Type.Literal('instant'),
                Type.Literal('day'),
                Type.Literal('local'),
                Type.Null(),
            ]),
        },
        {
            additionalProperties: false,
            description: '来源声明时间；日期或无时区时间不冒充精确UTC时刻',
        },
    ),
    'ScovaSourceDate',
    (v) =>
        v.status === 'known'
            ? !!v.value &&
              !!v.precision &&
              (v.precision === 'instant' ? v.instant === v.value : v.instant === null)
            : v.instant === null && v.value === null && v.precision === null,
);

export const SourceDatesSchema = Type.Object(
    {
        published: SourceDateSchema,
        modified: SourceDateSchema,
    },
    {
        additionalProperties: false,
        description: '发布时间与更新时间分别保留，不用抓取时间或更新时间替代发布时间',
    },
);
