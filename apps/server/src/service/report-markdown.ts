import { createHash } from 'node:crypto';
import { REPORT_MARKDOWN_MAX_BYTES, type Report } from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

// Input is already an authorized public report DTO. Keep all source/model text inert in Markdown.
export function renderReportMarkdown(report: Report) {
    const chunks: string[] = [];
    let byteLength = 0;
    const oversized = () =>
        new ApiError(422, 'REPORT_EXPORT_TOO_LARGE', '报告超过 256 KiB 导出上限');
    const line = (value = '') => {
        byteLength += Buffer.byteLength(value, 'utf8') + 1;
        if (byteLength > REPORT_MARKDOWN_MAX_BYTES) throw oversized();
        chunks.push(value);
    };
    function text(value: string) {
        if (value.length > REPORT_MARKDOWN_MAX_BYTES) throw oversized();
        return value
            .replace(/[\s\p{Cc}]+/gu, ' ')
            .trim()
            .replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, '\\$&');
    }
    const labels: Record<Report['claims'][number]['kind'], string> = {
        fact: '来源事实',
        inference: '推断',
        conflict: '冲突',
        insufficient: '证据不足',
        model_answer: '仅模型回答',
    };
    const sources = new Map(report.evidence.map((item, index) => [item.id, index + 1]));
    const references = (ids: string[]) =>
        ids
            .map((id) => sources.get(id))
            .filter((id) => id !== undefined)
            .join('、');

    line(`# ${text(report.title)}`);
    line();
    line(`- 报告 ID：${report.id}`);
    line(`- 交付时间：${report.publishedAt}`);
    line(`- 模式：${report.mode === 'demo' ? '演示（非真实研究）' : '真实研究'}`);
    line(`- 覆盖：${report.coverage.completeness === 'complete' ? '完整' : '部分'}`);
    line(`- 执行结果：${report.outcome}`);
    line();
    line('## 摘要');
    line();
    line(text(report.summary));
    line();
    const gaps = new Set([...report.limitations, ...report.coverage.gaps]);
    if (gaps.size) {
        line('## 限制与缺口');
        line();
        for (const gap of gaps) line(`- ${text(gap)}`);
        line();
    }
    line('## 结论');
    line();
    for (const claim of report.claims) {
        const refs = references(claim.evidenceIds);
        line(
            `- **${labels[claim.kind]}**（${text(claim.confidenceLabel)}）：${text(claim.text)}${refs ? `（证据 ${refs}）` : ''}`,
        );
    }
    line();
    if (report.changes.length) {
        line('## 变化记录');
        line();
        for (const change of report.changes) {
            line(
                `- ${text(change.factKey)}（${change.kind}）：${text(change.oldValue ?? '无')} → ${text(change.newValue ?? '无')}`,
            );
            for (const [label, ids] of [
                ['旧证据', change.oldEvidenceIds],
                ['新证据', change.newEvidenceIds],
            ] as const) {
                const refs = references(ids);
                if (refs) line(`  - ${label}：${refs}`);
            }
        }
        line();
    }
    line('## 外部证据');
    line();
    if (!report.evidence.length) line('没有可引用的外部证据。');
    for (const [index, item] of report.evidence.entries()) {
        line(`${index + 1}. **${text(item.title)}**`);
        const url = new URL(item.url).href.replaceAll('`', '%60');
        line(`   - 来源地址：\`${url}\``);
        line(`   - 采集时间：${item.observedAt}；位置：${text(item.location)}`);
        line('   - 原文片段：');
        line();
        if (item.quote.length > REPORT_MARKDOWN_MAX_BYTES) throw oversized();
        let fenceLength = 3;
        for (const match of item.quote.matchAll(/~+/g))
            fenceLength = Math.max(fenceLength, match[0].length + 1);
        const fence = '~'.repeat(fenceLength);
        line(fence + 'text');
        line(item.quote.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
        line(fence);
        line();
    }
    const markdown = `${chunks.join('\n')}\n`;
    return { markdown, byteLength, sha256: createHash('sha256').update(markdown).digest('hex') };
}
