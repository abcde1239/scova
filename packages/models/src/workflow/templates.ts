import { Type, type Static } from '@sinclair/typebox';
import { describeProperties, RevisionSchema, UuidSchema } from '../common/schema.ts';
import { WorkflowCanvasGraphSchema, WorkflowCanvasInputSchema } from './schema.ts';

const strict = { additionalProperties: false };
const name = Type.String({ minLength: 1, maxLength: 160, pattern: String.raw`\S` });
const description = Type.String({ maxLength: 1000 });
const fieldBase = {
    label: { ...name, description: '模板表单中显示的字段名称' },
    required: Type.Boolean({ description: '解析默认值后是否必须提供此输入' }),
};

export const WorkflowTemplateFieldSchema = Type.Union([
    Type.Object({ ...fieldBase, key: Type.Literal('csv') }, strict),
    Type.Object({ ...fieldBase, key: Type.Literal('json') }, strict),
    Type.Object({ ...fieldBase, key: Type.Literal('text') }, strict),
    Type.Object({ ...fieldBase, key: Type.Literal('providerId') }, strict),
    Type.Object(
        { ...fieldBase, key: Type.Literal('threshold'), default: Type.Optional(Type.Number()) },
        strict,
    ),
    Type.Object(
        {
            ...fieldBase,
            key: Type.Literal('inventoryColumn'),
            default: Type.Optional(Type.String({ maxLength: 256, pattern: String.raw`\S` })),
        },
        strict,
    ),
    Type.Object(
        {
            ...fieldBase,
            key: Type.Literal('period'),
            default: Type.Optional(Type.String({ maxLength: 128, pattern: String.raw`\S` })),
        },
        strict,
    ),
    Type.Object(
        { ...fieldBase, key: Type.Literal('notify'), default: Type.Optional(Type.Boolean()) },
        strict,
    ),
]);
const fields = Type.Array(WorkflowTemplateFieldSchema, {
    maxItems: 8,
    description: '公开的运行输入及可复用默认值',
});

export const WorkflowTemplateSchema = Type.Object(
    {
        id: UuidSchema,
        version: RevisionSchema,
        kind: Type.Union([Type.Literal('builtin'), Type.Literal('personal')]),
        title: { ...name, description: '模板名称' },
        description: { ...description, description: '适用场景说明' },
        delivery: { ...description, description: '交付内容与格式说明' },
        fields,
        graph: WorkflowCanvasGraphSchema,
        requiresBindings: Type.Boolean({
            description: '是否需要复制到画布并为研究节点重新选择任务',
        }),
        workflowId: Type.Union([UuidSchema, Type.Null()], {
            description: '当前账号的运行历史入口，首次运行前为空',
        }),
    },
    strict,
);
export const WorkflowTemplateListSchema = Type.Object(
    { items: Type.Array(WorkflowTemplateSchema, { description: '内置模板及当前账号的个人模板' }) },
    strict,
);
export const WorkflowTemplateSaveSchema = Type.Object(
    {
        workflowId: UuidSchema,
        versionId: UuidSchema,
        title: { ...name, description: '模板名称' },
        description: { ...description, description: '适用场景说明' },
        delivery: { ...description, description: '交付内容与格式说明' },
        fields,
    },
    strict,
);
export const WorkflowTemplateStartSchema = Type.Object(
    { input: { ...WorkflowCanvasInputSchema, description: '当前模板版本公开的单次运行输入' } },
    strict,
);

export type WorkflowTemplateField = Static<typeof WorkflowTemplateFieldSchema>;
export type WorkflowTemplate = Static<typeof WorkflowTemplateSchema>;
export type WorkflowTemplateSave = Static<typeof WorkflowTemplateSaveSchema>;
export type WorkflowTemplateStart = Static<typeof WorkflowTemplateStartSchema>;

for (const schema of [
    WorkflowTemplateListSchema,
    WorkflowTemplateSaveSchema,
    WorkflowTemplateStartSchema,
])
    describeProperties(schema);
