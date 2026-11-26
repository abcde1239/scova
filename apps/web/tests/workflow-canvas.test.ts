import { describe, expect, it } from 'vite-plus/test';
import type { WorkflowCanvasGraph } from '@scova/models';
import { canvasIssues } from '@/utils/workflow/canvas';

const taskId = '00000000-0000-4000-8000-000000000001';
const edge = (from: string, to: string) => ({
    from: { nodeId: from, port: 'out' as const },
    to: { nodeId: to, port: 'in' as const },
});
const graph = (edges: ReturnType<typeof edge>[], secondTask = taskId): WorkflowCanvasGraph => ({
    version: 2,
    nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'study', taskId },
        { id: 'b', type: 'study', taskId: secondTask },
        { id: 'end', type: 'end' },
    ],
    edges,
    layout: { positions: {}, groups: [] },
});
const parallel = [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')];
const serial = [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')];

describe('画布节点问题', () => {
    it('并行研究节点绑定同一任务时在两个节点上提示', () => {
        const issues = canvasIssues(graph(parallel));
        expect(issues.get('a')).toContain('需要绑定不同任务');
        expect(issues.get('b')).toContain('需要绑定不同任务');
        expect(issues.get('start')).toBe('');
        expect(issues.get('end')).toBe('');
    });

    it('串行连接或绑定不同任务时没有问题', () => {
        expect([...canvasIssues(graph(serial)).values()].every((issue) => !issue)).toBe(true);
        const different = graph(parallel, '00000000-0000-4000-8000-000000000002');
        expect([...canvasIssues(different).values()].every((issue) => !issue)).toBe(true);
    });

    it('未选择任务优先提示选择任务', () => {
        expect(canvasIssues(graph(parallel, '')).get('b')).toBe('请选择研究任务。');
    });

    it('未连接到结束的分支仍按原规则提示', () => {
        const dangling = canvasIssues(
            graph([edge('start', 'a'), edge('a', 'end'), edge('start', 'b')], 'x'),
        );
        expect(dangling.get('b')).toBe('此节点所在分支尚未连接到结束。');
    });
});
