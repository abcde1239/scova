import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createBucketStorage } from '../src/app/object-storage';
import { createDefaultServices } from '../src/app/services';
import { avatarKey } from '../src/service/avatar';

const settings = {
    STORAGE_PROVIDER: 'r2',
    STORAGE_BUCKET: 'files',
    STORAGE_ACCESS_KEY_ID: 'test',
    STORAGE_SECRET_ACCESS_KEY: 'test-secret',
    STORAGE_R2_ACCOUNT_ID: 'a'.repeat(32),
};
afterEach(() => vi.unstubAllEnvs());

describe('共享存储装配', () => {
    it('prefers a complete STORAGE family and never mixes legacy credentials', async () => {
        const bucket = createBucketStorage({
            ...settings,
            IMAGE_STORAGE_PROVIDER: 's3',
            IMAGE_STORAGE_BUCKET: 'old',
        })!;
        try {
            const url = new URL(await bucket.presignDownload('reports/id/file.pdf'));
            expect(url.pathname).toBe('/files/reports/id/file.pdf');
            expect(url.hostname).toBe(`${settings.STORAGE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
        } finally {
            bucket.destroy();
        }
        expect(() =>
            createBucketStorage({
                STORAGE_PROVIDER: 'r2',
                IMAGE_STORAGE_BUCKET: 'old',
                IMAGE_STORAGE_ACCESS_KEY_ID: 'old',
            }),
        ).toThrow('STORAGE_BUCKET');
    });

    it('retains legacy IMAGE_STORAGE configuration as a complete fallback', () => {
        const legacy = Object.fromEntries(
            Object.entries(settings).map(([name, value]) => [`IMAGE_${name}`, value]),
        );
        const bucket = createBucketStorage({ ...legacy, STORAGE_PROVIDER: ' ' });
        expect(bucket).not.toBeNull();
        bucket?.destroy();
        expect(createBucketStorage({})).toBeNull();
    });

    it('rejects invalid S3 configuration without disclosing configuration values', () => {
        expect(() =>
            createBucketStorage({
                ...settings,
                STORAGE_PROVIDER: 's3',
                STORAGE_FORCE_PATH_STYLE: 'private-invalid-setting',
            }),
        ).toThrow('路径配置');
        expect(() =>
            createBucketStorage({
                ...settings,
                STORAGE_R2_JURISDICTION: 'private-invalid-setting',
            }),
        ).toThrow('辖区配置');
    });

    it('lazily reuses the bucket for images, tasks and reports and closes all views together', async () => {
        for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
        const services = createDefaultServices();
        try {
            const images = services.avatarStorage()!;
            const bucket = services.objectStorage()!;
            expect(services.objectStorage()).toBe(bucket);
            expect(services.avatarStorage()).toBe(images);
            expect(images).not.toHaveProperty('destroy');
            const key = avatarKey('user-id', 'version-id');
            expect(key).toBe('avatars/user-id/version-id.webp');
            expect(new URL(await images.presignDownload(key)).pathname).toBe(
                '/files/avatars/user-id/version-id.webp',
            );
            const report = bucket.scope('reports/report-id');
            expect(
                new URL(await report.presignDownload('reports/report-id/result.pdf')).pathname,
            ).toBe('/files/reports/report-id/result.pdf');
            await services.close();
            await expect(images.presignDownload(key)).rejects.toMatchObject({
                code: 'storage_closed',
            });
            await expect(
                report.presignDownload('reports/report-id/result.pdf'),
            ).rejects.toMatchObject({ code: 'storage_closed' });
            expect(() => services.objectStorage()).toThrow('关闭');
            expect(() => services.avatarStorage()).toThrow('关闭');
        } finally {
            await services.close();
        }
    });
});
