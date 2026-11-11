import { describe, expect, it, vi } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import { ConnectorError, type PageReader, type ReadPage } from '@scova/connectors';
import { readSource } from '../src/service/source-reader.ts';

const url = 'https://docs.example/current/reference.html';
const page = (text: string, extractionVersion = 'search-api/deepseek/v1'): ReadPage => ({
    kind: 'read_page',
    mode: 'live',
    originalUrl: url,
    fetchedUrl: url,
    url,
    title: 'Reference',
    text,
    contentHash: createHash('sha256').update(text).digest('hex'),
    extractionVersion,
    collectedAt: '2026-11-11T01:00:00Z',
    truncated: false,
    untrusted: true,
});

describe('verify provider excerpts at their original HTML source', () => {
    it('stops an already cancelled request before reading or charging a saved excerpt', async () => {
        const controller = new AbortController();
        controller.abort();
        const reader = { read: vi.fn() };
        const charge = vi.fn();
        await expect(
            readSource(url, page('excerpt'), reader, {
                signal: controller.signal,
                beforeAttempt: charge,
            }),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(reader.read).not.toHaveBeenCalled();
        expect(charge).not.toHaveBeenCalled();
    });
    it('passes an ordinary source without API content through the same bounded Reader', async () => {
        const complete = page('Origin content', 'scova-text-v5');
        const context = { timeoutMs: 15000 };
        const reader = { read: vi.fn().mockResolvedValue(complete) };
        expect(await readSource(url, undefined, reader, context)).toBe(complete);
        expect(reader.read).toHaveBeenCalledWith(url, context);
    });
    it('gets the complete source when a nonempty API prefix omits the requested method and tail', async () => {
        const prefix = page('Introduction. date._');
        const complete = {
            ...page(
                'Introduction. datetime.now() returns the current time. Footnote end.',
                'scova-text-v5',
            ),
            collection: {
                version: 1 as const,
                method: 'html' as const,
                complete: true,
                limitations: [],
            },
        };
        const charge = vi.fn();
        const reader: PageReader = {
            async read(target, options) {
                expect(target).toBe(url);
                expect(options?.timeoutMs).toBe(15000);
                await options?.beforeAttempt?.('read');
                return complete;
            },
        };
        expect(
            await readSource(url, prefix, reader, { timeoutMs: 15000, beforeAttempt: charge }),
        ).toEqual(complete);
        expect(charge).toHaveBeenCalledTimes(1);
        expect(prefix.text).toBe('Introduction. date._');
    });
    it.each(['network', 'timeout', 'http', 'response_too_large', 'extraction_failed'] as const)(
        'preserves the unchanged provider excerpt as unknown coverage after %s',
        async (code) => {
            const excerpt = page('A useful partial paragraph.');
            const charge = vi.fn();
            const reader: PageReader = {
                async read(_target, options) {
                    await options?.beforeAttempt?.('read');
                    throw new ConnectorError(code, 'bounded failure');
                },
            };
            expect(await readSource(url, excerpt, reader, { beforeAttempt: charge })).toEqual(
                excerpt,
            );
            expect(charge).toHaveBeenCalledTimes(1);
            expect(excerpt.collection).toBeUndefined();
        },
    );
    it.each([
        'unsafe_url',
        'aborted',
        'configuration',
        'budget_exceeded',
        'model_quota_exceeded',
    ] as const)('never falls back after %s', async (code) => {
        const error = new ConnectorError(code, 'must stop');
        await expect(
            readSource(
                url,
                page('excerpt'),
                {
                    async read() {
                        throw error;
                    },
                },
                {},
            ),
        ).rejects.toBe(error);
    });
    it('propagates lease/persistence errors without accepting a stale excerpt', async () => {
        const error = new Error('lease lost');
        await expect(
            readSource(
                url,
                page('excerpt'),
                {
                    async read() {
                        throw error;
                    },
                },
                {},
            ),
        ).rejects.toBe(error);
    });
    it('propagates abort even if a Reader reports a network error after cancellation', async () => {
        const controller = new AbortController();
        const error = new ConnectorError('network', 'socket closed');
        await expect(
            readSource(
                url,
                page('excerpt'),
                {
                    async read() {
                        controller.abort();
                        throw error;
                    },
                },
                { signal: controller.signal },
            ),
        ).rejects.toBe(error);
    });
    it('retains honest partial origin coverage without merging different page snapshots', async () => {
        const partial = {
            ...page('Visible origin preview.', 'scova-text-v5'),
            collection: {
                version: 1 as const,
                method: 'html' as const,
                complete: false,
                limitations: ['content_restricted' as const],
            },
        };
        expect(
            await readSource(
                url,
                page('Other provider extraction.'),
                {
                    async read() {
                        return partial;
                    },
                },
                {},
            ),
        ).toEqual(partial);
    });
    it('preserves paid or failed Reader attempt accounting without an extra fallback charge', async () => {
        const charge = vi.fn();
        const failure = new ConnectorError('network', 'first');
        await readSource(
            url,
            page('excerpt'),
            {
                async read(_target, options) {
                    await options?.beforeAttempt?.('read');
                    await options?.beforeAttempt?.('read', failure);
                    throw failure;
                },
            },
            { beforeAttempt: charge },
        );
        expect(charge).toHaveBeenCalledTimes(2);
    });
    it('retains provider-only document extraction without sending a PDF to HTML Reader', async () => {
        const documentUrl = 'https://docs.example/manual.pdf';
        const excerpt = {
            ...page('PDF excerpt'),
            url: documentUrl,
            originalUrl: documentUrl,
            fetchedUrl: documentUrl,
        };
        const reader = { read: vi.fn() };
        const charge = vi.fn();
        expect(await readSource(documentUrl, excerpt, reader, { beforeAttempt: charge })).toEqual(
            excerpt,
        );
        expect(reader.read).not.toHaveBeenCalled();
        expect(charge).toHaveBeenCalledTimes(1);
    });
    it('does not borrow an excerpt from another URL', async () => {
        await expect(
            readSource('https://docs.example/other', page('excerpt'), { read: vi.fn() }, {}),
        ).rejects.toMatchObject({ code: 'configuration' });
    });
});
