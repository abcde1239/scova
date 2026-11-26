import { describe, expect, it } from 'vite-plus/test';
import { concurrentStudyConflicts, type WorkflowCanvasNode } from '../src/index.ts';

const taskA = '00000000-0000-4000-8000-00000000000a';
const taskB = '00000000-0000-4000-8000-00000000000b';
const study = (id: string, taskId: string): WorkflowCanvasNode => ({ id, type: 'study', taskId });
const nodes = [study('a', taskA), study('b', taskA), study('c', taskB)];
const ancestors = (edges: Record<string, string[]>) => (id: string) => new Set(edges[id] ?? []);

describe('可能同时运行的研究节点', () => {
    it('无祖先关系且绑定同一任务时标记双方', () => {
        expect(concurrentStudyConflicts(nodes, ancestors({}))).toEqual(new Set(['a', 'b']));
    });

    it('串行依赖或不同任务不冲突', () => {
        expect(concurrentStudyConflicts(nodes, ancestors({ b: ['a'] }))).toEqual(new Set());
        expect(concurrentStudyConflicts(nodes, ancestors({ a: ['b'] }))).toEqual(new Set());
        expect(concurrentStudyConflicts([nodes[0]!, nodes[2]!], ancestors({}))).toEqual(new Set());
    });

    it('任务 ID 忽略大小写，未选择任务的节点不参与', () => {
        const upper = study('d', taskA.toUpperCase());
        expect(concurrentStudyConflicts([nodes[0]!, upper], ancestors({}))).toEqual(
            new Set(['a', 'd']),
        );
        expect(concurrentStudyConflicts([study('e', ''), study('f', '')], ancestors({}))).toEqual(
            new Set(),
        );
    });

    it('只标记真正可能并发的节点', () => {
        // a → b in series, c parallel to both and bound to the same task.
        const graph = [study('a', taskA), study('b', taskA), study('c', taskA)];
        expect(concurrentStudyConflicts(graph, ancestors({ b: ['a'] }))).toEqual(
            new Set(['a', 'b', 'c']),
        );
        expect(concurrentStudyConflicts(graph, ancestors({ b: ['a'], c: ['a', 'b'] }))).toEqual(
            new Set(),
        );
        expect(concurrentStudyConflicts([], ancestors({}))).toEqual(new Set());
    });
});
