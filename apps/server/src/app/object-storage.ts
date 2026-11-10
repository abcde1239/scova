import {
    createObjectStorage,
    type ObjectStorage,
    type ObjectStorageConfig,
} from '@scova/object-storage';

/** Deployment configuration only; secrets never enter account DTOs. No I/O on import. */
export function createBucketStorage(env: NodeJS.ProcessEnv = process.env): ObjectStorage | null {
    const family = env.STORAGE_PROVIDER?.trim() ? 'STORAGE' : 'IMAGE_STORAGE';
    const setting = (name: string) => env[`${family}_${name}`]?.trim();
    const provider = setting('PROVIDER');
    if (!provider) return null;
    const required = (name: string) => {
        const value = setting(name);
        if (!value) throw new Error(`文件存储缺少配置 ${family}_${name}`);
        return value;
    };
    const common = {
        bucket: required('BUCKET'),
        credentials: {
            accessKeyId: required('ACCESS_KEY_ID'),
            secretAccessKey: required('SECRET_ACCESS_KEY'),
            ...(setting('SESSION_TOKEN') ? { sessionToken: setting('SESSION_TOKEN') } : {}),
        },
    };
    let config: ObjectStorageConfig;
    if (provider === 'r2') {
        const jurisdiction = setting('R2_JURISDICTION') || undefined;
        if (jurisdiction !== undefined && jurisdiction !== 'eu' && jurisdiction !== 'fedramp')
            throw new Error('文件存储R2辖区配置无效');
        config = {
            ...common,
            provider,
            accountId: required('R2_ACCOUNT_ID'),
            jurisdiction,
        };
    } else if (provider === 's3') {
        const pathStyle = setting('FORCE_PATH_STYLE');
        if (pathStyle && !['true', 'false'].includes(pathStyle))
            throw new Error('文件存储路径配置无效');
        config = {
            ...common,
            provider,
            region: required('REGION'),
            endpoint: setting('ENDPOINT') || undefined,
            forcePathStyle: pathStyle === 'true',
        };
    } else throw new Error('文件存储provider必须为r2或s3');
    return createObjectStorage(config);
}
