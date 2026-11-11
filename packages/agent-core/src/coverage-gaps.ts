/** Compact repeated projections; detailed fields remain in artifact coverage and tool logs. */
export function compactCoverageGaps(gaps: readonly string[]): string[] {
    const unique = [...new Set(gaps.map((gap) => gap.trim()).filter(Boolean))];
    const groups = new Map<string, string[]>();
    const key = (gap: string) =>
        /^第 \d+ 次搜索失败，未获得可验证正文$/.test(gap)
            ? 'search'
            : /^第 \d+ 个来源正文采集失败$/.test(gap)
              ? 'read'
              : gap.startsWith('所需信息尚未完整覆盖：')
                ? 'requirements'
                : null;
    for (const gap of unique) {
        const group = key(gap);
        if (group) groups.set(group, [...(groups.get(group) ?? []), gap]);
    }
    const emitted = new Set<string>();
    return unique.flatMap((gap) => {
        const group = key(gap);
        if (!group) return [gap];
        if (emitted.has(group)) return [];
        emitted.add(group);
        const entries = groups.get(group)!;
        if (group === 'requirements')
            return [`所需信息尚未完整覆盖：共${entries.length}项，详见对应成果的对象与字段说明。`];
        if (entries.length === 1) return entries;
        return [
            group === 'search'
                ? `${entries.length}次搜索失败，未获得可验证正文；逐次原因见执行日志。`
                : `${entries.length}个来源正文采集失败；来源与逐次原因见执行日志。`,
        ];
    });
}
