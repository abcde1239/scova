import { describe, expect, it } from 'vite-plus/test';
import { ConnectorError } from '@scova/connectors';
import {
    classifyToolFailure,
    toolFailures,
    modelFailureDiagnostic,
} from '@scova/shared/execution/tool-failure';

describe('公开工具错误分类', () => {
    it.each([
        ['plan-0', 'planning'],
        ['compare-facts-0-0', 'comparison'],
        ['synthesize-batch-7-1', 'synthesis'],
        ['other', 'other'],
    ])('attaches safe stage metadata for %s', (operation, stage) => {
        const error = new ConnectorError('invalid_response', 'DO_NOT_RENDER sk-secret');
        error.modelDiagnostic = {
            schemaHash: 'a'.repeat(64),
            failure: 'schema',
            issues: [
                { schemaPath: '#/required', keyword: 'required', requiredProperty: 'assessment' },
                {
                    schemaPath: '#/additionalProperties',
                    keyword: 'additionalProperties',
                    allowedProperties: ['pageId', 'quote'],
                },
            ],
        };
        const diagnostic = modelFailureDiagnostic(error, operation!);
        expect(diagnostic).toEqual({ modelDiagnostic: { ...error.modelDiagnostic, stage } });
        expect(JSON.stringify(diagnostic)).not.toMatch(/DO_NOT_RENDER|sk-secret/);
        error.modelDiagnostic = {
            ...error.modelDiagnostic,
            response: 'sk-secret',
        } as typeof error.modelDiagnostic;
        expect(modelFailureDiagnostic(error, operation!)).toEqual({});
    });
    it.each([
        ['json', 'TOOL_MODEL_INVALID_JSON'],
        ['schema', 'TOOL_MODEL_SCHEMA_MISMATCH'],
        ['envelope', 'TOOL_MODEL_INVALID_RESPONSE'],
        ['refusal', 'TOOL_MODEL_REFUSED'],
    ] as const)('preserves the model %s failure without publishing values', (reason, code) => {
        const error = new ConnectorError('invalid_response', 'DO_NOT_RENDER');
        error.modelFailure = reason;
        expect(classifyToolFailure(error)).toBe(code);
        expect(JSON.stringify(toolFailures[code])).not.toContain('DO_NOT_RENDER');
    });
    it('keeps safe limit and format summaries broad enough for DOM/resources and decoded HTML', () => {
        expect(toolFailures.TOOL_RESPONSE_TOO_LARGE[0]).toContain('资源数量');
        expect(toolFailures.TOOL_RESPONSE_TOO_LARGE[0]).toContain('页面结构');
        expect(toolFailures.TOOL_INVALID_RESPONSE[0]).toContain('内容类型');
        expect(toolFailures.TOOL_INVALID_RESPONSE[0]).not.toContain('UTF-8');
    });
    it.each([
        ['unsafe_url', 'TOOL_UNSAFE_URL'],
        ['network', 'TOOL_NETWORK'],
        ['timeout', 'TOOL_TIMEOUT'],
        ['aborted', 'TOOL_ABORTED'],
        ['configuration', 'TOOL_CONFIGURATION'],
        ['response_too_large', 'TOOL_RESPONSE_TOO_LARGE'],
        ['invalid_response', 'TOOL_INVALID_RESPONSE'],
        ['output_truncated', 'TOOL_OUTPUT_TRUNCATED'],
        ['model_quota_exceeded', 'TOOL_MODEL_QUOTA_EXCEEDED'],
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
