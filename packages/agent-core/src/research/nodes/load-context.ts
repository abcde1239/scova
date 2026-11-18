import { type ResearchState } from '../state.ts';
import type { AgentRuntime } from '../runtime.ts';

export function loadContextNode(rt: AgentRuntime) {
    const { context } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (context.config.sourcePreferences.officialOnly)
            (state.notes ??= []).push('来源已按用户指定范围筛选；范围匹配不等于独立认证官方身份');
        if (
            context.config.sourcePreferences.officialOnly &&
            !context.config.sourcePreferences.preferredUrls.length
        )
            state.gaps.push('仅官方来源模式缺少经部署者确认的来源范围，不能凭模型认定官方身份');
        return state;
    };
}
