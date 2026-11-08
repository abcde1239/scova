import { describe, expect, it } from 'vite-plus/test';
import { toolIssueLevel, toolIssueGuidance } from '../src/index.ts';

describe('tool impact classification', () => {
    it.each([
        'TOOL_NETWORK',
        'TOOL_TIMEOUT',
        'TOOL_HTTP_FORBIDDEN',
        'TOOL_HTTP_NOT_FOUND',
        'TOOL_HTTP_UNAUTHORIZED',
        'TOOL_RATE_LIMITED',
        'TOOL_EXTRACTION_FAILED',
        'TOOL_INVALID_RESPONSE',
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
