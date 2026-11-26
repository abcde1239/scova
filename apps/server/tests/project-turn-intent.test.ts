import { describe, expect, it } from 'vite-plus/test';
import { projectTurnIntent } from '@/service/project-turn-intent.ts';

const draft = { kind: 'research', start: false };

describe('项目会话意图分流', () => {
    it('不同措辞的研究计划请求都进入研究草案', () => {
        for (const message of [
            '请查过去七天开源许可证变更，优先官方发布说明。先帮我拟研究计划。',
            '发起一次新研究：跟踪过去七天开源许可证变更，优先查看官方发布说明，输出简报。',
            '起草研究计划：过去七天开源许可证变更，优先查阅官方发布说明，输出简报。',
            '围绕欧盟电池法规更新，帮我制定一份研究方案',
            'Draft a new research plan on EU battery regulation updates',
        ])
            expect(projectTurnIntent(message), message).toMatchObject({ kind: 'research' });
    });

    it('句中研究短语只起草，不自动启动', () => {
        expect(projectTurnIntent('跟踪开源许可证变更，发起一次新研究')).toEqual(draft);
    });

    it('只有研究短语、没有主题时请求澄清', () => {
        for (const message of ['先帮我拟研究计划', '发起一次新研究', '帮我拟个研究计划吧'])
            expect(projectTurnIntent(message), message).toEqual({ kind: 'clarify' });
    });

    it('询问已有成果或研究内容时保持问答', () => {
        for (const message of [
            '这份报告的研究计划写得怎么样',
            '我们之前开始研究的结果如何',
            '总结一下已有报告的结论',
            '新研究计划有哪些风险？',
        ])
            expect(projectTurnIntent(message), message).toEqual({ kind: 'answer' });
    });

    it('保留行首研究命令与立即启动语义', () => {
        expect(projectTurnIntent('请立即开始研究轨道交通车辆的能耗指标')).toEqual({
            kind: 'research',
            start: true,
        });
        expect(projectTurnIntent('请现在开始研究这个')).toEqual({ kind: 'clarify' });
    });
});
