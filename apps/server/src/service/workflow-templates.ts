import {
    isWorkflowCanvasGraph,
    parseContract,
    WorkflowTemplateSaveSchema,
    workflowFileMaxBytes,
    WorkflowTemplateStartSchema,
    UuidSchema,
    type WorkflowCanvasGraph,
    type WorkflowCanvasInput,
    type WorkflowCanvasNode,
    type WorkflowGraph,
    type WorkflowTemplate,
    type WorkflowTemplateField,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createWorkflowTemplateRepository } from '@/repo/workflow-templates.ts';
import { validateWorkflowFileInput } from '@/service/canvas-node-execution.ts';
import { workflowCanvasOrder, workflowStages } from '@/service/workflow-graph.ts';
import { createWorkflowService } from '@/service/workflows.ts';
import { ApiError } from '@/utils/errors.ts';

function chain(nodes: WorkflowCanvasNode[]): WorkflowCanvasGraph {
    return {
        version: 2,
        nodes,
        edges: nodes.slice(1).map((node, index) => ({
            from: { nodeId: nodes[index]!.id, port: 'out' },
            to: { nodeId: node.id, port: 'in' },
        })),
        layout: {
            positions: Object.fromEntries(
                nodes.map((node, index) => [node.id, { x: 220 * index, y: 120 }]),
            ),
            groups: [],
        },
    };
}

function builtin(
    data: Pick<
        WorkflowTemplate,
        'id' | 'version' | 'title' | 'description' | 'delivery' | 'fields' | 'graph'
    >,
): WorkflowTemplate {
    return { ...data, kind: 'builtin', requiresBindings: false, workflowId: null };
}

// Append a snapshot when changing a built-in; keep earlier identities and their graphs intact.
const builtins: readonly WorkflowTemplate[] = [
    builtin({
        id: '7c5bbc79-e7f0-4ce2-8cd5-bcf5a95e1b10',
        version: 1,
        title: '库存预警清单',
        description: '筛出库存量低于预警阈值的商品。',
        delivery: '低库存 CSV，可选站内通知。',
        fields: [
            { key: 'csv', label: '库存 CSV', required: true },
            { key: 'inventoryColumn', label: '库存列名', required: true },
            { key: 'threshold', label: '预警阈值', required: true, default: 10 },
            { key: 'notify', label: '发送站内通知', required: false, default: false },
        ],
        graph: chain([
            { id: 'start', type: 'start' },
            {
                id: 'filter',
                type: 'csv',
                label: '筛选低库存',
                config: {
                    source: 'start',
                    filters: [
                        {
                            column: '{{inventoryColumn}}',
                            operator: 'lessThan',
                            value: '{{threshold}}',
                        },
                    ],
                },
            },
            {
                id: 'deliver',
                type: 'deliver',
                config: { source: 'filter', format: 'csv', filename: '低库存清单.csv' },
            },
            {
                id: 'notify',
                type: 'notify',
                config: {
                    source: 'deliver',
                    title: '库存预警清单已生成',
                    body: '打开成果查看低库存商品。',
                },
            },
            { id: 'end', type: 'end' },
        ]),
    }),
    builtin({
        id: 'd2dc5cd3-b1f4-4963-a255-f54b6f10ab20',
        version: 1,
        title: '项目周报',
        description: '根据项目进度 CSV 生成按已完成事项和阻塞事项组织的周报。',
        delivery: 'Markdown 周报，可选站内通知。',
        fields: [
            { key: 'csv', label: '项目进度 CSV', required: true },
            { key: 'period', label: '周报周期', required: true },
            { key: 'providerId', label: '生成模型', required: true },
            { key: 'notify', label: '发送站内通知', required: false, default: false },
        ],
        graph: chain([
            { id: 'start', type: 'start' },
            {
                id: 'read',
                type: 'csv',
                label: '整理进展',
                config: { source: 'start', filters: [] },
            },
            {
                id: 'generate',
                type: 'generate',
                config: {
                    sources: ['read'],
                    instructions:
                        '根据输入表格撰写 {{period}} 的 Markdown 项目周报。按「已完成事项」和「阻塞事项」组织，保留明确的任务、进展和待解决问题。仅依据输入材料，不编造内容。',
                },
            },
            {
                id: 'deliver',
                type: 'deliver',
                config: { source: 'generate', format: 'markdown', filename: '项目周报.md' },
            },
            {
                id: 'notify',
                type: 'notify',
                config: {
                    source: 'deliver',
                    title: '项目周报已生成',
                    body: '打开成果查看本期周报。',
                },
            },
            { id: 'end', type: 'end' },
        ]),
    }),
];

type TemplateRow = Awaited<
    ReturnType<ReturnType<typeof createWorkflowTemplateRepository>['insert']>
>;

function personal(row: TemplateRow): WorkflowTemplate {
    return {
        id: row.id,
        version: row.version,
        kind: 'personal',
        title: row.title,
        description: row.description,
        delivery: row.delivery,
        graph: row.graphJson,
        fields: row.fieldsJson,
        requiresBindings: row.graphJson.nodes.some((node) => node.type === 'study'),
        workflowId: null,
    };
}

