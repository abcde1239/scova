import { describe, expect, it } from 'vite-plus/test';
import {
    credentialStorageReady,
    sealCredential,
    openCredential,
    sealProviderCredentials,
    openProviderCredentials,
} from '../src/credentials.ts';
const key = '12'.repeat(32);
describe('account API key encryption', () => {
    it('reads legacy model keys and keeps search credentials encrypted and account bound', () => {
        const legacy = sealCredential('model-key', 'account', 'provider', key);
        expect(openProviderCredentials(legacy, 'account', 'provider', key)).toEqual({
            modelApiKey: 'model-key',
        });
        const credentials = {
            modelApiKey: 'model-key',
            searchApi: {
                protocol: 'deepseek' as const,
                baseUrl: 'https://api.deepseek.com/v1',
                apiKey: 'search-private-key',
                contentMode: 'prefer_api' as const,
            },
        };
        const cipher = sealProviderCredentials(credentials, 'account', 'provider', key);
        expect(cipher).not.toContain('search-private-key');
        expect(openProviderCredentials(cipher, 'account', 'provider', key)).toEqual(credentials);
        expect(() => openProviderCredentials(cipher, 'other', 'provider', key)).toThrow();
        expect(() =>
            openProviderCredentials(
                sealCredential(
                    'scova-provider:v2:{"modelApiKey":"key"}',
                    'account',
                    'provider',
                    key,
                ),
                'account',
                'provider',
                key,
            ),
        ).toThrow('格式无效');
    });
    it('encrypts with randomized authenticated ciphertext and no key fragments', () => {
        const first = sealCredential('sample-private-key', 'account', 'provider', key);
        expect(first).not.toContain('sample-private-key');
        expect(first).not.toBe(sealCredential('sample-private-key', 'account', 'provider', key));
        expect(openCredential(first, 'account', 'provider', key)).toBe('sample-private-key');
    });
    it('rejects wrong account, record, master key and tampered ciphertext', () => {
        const value = sealCredential('private', 'account', 'provider', key);
        for (const [cipher, owner, id, secret] of [
            [value, 'other', 'provider', key],
            [value, 'account', 'other', key],
            [value, 'account', 'provider', '34'.repeat(32)],
            [value + 'tampered', 'account', 'provider', key],
        ])
            expect(() => openCredential(cipher!, owner!, id!, secret!)).toThrow('无法解密');
    });
    it('requires an explicit 256 bit deployment key', () => {
        expect(credentialStorageReady(key)).toBe(true);
        expect(credentialStorageReady('short')).toBe(false);
        expect(() => sealCredential('secret', 'account', 'provider', 'short')).toThrow();
    });
});
