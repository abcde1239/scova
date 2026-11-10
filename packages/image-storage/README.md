# @scova/image-storage

服务端图片适配模块，基于 [`@scova/object-storage`](../object-storage/README.md) 接入 Cloudflare R2、AWS S3 和其他 S3 服务。支持 JPEG、PNG、GIF、WebP 上传、对象元信息、删除、公开链接及临时签名 URL。Scova 的[账号头像](../../docs/public/guides/account-avatars.md)已通过 API 接入。

图片规则位于 `src/core/`，`src/storage.ts` 将图片校验委托至通用存储。其他类型的附件请直接使用通用包。已有 bucket 可以通过 `createImageStorageView(bucket.scope('avatars'))` 复用；视图不提供 `destroy`，由 bucket 所有者统一关闭。视图上传 key 相对目录，返回值包含完整目录，遵守下方对象规则。

## Cloudflare R2

消费方在工作区的 `dependencies` 中声明 `"@scova/image-storage": "workspace:*"`，并在仓库根目录执行 `vp install`。创建 R2 bucket 和具有该 bucket 对象读写权限的 R2 API 凭据，将配置传入服务端：

```ts
import { readFile } from 'node:fs/promises';
import { createImageStorage } from '@scova/image-storage';

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
}

const images = createImageStorage({
    provider: 'r2',
    accountId: requiredEnv('R2_ACCOUNT_ID'),
    bucket: requiredEnv('R2_BUCKET'),
    credentials: {
        accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
    // 可选：已为 bucket 启用的自定义域名或 r2.dev 地址。
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
    keyPrefix: 'scova',
    maxSizeBytes: 10 * 1024 * 1024,
});

try {
    const image = await images.upload({
        body: await readFile('./photo.png'),
        signal: AbortSignal.timeout(15_000),
    });
    console.log(image.key, image.url); // scova/<uuid>.png；未配置公开域名时 url 为 null
    const metadata = await images.head(image.key);
    const privateUrl = await images.presignDownload(image.key, { expiresIn: 300 });
    // await images.delete(image.key);
} finally {
    images.destroy(); // 应用中应复用实例，在停止领取请求并等待在途操作后关闭
}
```

这些环境变量是示例中由应用读取的名称；模块本身不读取环境变量，不在导入时联网。R2 自动使用 `https://<accountId>.r2.cloudflarestorage.com`、`region: auto` 和 path style；受限辖区可指定 `jurisdiction: 'eu' | 'fedramp'`。这里使用的是 R2 S3 API 的 Access Key ID / Secret Access Key，不是 Cloudflare 管理 API 的 Bearer Token，也不是 Cloudflare Images API。

公开链接需要在 Cloudflare 开启 bucket 公共访问并绑定对应域名；传入 `publicBaseUrl` 只负责构造链接，不修改 bucket 权限。生产环境推荐自定义域名；私有 bucket 使用 `presignDownload`。

## AWS S3 与兼容服务

```ts
const images = createImageStorage({
    provider: 's3',
    region: 'ap-northeast-1',
    bucket: 'my-images',
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    // 兼容服务可额外配置：
    // endpoint: 'https://storage.example.com',
    // forcePathStyle: true,
    publicBaseUrl: 'https://cdn.example.com',
});
```

地址仅接受 HTTPS。凭据由应用提供并在实例创建时复制；临时凭据过期或轮换后需重新创建实例，签名有效期也受凭据本身有效期限制。SDK 连接超时为 5 秒、单次请求超时为 30 秒、最多 3 次尝试；`upload/head/delete` 可传入更短的总超时 `AbortSignal`。不设置对象 ACL，兼容 R2 与禁用 ACL 的 S3 bucket。

## 浏览器直传

由服务端认证并授权后签发：

```ts
const upload = await images.presignUpload({
    contentType: 'image/png',
    size: 12345, // 实际文件字节数，默认最多 10 MiB
    expiresIn: 300,
});
```

返回 `key`、`url`、`publicUrl`、`method: 'PUT'`、`headers`、`size` 和 `expiresIn`。浏览器将原始 `File` 作为请求体，按返回的 Content-Type 发送，不能包装成 FormData；浏览器自动生成的 Content-Length 必须等于签名时的 `size`。签名绑定这两个头，默认有效期 900 秒，允许 1–3600 秒。前端通过项目统一通信模块的 native 入口发起该 PUT；需要在 bucket CORS 中允许应用 origin、PUT 与 Content-Type，若读取 ETag 则同时暴露 ETag。

签名时只能检查声明的类型和大小，无法检查尚未上传的文件内容。直传后的内容校验、完整图片解码/重编码和业务归属记录由消费方实现；通过 `head` 只能核对大小和元信息。公开 bucket 的直传对象可能立即公开，需要审核的文件应使用私有 bucket 并验证后发布。临时 URL 本身是访问凭证，应避免记录到日志。

## 对象规则与错误

- `upload` 接受 Buffer/Uint8Array，上传前检查大小与文件头，提供 `contentType` 时必须与文件头匹配。不支持 SVG/HTML；文件头识别不等同于完整图片解码或恶意内容检测。
- 不传 `key` 时生成 UUID 与扩展名；传入时按原名称保存，已有同名对象会被覆盖。建议使用默认 UUID；`cacheControl` 可按业务指定，不默认设置长期不可变缓存。
- 上传的自定义 `key` 相对 `keyPrefix`；返回的 `key` 包含前缀。`head/delete/getPublicUrl/presignDownload` 均接收完整 key，并拒绝前缀外对象。前缀是调用边界，不替代应用鉴权或 bucket 权限。
- key 按 UTF-8 限制为 1024 字节，拒绝空段、`.`、`..`、反斜杠与控制字符；URL 逐段编码，保留中文、空格等合法名称。
- `head` 仅在 HTTP 404 时返回 `null`；403、网络错误等抛出 `ImageStorageError`。删除遵守 S3 幂等语义；启用版本管理时遵守供应商 delete marker 规则，不代表永久清除历史版本。
- `ImageStorageError.code` 包括 `invalid_config/invalid_key/invalid_image/image_too_large/invalid_expiry/storage_closed/request_aborted/storage_request_failed`；上游错误仅保留 HTTP 状态码，不保留原文、密钥、签名 URL 或原始 cause。

## 验证

仓库根目录执行：

```sh
vp test packages/image-storage/tests/storage.test.ts
vp run image-storage#build
vp check
```

测试使用受控 SDK 调用和真实 SDK 离线签名，不访问实际 bucket 或使用云端凭据。
