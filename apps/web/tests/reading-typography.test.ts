import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { READING_STORAGE_KEY, useReadingStore } from '@/store/reading';
import type { ReadingFamily, ReadingSize } from '@/store/reading';

const pins: ReturnType<typeof createPinia>[] = [];
function freshApplication() {
    const pinia = createPinia();
    pins.push(pinia);
    setActivePinia(pinia);
}

function localStorage(saved?: string) {
    const values = new Map<string, string>([
        ['scova.appearance.v1', '{"accent":"green"}'],
        ['session', 'untouched'],
    ]);
    if (saved !== undefined) values.set(READING_STORAGE_KEY, saved);
    const storage = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal('window', { localStorage: storage });
    return { storage, values };
}

describe('local reading preferences', () => {
    beforeEach(freshApplication);
    afterEach(() => {
        pins.splice(0).forEach(disposePinia);
        vi.unstubAllGlobals();
    });

    it('defaults to serif at the browser-relative standard size without writing storage', () => {
        const { storage } = localStorage();
        const reading = useReadingStore();
        expect([reading.family, reading.size]).toEqual(['serif', 1]);
        expect(reading.variables).toEqual({
            '--scova-reading-family': 'var(--scova-font-reading)',
            '--scova-reading-size': '1rem',
        });
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('persists a valid body-only choice and restores it in a fresh application', () => {
        const { storage, values } = localStorage();
        const reading = useReadingStore();
        reading.setFamily('sans');
        reading.setSize(1.1875);
        expect(JSON.parse(values.get(READING_STORAGE_KEY)!)).toEqual({
            version: 1,
            family: 'sans',
            size: 1.1875,
        });
        freshApplication();
        const restored = useReadingStore();
        expect([restored.family, restored.size]).toEqual(['sans', 1.1875]);
        expect(restored.variables).toEqual({
            '--scova-reading-family': 'var(--scova-font-interface)',
            '--scova-reading-size': '1.1875rem',
        });
        expect(storage.setItem.mock.calls.every(([key]) => key === READING_STORAGE_KEY)).toBe(true);
        expect(values.get('session')).toBe('untouched');
        expect(values.get('scova.appearance.v1')).toBe('{"accent":"green"}');
    });

    it.each([
        undefined,
        'invalid JSON',
        'null',
        '[]',
        '{"version":2,"family":"sans","size":1}',
        '{"version":1,"family":"custom","size":1}',
        '{"version":1,"family":"sans","size":99}',
        '{"version":1,"family":"sans"}',
    ])('recovers from unavailable or incompatible preferences: %s', (saved) => {
        const { storage } = localStorage(saved);
        const reading = useReadingStore();
        expect([reading.family, reading.size]).toEqual(['serif', 1]);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('supports the middle size and rejects invalid runtime setter values', () => {
        const { storage } = localStorage();
        const reading = useReadingStore();
        reading.setSize(1.0625);
        expect(reading.variables['--scova-reading-size']).toBe('1.0625rem');
        reading.setSize(2 as ReadingSize);
        reading.setFamily('invalid' as ReadingFamily);
        expect([reading.family, reading.size]).toEqual(['serif', 1.0625]);
        expect(storage.setItem).toHaveBeenCalledTimes(1);
    });

    it('allows in-page changes when storage access is denied', () => {
        vi.stubGlobal(
            'window',
            Object.defineProperty({}, 'localStorage', {
                get() {
                    throw new Error('denied');
                },
            }),
        );
        const reading = useReadingStore();
        expect([reading.family, reading.size]).toEqual(['serif', 1]);
        expect(() => {
            reading.setFamily('sans');
            reading.setSize(1.1875);
        }).not.toThrow();
        expect([reading.family, reading.size]).toEqual(['sans', 1.1875]);
    });

    it('provides defaults without a browser window', () => {
        vi.stubGlobal('window', undefined);
        const reading = useReadingStore();
        expect([reading.family, reading.size]).toEqual(['serif', 1]);
        expect(() => reading.setSize(1.0625)).not.toThrow();
    });

    it('recovers from storage read/write failures without losing the active choice', () => {
        const { storage } = localStorage();
        storage.getItem.mockImplementation(() => {
            throw new Error('read failed');
        });
        storage.setItem.mockImplementation(() => {
            throw new Error('quota');
        });
        const reading = useReadingStore();
        expect(() => reading.setFamily('sans')).not.toThrow();
        expect(reading.family).toBe('sans');
        expect(reading.size).toBe(1);
    });
});
