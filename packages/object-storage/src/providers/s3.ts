import { S3Client } from '@aws-sdk/client-s3';
import { ObjectStorageError } from '../core/errors.ts';
import type { ObjectStorageConfig } from '../core/types.ts';
import { parseBaseUrl } from '../core/validation.ts';

export function createS3Client(config: ObjectStorageConfig): S3Client {
    const invalidConfig = () => {
        throw new ObjectStorageError('invalid_config', 'Invalid object storage configuration.');
    };
    if (
        !['r2', 's3'].includes(config.provider) ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
        !config.credentials?.accessKeyId?.trim() ||
        !config.credentials.secretAccessKey?.trim() ||
        (config.credentials.sessionToken !== undefined && !config.credentials.sessionToken.trim())
    )
        invalidConfig();
    let endpoint: string | undefined;
    let region: string;
    let forcePathStyle: boolean;
    if (config.provider === 'r2') {
        if (!/^[a-f0-9]{32}$/.test(config.accountId)) invalidConfig();
        if (config.jurisdiction !== undefined && !['eu', 'fedramp'].includes(config.jurisdiction))
            invalidConfig();
        const jurisdiction = config.jurisdiction ? `.${config.jurisdiction}` : '';
        endpoint = `https://${config.accountId}${jurisdiction}.r2.cloudflarestorage.com`;
        region = 'auto';
        forcePathStyle = true;
    } else {
        if (!/^[a-z0-9-]+$/.test(config.region)) invalidConfig();
        region = config.region;
        endpoint = config.endpoint === undefined ? undefined : parseBaseUrl(config.endpoint);
        forcePathStyle = config.forcePathStyle ?? false;
    }
    // No environment lookup or connection on import; credentials are supplied by the host app.
    const client = new S3Client({
        endpoint,
        region,
        forcePathStyle,
        credentials: { ...config.credentials },
        maxAttempts: 3,
        retryMode: 'standard',
        requestHandler: {
            connectionTimeout: 5_000,
            requestTimeout: 30_000,
            throwOnRequestTimeout: true,
        },
        // R2 and other S3 implementations need not support AWS's optional checksum defaults.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return client;
}
