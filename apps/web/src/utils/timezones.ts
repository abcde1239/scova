const commonTimezones = [
    ['Asia/Shanghai', '北京 / 上海'],
    ['Asia/Hong_Kong', '香港'],
    ['Asia/Taipei', '台北'],
    ['Asia/Tokyo', '东京'],
    ['Asia/Seoul', '首尔'],
    ['Asia/Singapore', '新加坡'],
    ['Asia/Kolkata', '新德里'],
    ['Europe/London', '伦敦'],
    ['Europe/Paris', '巴黎'],
    ['Europe/Berlin', '柏林'],
    ['America/New_York', '纽约'],
    ['America/Los_Angeles', '洛杉矶'],
    ['Australia/Sydney', '悉尼'],
    ['UTC', '协调世界时'],
] as const;

/** 使用运行环境支持的IANA名称，不硬编码可能受夏令时影响的UTC偏移。 */
export function timezoneOptions(current: string) {
    let supported: string[] = [];
    try {
        supported = Intl.supportedValuesOf('timeZone');
    } catch {
        // 旧浏览器保留常用项与当前有效时区。
    }
    const names = new Map<string, string>(commonTimezones);
    return [...new Set([...names.keys(), current, ...supported])]
        .filter((value) => {
            try {
                new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format();
                return true;
            } catch {
                return false;
            }
        })
        .map((value) => ({
            value,
            label: names.get(value) ?? value.replaceAll('_', ' ').replaceAll('/', ' / '),
            description: value,
        }));
}