export function snapshotWorkflowTemplateGraph(graph: WorkflowGraph): WorkflowCanvasGraph {
    const canvas: WorkflowCanvasGraph = isWorkflowCanvasGraph(graph)
        ? graph
        : {
              ...graph,
              version: 2,
              layout: {
                  positions: Object.fromEntries(
                      workflowStages(graph).flatMap((stage, column) =>
                          stage.map((node, row) => [node.id, { x: column * 220, y: row * 120 }]),
                      ),
                  ),
                  groups: [],
              },
          };
    const snapshot = structuredClone(canvas);
    for (const node of snapshot.nodes) {
        if (node.type === 'study') node.taskId = '';
    }
    return snapshot;
}

function invalidInput(path: string, message: string): never {
    throw new ApiError(422, 'WORKFLOW_TEMPLATE_INVALID_INPUT', message, [{ path, message }]);
}

export function resolveWorkflowTemplateInput(
    fields: WorkflowTemplateField[],
    input: WorkflowCanvasInput,
): WorkflowCanvasInput {
    const exposed = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(input) as (keyof WorkflowCanvasInput)[]) {
        if (!exposed.has(key)) invalidInput(`/input/${key}`, '模板未公开此输入');
    }
    const entries = fields.flatMap((field) => {
        const { key } = field;
        const supplied = input[key];
        const normalized =
            typeof supplied === 'string' && !['csv', 'json', 'text'].includes(key)
                ? supplied.trim()
                : supplied;
        const value = normalized === undefined && 'default' in field ? field.default : normalized;
        if (field.required && (value === undefined || (typeof value === 'string' && !value.trim())))
            invalidInput(`/input/${key}`, `请填写${field.label}`);
        if (
            key === 'csv' &&
            typeof value === 'string' &&
            Buffer.byteLength(value) > workflowFileMaxBytes
        )
            invalidInput('/input/csv', 'CSV 文件不能超过 256 KiB');
        if (value === undefined) return [];
        if (key === 'providerId' && typeof value === 'string')
            return [[key, value.toLowerCase()] as const];
        return [[key, value === 0 ? 0 : value] as const];
    });
    return Object.fromEntries(entries);
}

export function createWorkflowTemplateService(services: Pick<ApiServices, 'db' | 'clock'>) {
    const repository = createWorkflowTemplateRepository(services.db);
    const workflows = createWorkflowService(services);

    async function resolve(userId: string, templateId: string, templateVersion: string) {
        const id = parseContract(UuidSchema, templateId).toLowerCase();
        const version = Number(templateVersion);
        if (/^[1-9]\d*$/u.test(templateVersion) && version <= 2147483647) {
            const standard = builtins.find((item) => item.id === id && item.version === version);
            if (standard) return standard;
            const row = await repository.find(userId, id, version);
            if (row) return personal(row);
        }
        throw new ApiError(404, 'NOT_FOUND', '模板版本不存在');
    }

    return {
        async list(userId: string) {
            const [rows, executions] = await Promise.all([
                repository.list(userId),
                repository.listExecutions(userId),
            ]);
            const workflowIds = new Map(
                executions.map((execution) => [
                    `${execution.templateId}:${execution.templateVersion}`,
                    execution.workflowId,
                ]),
            );
            return {
                items: [...builtins, ...rows.map(personal)].map((template) => ({
                    ...template,
                    workflowId: workflowIds.get(`${template.id}:${template.version}`) ?? null,
                })),
            };
        },
        async save(userId: string, body: unknown) {
            const input = parseContract(WorkflowTemplateSaveSchema, body);
            if (new Set(input.fields.map((field) => field.key)).size !== input.fields.length)
                invalidInput('/fields', '同一输入只能定义一次');
            const source = await workflows.getVersion(userId, input.workflowId, input.versionId);
            const row = await repository.insert({
                userId,
                title: input.title.trim(),
                description: input.description.trim(),
                delivery: input.delivery.trim(),
                graphJson: snapshotWorkflowTemplateGraph(source.graph),
                fieldsJson: input.fields.map((field) => ({ ...field, label: field.label.trim() })),
                createdAt: services.clock(),
            });
            return personal(row);
        },
        async copy(userId: string, templateId: string, templateVersion: string) {
            const template = await resolve(userId, templateId, templateVersion);
            return workflows.create(userId, {
                title: template.title,
                graph: structuredClone(template.graph),
            });
        },
        async start(
            userId: string,
            templateId: string,
            templateVersion: string,
            body: unknown,
            key: string,
        ) {
            const template = await resolve(userId, templateId, templateVersion);
            if (template.requiresBindings)
                throw new ApiError(
                    422,
                    'WORKFLOW_TEMPLATE_BINDINGS_REQUIRED',
                    '请先复制到画布并为研究节点选择任务',
                );
            const { input } = parseContract(WorkflowTemplateStartSchema, body);
            const resolved = resolveWorkflowTemplateInput(template.fields, input);
            validateWorkflowFileInput(resolved);
            workflowCanvasOrder(template.graph);
            const { workflowId, versionId } = await repository.ensureExecution(
                userId,
                template,
                services.clock(),
            );
            return workflows.start(userId, workflowId, { versionId, input: resolved }, key);
        },
    };
}
