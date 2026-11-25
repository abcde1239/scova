import { describeProperties } from '../common/schema.ts';
import { Type, type Static } from '@sinclair/typebox';
import { RevisionSchema, UuidSchema } from '../common/schema.ts';
import { CreateTaskInputSchema, TaskConfigSchema } from '../task/schema.ts';
import type { ProjectAutonomy } from './settings-evidence.ts';

export type ProjectAutonomyOperation =
    | 'read'
    | 'propose_research'
    | 'start_run'
    | 'create_schedule'
    | 'update_schedule'
    | 'pause_task'
    | 'cancel_run'
    | 'delete'
    | 'unlink'
    | 'update_project_settings';

export type ProjectAutonomyDecision =
    | { outcome: 'execute' }
    | { outcome: 'clarify'; reason: 'ambiguous_target' }
    | { outcome: 'deny'; reason: 'outside_project' }
    | {
          outcome: 'confirm';
          reason: 'explicit_target_required' | 'budget_exceeded' | 'budget_unavailable' | 'policy';
      };

export type ProjectAutonomyInput = {
    autonomy: ProjectAutonomy;
    operation: ProjectAutonomyOperation;
    target: 'explicit' | 'inferred' | 'ambiguous' | 'outside_project';
    budget: 'authorized' | 'exceeded' | 'unavailable';
};

const closed = { additionalProperties: false };
export const ProjectScheduleProposalSchema = Type.Union([
    Type.Object(
        {
            command: Type.Literal('create_schedule'),
            task: { ...CreateTaskInputSchema, description: '计划的研究任务配置' },
        },
        closed,
    ),
    Type.Object(
        {
            command: Type.Literal('update_schedule'),
            taskId: { ...UuidSchema, description: '要调整的项目周期任务标识' },
            revision: { ...RevisionSchema, description: '提议调整时的任务修订号' },
            schedule: TaskConfigSchema.properties.schedule,
            timezone: TaskConfigSchema.properties.timezone,
        },
        closed,
    ),
    Type.Object(
        {
            command: Type.Literal('pause_task'),
            taskId: { ...UuidSchema, description: '要暂停的项目周期任务标识' },
            revision: { ...RevisionSchema, description: '提议暂停时的任务修订号' },
        },
        closed,
    ),
]);
export type ProjectScheduleProposal = Static<typeof ProjectScheduleProposalSchema>;

export const ProjectScheduleActionReceiptSchema = Type.Object(
    {
        actionId: { ...UuidSchema, description: '原始周期动作条目标识' },
        command: Type.Union(
            [
                Type.Literal('create_schedule'),
                Type.Literal('update_schedule'),
                Type.Literal('pause_task'),
            ],
            {
                description: '周期计划动作类型',
            },
        ),
        status: Type.Union(
            [Type.Literal('applied'), Type.Literal('rejected'), Type.Literal('undone')],
            {
                description: '该次决定的状态，撤销使用独立条目记录',
            },
        ),
        taskId: Type.Union([UuidSchema, Type.Null()], { description: '执行产生或影响的任务标识' }),
        runId: Type.Null({ description: '周期动作不会立即启动执行' }),
        taskRevision: Type.Union([RevisionSchema, Type.Null()], {
            description: '动作完成后的任务修订号',
        }),
        previousVersionId: Type.Optional({
            ...UuidSchema,
            description: '调整周期之前的任务配置版本',
        }),
        undoable: Type.Boolean({ description: '该决定是否允许以任务修订为条件撤销' }),
    },
    closed,
);
export type ProjectScheduleActionReceipt = Static<typeof ProjectScheduleActionReceiptSchema>;

[ProjectScheduleProposalSchema, ProjectScheduleActionReceiptSchema].forEach(describeProperties);
