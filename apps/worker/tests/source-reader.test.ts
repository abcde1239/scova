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

describe('selected provider reading', () => {
    it('reuses the saved API body without origin verification or another request', async () => {
        const reader = { read: vi.fn() };
        const charge = vi.fn();
        const saved = page('Provider body');
        expect(await readSource(url, saved, reader, { beforeAttempt: charge })).toEqual(saved);
        expect(reader.read).not.toHaveBeenCalled();
        expect(charge).toHaveBeenCalledExactlyOnceWith('read');
        expect(saved.collection).toBeUndefined();
    });
    it.each([undefined, page(''), { ...page('Locally clipped'), truncated: true }])(
        'delegates missing or clipped body to the configured adapter',
        async (saved) => {
            const fetched = page('Fetched by provider');
            const reader = { read: vi.fn().mockResolvedValue(fetched) };
            const context = { timeoutMs: 15000 };
            expect(await readSource(url, saved, reader, context)).toBe(fetched);
            expect(reader.read).toHaveBeenCalledExactlyOnceWith(url, context);
        },
    );
    it('retains provider documents without invoking the local HTML Reader', async () => {
        const target = 'https://docs.example/manual.pdf';
        const saved = {
            ...page('Document body'),
            url: target,
            originalUrl: target,
            fetchedUrl: target,
        };
        const reader = { read: vi.fn() };
        expect(await readSource(target, saved, reader, {})).toEqual(saved);
        expect(reader.read).not.toHaveBeenCalled();
    });
    it.each(['network', 'unsafe_url', 'aborted', 'budget_exceeded', 'extraction_failed'] as const)(
        'propagates %s from the selected reader without using another service',
        async (code) => {
            const error = new ConnectorError(code, 'failed');
            const reader: PageReader = {
                async read() {
                    throw error;
                },
            };
            await expect(readSource(url, undefined, reader, {})).rejects.toBe(error);
        },
    );
    it('rejects another URL before charging or reading', async () => {
        const reader = { read: vi.fn() },
            charge = vi.fn();
        await expect(
            readSource('https://docs.example/other', page('body'), reader, {
                beforeAttempt: charge,
            }),
        ).rejects.toMatchObject({ code: 'configuration' });
        expect(charge).not.toHaveBeenCalled();
        expect(reader.read).not.toHaveBeenCalled();
    });
    it('propagates a lease or budget rejection when accepting saved evidence', async () => {
        const error = new Error('lease lost');
        await expect(
            readSource(
                url,
                page('body'),
                { read: vi.fn() },
                {
                    beforeAttempt: () => {
                        throw error;
                    },
                },
            ),
        ).rejects.toBe(error);
    });
    it.each([false, true])(
        'honors cancellation before or during reservation (%s)',
        async (during) => {
            const controller = new AbortController(),
                charge = vi.fn(() => controller.abort());
            if (!during) controller.abort();
            const reader = { read: vi.fn() };
            await expect(
                readSource(url, page('body'), reader, {
                    signal: controller.signal,
                    beforeAttempt: charge,
                }),
            ).rejects.toMatchObject({ code: 'aborted' });
            expect(reader.read).not.toHaveBeenCalled();
            expect(charge).toHaveBeenCalledTimes(during ? 1 : 0);
        },
    );
});
