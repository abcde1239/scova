import { Type } from '@sinclair/typebox';
import { OutputFormatSchema } from './common.ts';

export type OutputFormat = 'brief' | 'list' | 'comparison' | 'research_report';
export const OutputFormatsSchema = Type.Array(OutputFormatSchema, {
    minItems: 1,
    maxItems: 4,
    uniqueItems: true,
    description: '执行前选定的交付形式；每种形式按独立采集目标生成，首项为默认打开的成果',
});

/** Older saved versions keep their single-format meaning. */
export function selectedOutputFormats(config: {
    outputFormat: OutputFormat;
    outputFormats?: OutputFormat[];
}): OutputFormat[] {
    return config.outputFormats?.length ? [...config.outputFormats] : [config.outputFormat];
}

export const outputFormatLabels: Record<OutputFormat, string> = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
