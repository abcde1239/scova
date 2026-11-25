import { describe, expect, it } from 'vite-plus/test';
import type { AgentClaim } from '@scova/agent-core';
import { primaryArtifactSummary, reportSummary } from '@scova/models';
import type { Coverage, ReportValue } from '@scova/models';
const claim = (kind: AgentClaim['kind'], text: string): AgentClaim => ({
    kind,
    text,
    questionIds: [],
    citations: [],
});
describe('report overview', () => {
    it('covers each frozen object before adding more detail from the broad core question', () => {
        const claims = [
            claim('inference', 'no-cache 允许存储，但每次复用前必须向源站验证。'),
            claim('inference', 'no-store 禁止缓存存储本次响应。'),
            claim(
                'inference',
                'ETag 标识资源版本，并通过 If-None-Match 验证；匹配时返回无正文的 304。',
            ),
            claim('insufficient', '未核实的扩展观点不应进入摘要。'),
        ];
        const selections: ReportValue['selections'] = claims.map((entry, claimIndex) => ({
            claimIndex,
            questionIds: ['q0'],
            placement: 'main',
            reason: '测试原文',
            basis: 'model_assessment',
            timeScope: 'unknown',
            assessment: {
                relevance: 'direct',
                support: 'direct',
                role: 'answer',
                sourceRelation: 'unknown',
                reason: '材料支持',
                conditions: claimIndex === 2 ? '针对 GET 缓存验证。' : '',
                gap: '',
            },
        }));
        const summary = primaryArtifactSummary(claims, {
            reportValue: {
                version: 1,
                questions: [
                    {
                        id: 'q0',
                        text: '比较缓存控制并解释验证流程',
                        priority: 'core',
                        status: 'supported',
                        claimIndexes: [0, 1, 2, 3],
                        gap: '',
                    },
                ],
                selections,
            },
            artifacts: [
                {
                    format: 'brief',
                    claimIndexes: [0, 1, 2, 3],
                    coverage: {
                        version: 1,
                        requirements: ['no-cache', 'no-store', 'ETag'].map((object, index) => ({
                            id: `r${index}`,
                            questionIds: ['q0'],
                            object,
                            field: '行为',
                            required: true,
                            status: 'supported',
                            claimIndexes: [index],
                            gap: '',
                        })),
                    },
                },
            ],
        });
        for (const item of claims.slice(0, 3)) expect(summary).toContain(item.text);
        expect(summary).toContain('针对 GET 缓存验证。');
        expect(summary).not.toContain('未核实的扩展观点');
        expect(Array.from(summary).length).toBeLessThanOrEqual(2000);
    });
    const value = (): ReportValue => ({
        version: 1,
        questions: [
            {
                id: 'q0',
                text: '截止时间？',
                priority: 'core',
                status: 'provisional',
                claimIndexes: [0],
                gap: '仅限境内',
            },
            {
                id: 'q1',
                text: '其他线索？',
                priority: 'supporting',
                status: 'unresolved',
                claimIndexes: [],
                gap: '未找到直接材料',
            },
        ],
        selections: [
            {
                claimIndex: 0,
                questionIds: ['q0'],
                placement: 'main',
                reason: '回答核心问题',
                basis: 'model_assessment',
                timeScope: 'unknown',
                assessment: {
                    relevance: 'direct',
                    support: 'direct',
                    role: 'answer',
                    sourceRelation: 'unknown',
                    reason: '原文日期',
                    conditions: '仅限境内',
                    gap: '',
                },
            },
            {
                claimIndex: 1,
                questionIds: ['q1'],
                placement: 'reference',
                reason: '未支持',
                basis: 'unassessed',
                timeScope: 'unknown',
            },
        ],
    });
    it('keeps an important direct fact ahead of an unsupported inference and preserves its condition', () => {
        const summary = reportSummary(
            [claim('fact', '11月5日截止。'), claim('inference', '任何人都能申请。')],
            value(),
        );
        expect(summary).toContain('11月5日截止。');
        expect(summary).toContain('适用条件：仅限境内');
        expect(summary).toContain('主要结论');
        expect(summary).not.toContain('任何人都能申请');
        expect(summary).toContain('暂无直接回答');
    });
    it('never removes conditions to make an answer fit the overview', () => {
        const summary = reportSummary(
            [claim('inference', '长'.repeat(550)), claim('inference', '参考')],
            value(),
        );
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
        expect(summary).toContain('详细回答见正文');
        expect(summary).not.toContain('长');
    });
    it('preserves legacy overview behavior when no artifact snapshot exists', () => {
        const claims = [claim('fact', '11月5日截止。'), claim('inference', '仅供参考。')];
        const reportValue = value();
        expect(primaryArtifactSummary(claims, { reportValue })).toBe(
            reportSummary(claims, reportValue),
        );
        expect(primaryArtifactSummary(claims, {})).toBe(reportSummary(claims));
    });
    it('keeps other artifacts and their insufficiency counts out of the primary overview', () => {
        const claims = [
            claim('inference', '其他形式的推断。'),
            claim('insufficient', '其他形式缺失的证据。'),
            claim('fact', '清单主成果的核实事实。'),
        ];
        const summary = primaryArtifactSummary(claims, {
            artifacts: [
                { format: 'list', claimIndexes: [2] },
                { format: 'research_report', claimIndexes: [0, 1] },
            ],
        });
        expect(summary).toBe('清单主成果的核实事实。');
    });
    it('remaps noncontiguous primary claims and retains their selection conditions without mutating the union', () => {
        const claims = [
            claim('inference', '仅其他形式中的回答。'),
            claim('inference', '主成果第二条。'),
            claim('fact', '主成果已核实的截止日期。'),
        ];
        const reportValue = value();
        reportValue.questions[0].claimIndexes = [2];
        reportValue.selections[0].claimIndex = 2;
        const coverage = {
            reportValue,
            artifacts: [
                { format: 'brief' as const, claimIndexes: [2, 1] },
                { format: 'list' as const, claimIndexes: [0] },
            ],
        };
        const original = structuredClone({ claims, coverage });
        const summary = primaryArtifactSummary(claims, coverage);
        expect(summary).toContain('主成果已核实的截止日期。');
        expect(summary).toContain('适用条件：仅限境内');
        expect(summary).not.toContain('仅其他形式中的回答');
        expect({ claims, coverage }).toEqual(original);
    });
    it('recomputes missing answers and dispute status within the primary artifact', () => {
        const claims = [
            claim('conflict', '仅其他形式有争议的结论。'),
            claim('fact', '主成果独立支持的事实。'),
        ];
        const reportValue = value();
        reportValue.questions[0].status = 'disputed';
        reportValue.questions[0].claimIndexes = [0, 1];
        reportValue.questions[1].status = 'provisional';
        reportValue.questions[1].claimIndexes = [0];
        reportValue.questions[1].gap = '仅其他形式的内部缺口。';
        reportValue.selections = [
            { ...reportValue.selections[0], claimIndex: 0, questionIds: ['q0', 'q1'] },
            { ...reportValue.selections[0], claimIndex: 1 },
        ];
        const summary = primaryArtifactSummary(claims, {
            reportValue,
            artifacts: [
                { format: 'brief', claimIndexes: [1] },
                { format: 'research_report', claimIndexes: [0] },
            ],
        });
        expect(summary).toContain('主要结论');
        expect(summary).toContain('主成果独立支持的事实。');
        expect(summary).toContain('暂无直接回答');
        expect(summary).toContain('本成果尚无该问题的直接回答');
        expect(summary).not.toContain('不同来源');
        expect(summary).not.toContain('仅其他形式');
    });
    const assessed = (texts: string[], questions: string[], links: number[][]): ReportValue => ({
        version: 1,
        questions: questions.map((text, i) => ({
            id: `q${i}`,
            text,
            priority: i === 0 ? 'core' : 'supporting',
            status: 'provisional',
            gap: '全问题缺口不应重复拼入摘要',
            claimIndexes: links.flatMap((ids, index) => (ids.includes(i) ? [index] : [])),
        })),
        selections: texts.map((_, i) => ({
            claimIndex: i,
            questionIds: links[i].map((id) => `q${id}`),
            placement: 'main',
            basis: 'model_assessment',
            reason: '回答问题',
            timeScope: 'within',
            assessment: {
                relevance: 'direct',
                support: 'direct',
                role: 'answer',
                sourceRelation: 'original',
                reason: '原文支持',
                conditions: '',
                gap: '',
            },
        })),
    });
    const structured = (
        texts: string[],
        groups: number[][],
    ): Pick<Coverage, 'artifacts' | 'reportValue'> => ({
        reportValue: assessed(
            texts,
            ['机制及恢复条件'],
            texts.map(() => [0]),
        ),
        artifacts: [
            {
                format: 'research_report',
                claimIndexes: texts.map((_, index) => index),
                coverage: {
                    version: 1,
                    requirements: groups.map((claimIndexes, index) => ({
                        id: `r${index}`,
                        questionIds: ['q0'],
                        object: '操作机制',
                        field: `字段${index}`,
                        required: true,
                        status: 'supported',
                        claimIndexes,
                        gap: '',
                    })),
                },
            },
        ],
    });
    it('keeps the mechanism and prerequisite chain instead of choosing the shortest example', () => {
        const texts = [
            '并发更新时后手等待先手，先手提交后重新计算 WHERE，仅仍匹配时继续。',
            '预定义目标行的简单更新通常足够。',
            '先手提交且实际更新或删除该行时，后手会收到并发更新错误。',
            '收到该错误后，应中止当前事务并从开头重试整个事务。',
        ];
        const coverage = structured(texts, [
            [0, 1],
            [2, 3],
        ]);
        coverage.reportValue!.selections[1].assessment!.role = 'condition';
        coverage.reportValue!.selections[2].assessment!.role = 'risk';
        coverage.reportValue!.selections[2].assessment!.conditions = '不仅是锁定；先手实际提交。';
        const claims = texts.map((text) => claim('inference', text));
        const before = structuredClone({ claims, coverage });
        const summary = primaryArtifactSummary(claims, coverage);
        for (const text of texts) expect(summary).toContain(text);
        expect(summary.indexOf(texts[2])).toBeLessThan(summary.indexOf(texts[3]));
        expect(summary).toContain('不仅是锁定；先手实际提交。');
        expect({ claims, coverage }).toEqual(before);
    });
    it('does not let a previously selected member hide the rest of a compound field', () => {
        const texts = ['已知机制。', '触发条件下会报错。', '收到该错误后重试整个操作。'];
        const summary = primaryArtifactSummary(
            texts.map((text) => claim('inference', text)),
            structured(texts, [[0], [0, 1, 2]]),
        );
        for (const text of texts) expect(summary).toContain(text);
        expect(summary.split(texts[0])).toHaveLength(2);
    });
    it('defers an oversized chain without retaining only its short context-dependent action', () => {
        const texts = ['独立的已知机制。', '必要前提。'.repeat(370), '收到该错误后重试。'];
        const summary = primaryArtifactSummary(
            texts.map((text) => claim('inference', text)),
            structured(texts, [[0], [1, 2]]),
        );
        expect(summary).toContain(texts[0]);
        expect(summary).not.toContain(texts[2]);
        expect(summary).toContain('另有1项已取得的信息及完整条件见正文');
        expect(summary).toContain('包括操作机制 · 字段1');
        expect(Array.from(summary).length).toBeLessThanOrEqual(2000);
    });
    it('deduplicates shared answers and prefers the specific cleanup answer for the second question', () => {
        const texts = [
            'computed 缓存派生值，watch 处理副作用。',
            '响应式依赖变化时更新 computed。',
            '失效时清理异步副作用，onWatcherCleanup 注册中止任务。',
        ];
        const v = assessed(
            texts,
            ['比较 computed 缓存和 watch 副作用', '响应式依赖和清理失效副作用'],
            [[0, 1], [1], [1]],
        );
        v.selections[2].assessment!.conditions = '需要 Vue 3.5+，在同步阶段注册。';
        v.selections[2].assessment!.gap = '尚未覆盖组件卸载。';
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        expect(summary.split(texts[0])).toHaveLength(2);
        expect(summary).toContain(texts[2]);
        expect(summary).toContain('适用条件：需要 Vue 3.5+，在同步阶段注册。');
        expect(summary).toContain('补充说明：尚未覆盖组件卸载。');
        expect(summary).not.toContain('全问题缺口');
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('adds a complementary core answer while reserving space for the supporting question', () => {
        const texts = [
            'freshness 表示新鲜可复用，validation 表示验证。',
            'no-cache 允许存储但需验证；no-store 禁止存储。',
            'ETag 未变时返回 304，减少传输。',
        ];
        const v = assessed(
            texts,
            ['解释 freshness 和 validation，比较 no-cache 和 no-store', 'ETag 如何减少传输'],
            [[0], [0], [1]],
        );
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        for (const text of texts) expect(summary).toContain(text);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('keeps a direct mechanism answer ahead of a risk that happens to repeat more query terms', () => {
        const texts = [
            'ETag 标识版本，未变时返回无响应体的 304。',
            'ETag 请求在多服务器部署时可能失配。',
        ];
        const v = assessed(texts, ['ETag 条件请求如何减少传输'], [[0], [0]]);
        v.selections[1].assessment!.role = 'risk';
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        expect(summary.indexOf(texts[0])).toBeGreaterThan(-1);
        if (summary.includes(texts[1]))
            expect(summary.indexOf(texts[0])).toBeLessThan(summary.indexOf(texts[1]));
    });
    it('recognizes a Chinese concept split into single characters and gives core detail space before secondary expansion', () => {
        const texts = [
            'computed 用于派生数据，watch 用于副作用。',
            'computed 缓存结果，依赖不变时直接复用，变化后重新计算。',
            '依赖追踪以明确指定的源为范围。' + '说明。'.repeat(28),
            '失效时清理旧任务。' + '清理。'.repeat(28),
        ];
        const v = assessed(
            texts,
            [
                '比较 computed 与 watch 的场景，说明缓存和副作用的区别。',
                '响应式依赖和清理失效副作用',
            ],
            [[0], [0], [1], [1]],
        );
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        expect(summary).toContain(texts[1]);
        expect(summary.indexOf(texts[1])).toBeLessThan(summary.indexOf('响应式依赖和清理'));
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('shortens question labels to fit complementary answers without trimming their conditions or gaps', () => {
        const texts = [
            '数据派生与副作用分工。' + '分工。'.repeat(24),
            '缓存依赖未变时复用。' + '缓存。'.repeat(20),
            '依赖追踪显式源。' + '追踪。'.repeat(20),
            '清理失效异步请求。' + '清理。'.repeat(20),
        ];
        const v = assessed(
            texts,
            [
                '比较计算工具与侦听工具的适用场景，并说明缓存和副作用的区别。',
                '响应式依赖追踪和清理失效副作用应该怎样处理',
            ],
            [[0], [0], [1], [1]],
        );
        for (const s of v.selections) {
            s.assessment!.conditions = '适用于受支持版本。';
            s.assessment!.gap = '其他边界尚未核对。';
        }
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        for (const text of texts) expect(summary).toContain(text);
        expect(summary.split('适用条件：适用于受支持版本。')).toHaveLength(5);
        expect(summary.split('补充说明：其他边界尚未核对。')).toHaveLength(5);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('keeps a core mechanism answer when the overview already mentions all query words', () => {
        const texts = [
            'computed 基于响应式依赖缓存派生值，watch 用于副作用。' + '说明。'.repeat(22),
            'computed 缓存意味着响应式依赖未变时复用结果，依赖变化后重新计算。' +
                '机制。'.repeat(16),
            '失效时清理异步副作用，取消旧请求。' + '清理。'.repeat(48),
            'getter 不应执行副作用。' + '规范。'.repeat(28),
        ];
        const v = assessed(
            texts,
            ['computed watch 缓存和副作用', '清理失效副作用'],
            [[0], [0], [1], [0, 1]],
        );
        v.selections[0].assessment!.role = 'comparison';
        v.selections[3].assessment!.role = 'condition';
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        expect(summary).toContain(texts[0]);
        expect(summary).toContain(texts[1]);
        expect(summary).toContain(texts[2]);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('includes supporting detail when the shorter overview still fits', () => {
        const texts = [
            'freshness 与 validation 的区别。' + '核心定义。'.repeat(26),
            'no-cache 与 no-store 的区别。' + '核心比较。'.repeat(24),
            'ETag 命中 304 时减少传输。' + '补充边界。'.repeat(36),
        ];
        const v = assessed(
            texts,
            ['freshness validation no-cache no-store', 'ETag 如何减少传输'],
            [[0], [0], [1]],
        );
        v.selections[1].assessment!.role = 'comparison';
        for (const selection of v.selections)
            selection.assessment!.conditions = '适用于标准语义；具体实现需核对。';
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        expect(summary).toContain(texts[0]);
        expect(summary).toContain(texts[1]);
        expect(summary).toContain(texts[2]);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('deduplicates normalized text across indexes without calling a shared answer unresolved', () => {
        const texts = ['相同 结论。', '相同\n结论。'];
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            assessed(texts, ['核心结论', '补充结论'], [[0], [1]]),
        );
        expect(summary).toContain('相关回答已在前文列出');
        expect(summary).not.toContain('暂无法回答');
        expect(summary).not.toContain('相同\n结论');
    });
    it('keeps different conditions and conflicts distinct even when the text matches', () => {
        const texts = ['只在指定范围内成立。', '只在指定范围内成立。', '只在指定范围内成立。'];
        const v = assessed(texts, ['核心', '其他范围', '分歧'], [[0], [1], [2]]);
        v.selections[0].assessment!.conditions = '仅境内';
        v.selections[1].assessment!.conditions = '仅境外';
        v.questions[2].status = 'disputed';
        const summary = reportSummary(
            [
                claim('inference', texts[0]),
                claim('inference', texts[1]),
                claim('conflict', texts[2]),
            ],
            v,
        );
        expect(summary.split(texts[0])).toHaveLength(4);
        expect(summary).toContain('仅境内');
        expect(summary).toContain('仅境外');
        expect(summary).toContain('尚未解决分歧');
    });
    it('keeps different viewpoints from one source together while retaining individual conditions', () => {
        const texts = ['缓存复用结果。', '副作用清理任务。', '依赖变化重新计算。'];
        const claims = texts.map((text, index) => ({
            ...claim('inference', text),
            citations: [{ pageId: index === 1 ? 'source-b' : 'source-a', quote: text }],
        }));
        const v = assessed(texts, ['缓存、副作用和依赖'], [[0], [0], [0]]);
        v.selections[0].assessment!.conditions = '依赖未变时';
        v.selections[2].assessment!.conditions = '依赖变化后';
        const before = structuredClone(claims);
        const summary = reportSummary(claims, v);
        for (const text of texts) expect(summary).toContain(text);
        expect(summary).toContain(
            '缓存复用结果。 适用条件：依赖未变时；依赖变化重新计算。 适用条件：依赖变化后',
        );
        expect(summary.indexOf(texts[2])).toBeLessThan(summary.indexOf(texts[1]));
        expect(summary).not.toContain('问题还有补充说明');
        expect(claims).toEqual(before);
    });

    it('does not elevate reference or omitted content and leaves the inputs unchanged', () => {
        const texts = ['核心答案。', '参考内容。', '省略内容。'];
        const v = assessed(texts, ['核心答案'], [[0], [0], [0]]);
        v.selections[1].placement = 'reference';
        v.selections[2].placement = 'omitted';
        const before = structuredClone(v);
        const summary = reportSummary(
            texts.map((t) => claim('inference', t)),
            v,
        );
        expect(summary).toContain(texts[0]);
        expect(summary).not.toContain(texts[1]);
        expect(summary).not.toContain(texts[2]);
        expect(v).toEqual(before);
    });
    it('keeps conflict and background limitations visible without copying every question gap', () => {
        const texts = ['两处截止日期不同。', '背景材料中的制度说明。'];
        const v = assessed(texts, ['日期', '制度'], [[0], [1]]);
        v.questions[0].status = 'disputed';
        v.selections[1].timeScope = 'background';
        const summary = reportSummary(
            [claim('conflict', texts[0]), claim('inference', texts[1])],
            v,
        );
        expect(summary).toContain('尚未解决分歧');
        expect(summary).toContain('尚未解决分歧');
        expect(summary).toContain('时间范围：背景材料');
        expect(summary).not.toContain('全问题缺口');
    });
    it('does not replace an oversized conflict with only a shorter one-sided answer', () => {
        const texts = ['双方分歧'.repeat(150), '一方认为周五截止。'];
        const v = assessed(texts, ['截止日期'], [[0], [0]]);
        v.questions[0].status = 'disputed';
        const summary = reportSummary([claim('conflict', texts[0]), claim('fact', texts[1])], v);
        expect(summary).toContain('不同来源');
        expect(summary).toContain('详细回答见正文');
        expect(summary).not.toContain(texts[1]);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
    });
    it('keeps long questions and unresolved gaps bounded with a visible route to the full answers', () => {
        const v = assessed(
            ['😀'.repeat(550)],
            ['问题'.repeat(400), '补充'.repeat(400), '其他'.repeat(400), '未列问题'],
            [[0]],
        );
        for (const q of v.questions.slice(1)) {
            q.status = 'unresolved';
            q.gap = '缺口'.repeat(500);
        }
        const summary = reportSummary([claim('inference', '😀'.repeat(550))], v);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
        expect(summary).toContain('暂无直接回答');
        expect(summary).toContain('正文');
        expect(summary).not.toContain('😀');
        expect(summary).toContain('1个其余问题');
    });
    it('prioritizes synthesized conclusions and keeps verbatim evidence out of the overview', () => {
        expect(
            reportSummary([
                claim('fact', '原文证据。'),
                claim('inference', '提炼后的结论。'),
                claim('inference', '提炼后的结论。'),
            ]),
        ).toBe('提炼后的结论。');
    });
    it('bounds paragraphs without cutting sentences or Unicode characters', () => {
        const sentence = '😀'.repeat(250) + '。';
        expect(
            reportSummary([
                claim('inference', sentence),
                claim('inference', sentence + '结尾。'),
                claim('inference', '继续。'),
            ]),
        ).toBe(`${sentence}\n\n${sentence}结尾。\n\n继续。`);
        expect(reportSummary([claim('inference', '长'.repeat(601))])).toContain('请查看下方');
    });
    it('keeps explicit insufficiency instead of manufacturing a summary', () => {
        expect(reportSummary([claim('insufficient', '未完成内容归纳。')])).toBe(
            '内容需要补充材料，请查看下方正文和来源。',
        );
    });
    it('keeps uncertainty visible even when the overview prioritizes cited inference', () => {
        expect(
            reportSummary([
                claim('inference', '可以归纳的结论。'),
                claim('insufficient', '尚未证实的线索。'),
            ]),
        ).toBe('可以归纳的结论。\n\n另有1条内容需要补充材料，详情见正文。');
    });
    it('reserves room for the uncertainty warning within the overview limit', () => {
        const summary = reportSummary([
            claim('inference', '长'.repeat(590)),
            claim('insufficient', '需核实。'),
        ]);
        expect(Array.from(summary).length).toBeLessThanOrEqual(600);
        expect(summary).toContain('需要补充材料');
    });
});
