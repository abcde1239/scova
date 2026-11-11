import { describe, expect, it } from 'vite-plus/test';
import { ConnectorError } from '../src/types.ts';
import { isExtractionCapacityError } from '../src/page-extraction-capacity.ts';

describe('unrecoverable extraction capacity classification', () => {
    it.each(['网页节点数超过提取限制', '表格展开结构超过提取限制'])(
        'recognizes only an exact owned capacity failure: %s',
        (message) => {
            expect(
                isExtractionCapacityError(new ConnectorError('extraction_failed', message)),
            ).toBe(true);
        },
    );
    it.each([
        new ConnectorError('extraction_failed', '页面主正文仍在加载'),
        new ConnectorError('extraction_failed', 'article mentions 网页节点数超过提取限制'),
        new ConnectorError('network', '网页节点数超过提取限制'),
        new Error('网页节点数超过提取限制'),
    ])('does not broaden non-capacity failures: %s', (error) => {
        expect(isExtractionCapacityError(error)).toBe(false);
    });
});
