import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function credentialStorageReady(key = process.env.AGENT_CREDENTIAL_KEY) {
    return !!key && /^[a-f0-9]{64}$/i.test(key);
}
function encryptionKey(value = process.env.AGENT_CREDENTIAL_KEY) {
    if (!credentialStorageReady(value)) throw new Error('账号模型密钥加密配置不可用');
    return Buffer.from(value!, 'hex');
}
/** Bind the ciphertext to its account and record, preventing ciphertext swapping. */
export function sealCredential(secret: string, ownerId: string, id: string, key?: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
    cipher.setAAD(Buffer.from(`scova-agent:${ownerId}:${id}`));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url'),
    ].join('.');
}
export function openCredential(value: string, ownerId: string, id: string, key?: string) {
    try {
        const [version, iv, tag, data, extra] = value.split('.');
        if (version !== 'v1' || !iv || !tag || !data || extra) throw new Error();
        const decipher = createDecipheriv(
            'aes-256-gcm',
            encryptionKey(key),
            Buffer.from(iv, 'base64url'),
        );
        decipher.setAAD(Buffer.from(`scova-agent:${ownerId}:${id}`));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
            decipher.update(Buffer.from(data, 'base64url')),
            decipher.final(),
        ]).toString('utf8');
    } catch {
        throw new Error('账号模型密钥无法解密，请联系管理员核对加密配置');
    }
}
