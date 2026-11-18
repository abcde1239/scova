import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createDelegatedReader } from '../src/reader/runtime/delegate.ts';
import { ConnectorError, type PageReader, type ReadPage } from '../src/types.ts';
import type { SafeHttpClient } from '../src/http/index.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const url = 'https://fixture.example/article';
const readers: PageReader[] = [];
afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.close?.() ?? Promise.resolve()));
    vi.clearAllMocks();
});

interface Message {
    type: string;
    id?: number;
    readId?: number;
    [key: string]: unknown;
}

function fixture() {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const sent: Message[] = [];
    const receive = (message: Message) => {
        stdout.write(`${JSON.stringify(message)}\n`);
    };
    let readStarted!: (id: number) => void;
    const started = new Promise<number>((resolve) => {
        readStarted = resolve;
    });
    const stdin = new Writable({
        write(chunk, _encoding, done) {
            const message = JSON.parse(String(chunk)) as Message;
            sent.push(message);
            if (message.type === 'init') queueMicrotask(() => receive({ type: 'ready' }));
            if (message.type === 'read') readStarted(message.id!);
            if (message.type === 'close') queueMicrotask(() => child.emit('exit', 0));
            done();
        },
    });
    Object.assign(child, {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => {
            child.emit('exit', 0);
            return true;
        }),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const signals = new Map<string, AbortSignal>();
    const active = new Set<string>();
    const request = vi.fn<SafeHttpClient['request']>(async (target, options) => {
        const signal = options!.signal!;
        signals.set(target, signal);
        active.add(target);
        try {
            return await new Promise((_resolve, reject) => {
                const cancel = () =>
                    reject(new ConnectorError('aborted', 'Controlled request cancellation'));
                if (signal.aborted) cancel();
                else signal.addEventListener('abort', cancel, { once: true });
            });
        } finally {
            active.delete(target);
        }
    });
    const reader = createDelegatedReader({ http: { request } });
    readers.push(reader);
    const http = (id: number, readId: number, path: string) =>
        receive({
            type: 'http',
            id,
            readId,
            url: `${url}/${path}`,
            options: { method: 'GET' },
        });
    return { reader, receive, child, sent, started, signals, active, request, http };
}

describe('private Node Reader HTTP cancellation bridge', () => {
    it('cancels only the matching HTTP RPC before the read result and keeps another resource active', async () => {
        const f = fixture();
        let resolved = false;
        const result = f.reader.read(url).then((page) => {
            resolved = true;
            return page;
        });
        const readId = await f.started;
        f.http(101, readId, 'slow');
        f.http(102, readId, 'needed');
        expect(f.request).toHaveBeenCalledTimes(2);
        f.receive({ type: 'abortHttp', id: 101, readId: readId + 1 });
        expect(f.signals.get(`${url}/slow`)?.aborted).toBe(false);
        f.receive({ type: 'abortHttp', id: 101, readId });
        await vi.waitFor(() => expect(f.active.has(`${url}/slow`)).toBe(false));
        expect(f.signals.get(`${url}/slow`)?.aborted).toBe(true);
        expect(f.signals.get(`${url}/needed`)?.aborted).toBe(false);
        expect(resolved).toBe(false);
        f.receive({ type: 'abortHttp', id: 101, readId });
        const page = { kind: 'read_page' } as ReadPage;
        f.receive({ type: 'result', id: readId, result: page });
        expect(await result).toEqual(page);
        await vi.waitFor(() => expect(f.active.size).toBe(0));
        expect(f.signals.get(`${url}/needed`)?.aborted).toBe(true);
    });

    it.each(['close', 'failure'] as const)(
        'drains every parent HTTP controller after host %s',
        async (mode) => {
            const f = fixture();
            const result = f.reader.read(url).then(
                () => null,
                (error: unknown) => error,
            );
            const readId = await f.started;
            f.http(201, readId, 'first');
            f.http(202, readId, 'second');
            expect(f.active.size).toBe(2);
            if (mode === 'close') await f.reader.close?.();
            else f.child.emit('exit', 1);
            expect(await result).toMatchObject({
                code: mode === 'close' ? 'aborted' : 'extraction_failed',
            });
            await vi.waitFor(() => expect(f.active.size).toBe(0));
            expect([...f.signals.values()].every((signal) => signal.aborted)).toBe(true);
            await f.reader.close?.();
        },
    );

    it('preserves the identity of trusted callback errors while cancelling parent resources', async () => {
        const f = fixture();
        const leaseFailure = new Error('Controlled lease ownership failure');
        const result = f.reader
            .read(url, {
                beforeDispatch: async () => {
                    throw leaseFailure;
                },
            })
            .then(
                () => null,
                (error: unknown) => error,
            );
        const readId = await f.started;
        f.http(301, readId, 'slow');
        f.receive({ type: 'beforeDispatch', id: 302, readId });
        expect(await result).toBe(leaseFailure);
        await vi.waitFor(() => expect(f.active.size).toBe(0));
        expect(f.sent).toContainEqual({ type: 'abort', id: readId });
    });
});
