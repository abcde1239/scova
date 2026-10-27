import type { TaskConfig, TaskDraftInput } from '@scova/contracts';

export function draftConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
    return {
        title: '英语听力材料',
        topic: 'B1英语听力材料',
        goal: '寻找带英文字幕的免费听力材料',
        focusPoints: ['英文字幕', '免费'],
        exclusions: ['付费课程'],
        sourcePreferences: { preferredUrls: [], excludedUrls: [], officialOnly: false },
        timeRange: { kind: 'rolling', days: 7 },
        timezone: 'Asia/Tokyo',
        schedule: { frequency: 'manual' },
        outputFormat: 'brief',
        budget: {
            maxSearches: 10,
            maxPages: 20,
            maxDurationSeconds: 300,
            maxInputTokens: 40_000,
            maxOutputTokens: 8_000,
        },
        notificationPreference: { mode: 'off', runIssues: false },
        ...overrides,
    };
}

export const draftExamples: { input: TaskDraftInput; config: TaskConfig }[] = [
    {
        input: {
            inputText:
                '每周一上午9点，日本时间，找最近7天免费B1英语听力，必须有字幕，不要付费/C1，输出清单。',
        },
        config: draftConfig({
            schedule: { frequency: 'weekly', weekday: 1, localTime: '09:00' },
            exclusions: ['付费', 'C1'],
            outputFormat: 'list',
        }),
    },
    {
        input: {
            inputText:
                '每周五18点纽约时间查https://admission.example.org的官方招生通知，最近30天，重点条件与截止日期，用对比表。',
        },
        config: draftConfig({
            title: '学校招生信息',
            topic: '学校招生',
            goal: '确认招生与报名日期',
            focusPoints: ['条件', '截止日期'],
            exclusions: [],
            timezone: 'America/New_York',
            sourcePreferences: {
                preferredUrls: ['https://admission.example.org'],
                excludedUrls: [],
                officialOnly: true,
            },
            schedule: { frequency: 'weekly', weekday: 5, localTime: '18:00' },
            timeRange: { kind: 'rolling', days: 30 },
            outputFormat: 'comparison',
        }),
    },
    {
        input: {
            inputText:
                '持续关注小样本学习最近30天的论文原文，比较实验条件、样本量和不同结论，不要把新闻转载当新研究，给研究报告。',
        },
        config: draftConfig({
            title: '小样本学习研究',
            topic: '小样本学习',
            goal: '比较原始论文的实验条件、样本量和结论',
            focusPoints: ['实验条件', '样本量', '不同结论'],
            exclusions: ['新闻转载'],
            timeRange: { kind: 'rolling', days: 30 },
            outputFormat: 'research_report',
        }),
    },
];
