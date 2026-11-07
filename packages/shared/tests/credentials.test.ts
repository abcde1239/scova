import { describe, expect, it } from 'vite-plus/test';
import { credentialStorageReady, sealCredential, openCredential } from '../src/credentials.ts';
const key = '12'.repeat(32);
describe('account API key encryption', () => {
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
