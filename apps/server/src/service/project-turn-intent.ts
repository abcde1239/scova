import type { TaskConfig } from '@scova/models';

const research =
    /^(?:请\s*)?(?:(?:帮我|为我)\s*)?(?:(?:立即|现在)\s*)?(?:开始研究|启动研究|开展研究|发起研究|创建研究|研究|调研|起草|制定研究计划|收集|查找|搜索)|^(?:please\s+)?(?:(?:start|begin)\s+)?(?:research|investigate|find sources|create a research (?:task|plan))\b/i;
const start =
    /^(?:请\s*)?(?:帮我\s*)?(?:(?:立即|现在)(?:开始|启动)?|开始|启动|开展)(?:研究|调研)|^(?:please\s+)?(?:start|begin)\s+(?:the\s+)?research\b/i;
const deferAction =
    /(?:不要|不必|不用|无需|先别|暂不|请勿|暂缓|稍后)\s*(?:立即|现在|马上)?\s*(?:开始|启动|执行|运行|跑)|(?:确认后|确认之后|等我确认|待我确认|先给(?:我)?看?(?:个|一份)?(?:草案|计划))|\b(?:(?:do not|don['’]t|not yet)\s+(?:start|begin|run|execute)|wait for (?:my )?(?:confirmation|approval)|(?:only |until )?after (?:I confirm|approval))\b/i;
const pause =
    /^(?:(?:请|帮我|为我)\s*)*暂停(?:\s*(?:这[个项]|此|该|当前|本)?(?:周期)?(?:计划|任务))?[。!！.]?$|^(?:please\s+)?pause(?:\s+(?:this|the)\s+(?:schedule|task))?[.!]?$/i;
const update =
    /^(?:请\s*)?(?:(?:帮我|为我)\s*)?(?:调整|修改|更改|改为)|^(?:please\s+)?(?:update|change|reschedule)\b/i;
const cadence = /每天|每日|每周|日程|周期|\b(?:daily|weekly|schedule)\b/i;
const vagueTarget =
    /^(?:这[个些]|那[个些]|它|此事|这件事|[这那](?:个)?(?:问题|主题|方向|内容|议题|任务)|(?:(?:about|on)\s+)?(?:it|this|that|these|those)(?:\s+(?:topic|issue|subject|question|task))?)$/i;
const chineseDay = '一二三四五六日天';
const englishDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

type Recurrence = Exclude<TaskConfig['schedule'], { frequency: 'manual' }>;
export function projectTurnIntent(message: string) {
    if (/[?？]/.test(message)) return { kind: 'answer' } as const;
    if (pause.test(message)) return { kind: 'pause' } as const;
    const allowAutomatic = !deferAction.test(message);
    if (
        cadence.test(message) &&
        (update.test(message) ||
            research.test(message) ||
            /^(?:请\s*)?(?:每天|每日|每周|安排|设定|建立)|^(?:please\s+)?schedule\b/i.test(message))
    ) {
        const times = [...new Set(message.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) ?? [])];
        const days = new Set([
            ...Array.from(message.matchAll(/(?:每周|星期|周)([一二三四五六日天])/g), ([, day]) =>
                Math.min(chineseDay.indexOf(day!) + 1, 7),
            ),
            ...englishDays.flatMap((name, index) =>
                new RegExp(`\\b${name}\\b`, 'i').test(message) ? [index + 1] : [],
            ),
        ]);
        const localTime = times.length === 1 ? times[0] : undefined;
        const weekday = [...days][0] ?? 0;
        const schedule: Recurrence | undefined =
            localTime && days.size <= 1
                ? weekday > 0
                    ? { frequency: 'weekly', localTime, weekday }
                    : /每天|每日|\bdaily\b/i.test(message)
                      ? { frequency: 'daily', localTime }
                      : undefined
                : undefined;
        return {
            kind: update.test(message) ? 'reschedule' : 'schedule',
            schedule,
            allowAutomatic,
        } as const;
    }
    const researchCommand = research.exec(message);
    if (researchCommand && message.length >= 7) {
        const target = message
            .slice(researchCommand[0].length)
            .split(/[。！？.!?，,；;]/, 1)[0]!
            .replace(/^[\s:：\p{Quotation_Mark}]+|[\s\p{Quotation_Mark}]+$/gu, '')
            .replace(/(?:一下|吧|\s+now)$/i, '')
            .trim();
        if (!target || vagueTarget.test(target)) return { kind: 'clarify' } as const;
        return { kind: 'research', start: allowAutomatic && start.test(message) } as const;
    }
    return { kind: 'answer' } as const;
}
