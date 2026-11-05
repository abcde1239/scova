import { describe, expect, it } from 'vite-plus/test';
import { ConnectorError } from '@scova/connectors';
import { classifyToolFailure, toolFailures } from '../src/utils/tool-failure.ts';

describe('公开工具错误分类', () => {
    it.each([
        ['unsafe_url', 'TOOL_UNSAFE_URL'],
        ['network', 'TOOL_NETWORK'],
        ['timeout', 'TOOL_TIMEOUT'],
        ['aborted', 'TOOL_ABORTED'],
        ['configuration', 'TOOL_CONFIGURATION'],
        ['response_too_large', 'TOOL_RESPONSE_TOO_LARGE'],
        ['invalid_response', 'TOOL_INVALID_RESPONSE'],
        ['output_truncated', 'TOOL_OUTPUT_TRUNCATED'],
        ['budget_exceeded', 'TOOL_BUDGET_EXCEEDED'],
        ['extraction_failed', 'TOOL_EXTRACTION_FAILED'],
    ] as const)('%s保留分类而不保存原始错误', (code, expected) => {
        const error = new ConnectorError(code, 'DO_NOT_RENDER sk-secret prompt');
        expect(classifyToolFailure(error)).toBe(expected);
        expect(JSON.stringify(toolFailures[expected])).not.toMatch(/secret|prompt|DO_NOT_RENDER/);
    });
    it('区分拒绝和限流；未知异常不伪装为已确认结果', () => {
        expect(classifyToolFailure(new ConnectorError('http', 'secret', false, 403))).toBe(
            'TOOL_HTTP_FORBIDDEN',
        );
        expect(classifyToolFailure(new ConnectorError('http', 'secret', true, 429))).toBe(
            'TOOL_RATE_LIMITED',
        );
        expect(classifyToolFailure(new ConnectorError('http', 'secret', true, 503))).toBe(
            'TOOL_HTTP_ERROR',
        );
        expect(classifyToolFailure(new Error('sk-secret'))).toBeUndefined();
        expect(classifyToolFailure({ code: 'unsafe_url', message: 'sk-secret' })).toBeUndefined();
    });
});
