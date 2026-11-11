import { describe, expect, it } from 'vite-plus/test';
import { compactCoverageGaps } from '../src/coverage-gaps.ts';

describe('coverage limitation presentation', () => {
    it('groups repeated failed attempts and duplicate required fields without hiding missing coverage', () => {
        const gaps = compactCoverageGaps([
            '第 1 次搜索失败，未获得可验证正文',
            '第 2 次搜索失败，未获得可验证正文',
            '第 1 个来源正文采集失败',
            '第 3 个来源正文采集失败',
            '所需信息尚未完整覆盖：json 接口',
            '所需信息尚未完整覆盖：json 接口',
            '所需信息尚未完整覆盖：datetime 时区',
        ]);
        expect(gaps).toHaveLength(3);
        expect(gaps[0]).toContain('2次搜索失败');
        expect(gaps[1]).toContain('2个来源正文采集失败');
        expect(gaps[2]).toContain('共2项');
        expect(gaps[2]).toContain('尚未完整覆盖');
    });
    it('keeps unknown material limitations, source restrictions and partial input intact', () => {
        const gaps = [
            '综合输入受预算限制，仅查阅任务相关正文片段，未完整覆盖来源原文',
            '部分来源仅提供公开摘要或订阅预览，未取得受限全文',
            'Node.js v22 适用范围未知',
            '接口仅对已登录账号可用，匿名访问未知',
        ];
        expect(compactCoverageGaps([...gaps, gaps[0]!])).toEqual(gaps);
        expect(compactCoverageGaps([])).toEqual([]);
    });
});
