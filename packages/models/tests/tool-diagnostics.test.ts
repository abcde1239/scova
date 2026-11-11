import { describe, expect, it } from 'vite-plus/test';
import { toolIssueLevel, toolIssueGuidance } from '../src/index.ts';

describe('tool impact classification', () => {
    it('describes reader capability and resource limits without obsolete encoding or length advice', () => {
        expect(toolIssueGuidance('read', 'TOOL_INVALID_RESPONSE')).not.toContain('UTF-8');
        expect(toolIssueGuidance('read', 'TOOL_INVALID_RESPONSE')).toContain('HTML');
        expect(toolIssueGuidance('read', 'TOOL_RESPONSE_TOO_LARGE')).toContain('DOM');
        expect(toolIssueGuidance('read', 'TOOL_RESPONSE_TOO_LARGE')).toContain('资源数量');
        expect(toolIssueGuidance('read', 'TOOL_RESPONSE_TOO_LARGE')).not.toContain('请改用较短');
        expect(toolIssueGuidance('read', 'TOOL_HTTP_FORBIDDEN')).toContain('替代来源');
        expect(toolIssueGuidance('read', 'TOOL_EXTRACTION_FAILED')).toContain('验证码');
        expect(toolIssueGuidance('read', 'TOOL_TIMEOUT')).toContain('正文提取');
    });
    it.each([
        'TOOL_NETWORK',
        'TOOL_TIMEOUT',
        'TOOL_HTTP_FORBIDDEN',
        'TOOL_HTTP_NOT_FOUND',
        'TOOL_HTTP_UNAUTHORIZED',
        'TOOL_RATE_LIMITED',
        'TOOL_EXTRACTION_FAILED',
        'TOOL_INVALID_RESPONSE',
        'TOOL_RESPONSE_TOO_LARGE',
    ])('treats a recoverable or skippable page issue as warning: %s', (code) => {
        expect(toolIssueLevel('read', code)).toBe('warning');
        expect(toolIssueGuidance('read', code)).not.toBe('');
    });
    it.each([
        'TOOL_UNSAFE_URL',
        'TOOL_CONFIGURATION',
        'TOOL_MODEL_QUOTA_EXCEEDED',
        'TOOL_FAILED',
        'constructor',
    ])('keeps blocking or unknown issues as error: %s', (code) =>
        expect(toolIssueLevel('model', code)).toBe('error'),
    );
});
