# @scova/object-storage

服务端通用存储桶模块，使用官方 AWS SDK 接入 Cloudflare R2、AWS S3 和 S3 兼容服务。支持任意文件字节、上传、元信息、删除、公共链接与临时上传/下载签名，以及按用途隔离目录和文件策略。

## 使用

消费方声明 `"@scova/object-storage": "workspace:*"`，在仓库根执行 `vp install`。凭据由服务端应用传入，模块不读取环境变量或在导入时联网。

```ts
import { createObjectStorage, createStorageKey } from '@scova/object-storage';
import { createImageStorageView } from '@scova/object-storage/image';

const bucket = createObjectStorage({
    provider: 'r2',
    accountId, // Cloudflare 账号 ID
    bucket: bucketName,
    credentials: { accessKeyId, secretAccessKey },
    // keyPrefix: 'scova', // 所有目录的共同前缀，可选
    // publicBaseUrl: 'https://cdn.example.com', // 仅用于已有公共访问的 bucket
});

const avatars = createImageStorageView(
    bucket.scope('avatars', {
        maxSizeBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['image/webp'],
    }),
);
const tasks = bucket.scope('tasks');
const reports = bucket.scope('reports', {
    maxSizeBytes: 20 * 1024 * 1024,
    allowedContentTypes: ['application/pdf', 'text/markdown', 'application/json'],
});

const taskFiles = tasks.scope(taskId);
const attachment = await taskFiles.upload({
    key: 'source.txt',
    body: new TextEncoder().encode('参考资料'),
    contentType: 'text/plain',
    signal: AbortSignal.timeout(15_000),
}); // tasks/<taskId>/source.txt

const report = await reports.scope(reportId).upload({
    key: 'result.pdf',
    body: pdfBytes,
    contentType: 'application/pdf',
}); // reports/<reportId>/result.pdf
const privateUrl = await reports.presignDownload(report.key, { expiresIn: 300 });
await taskFiles.head(attachment.key);
await taskFiles.delete(attachment.key);

// 使用根 bucket 时，也可统一生成用途/归属/对象键，支持自定义用途。
const avatarKey = createStorageKey({
    purpose: 'avatars',
    ownerId: userId,
    objectId: version,
    extension: 'webp',
}); // avatars/<userId>/<version>.webp

// 应用停止接收请求并等待在途操作后，由根 bucket 统一关闭。
bucket.destroy();
```

目录采用对象 key 前缀，不需要提前创建文件夹。`avatars` 保持现有头像路径；`tasks`、`reports` 可以继续细分任务 ID、报告 ID 和文件名。`scope` 接受相对目录路径；如果使用用户提供的单段 ID，应先通过 `createStorageKey` 等业务校验，避免斜杠改变归属层级。

上传和上传签名的 `key` 相对当前 scope；返回的完整 key 用于 `head/delete/getPublicUrl/presignDownload`，不会重复加目录。作用域拒绝操作自身目录外的完整 key，子作用域共享根客户端且没有 `destroy`。目录限制不替代业务鉴权，应用仍需验证文件归属与会话权限。

## 文件策略与访问

- 默认上限 50 MiB，支持空文件。可在根配置或 `scope(directory, policy)` 设置 `maxSizeBytes` 和 `allowedContentTypes`。子目录只能降低大小上限或缩小类型集合；配置中的数组会复制，不受后续外部修改影响。
- MIME 必须是小写、无参数的类型，如 `application/pdf`、`text/plain`、`application/octet-stream`；不接受 `*/*` 或包含换行的头。通用模块按声明的 MIME 校验，不解析内容；图片签名识别由 [图片适配](#图片适配) 负责，头像完整解码/裁剪由 API 业务层负责。
- 不传 key 时生成无扩展名 UUID；传入同名 key 会覆盖对象。key 按 UTF-8 限制为 1024 字节，拒绝空段、`.`、`..`、反斜杠、控制字符和无效 UTF-16；`createStorageKey` 的每个组件只允许单段，扩展名只允许字母数字。
- 未配置公共域名时，`url/getPublicUrl` 返回 `null`。配置域名不会修改 bucket 权限。默认不设置 ACL。
- `presignUpload({ key?, contentType, size, expiresIn? })` 绑定精确 Content-Length 和 Content-Type；签名仅校验声明，后续内容校验与业务登记由消费方完成。浏览器直传需配置 bucket CORS，并通过应用统一通信层上传原始文件。当前头像仍通过 API 上传。
- 签名默认 900 秒，可设 1–3600 秒。签名 URL 属于临时凭证，避免记录到日志。私有下载需先由应用鉴权。
- `head` 仅在 HTTP 404 时返回 `null`，其他错误抛出脱敏的 `ObjectStorageError`。`code` 为 `invalid_config/invalid_key/invalid_file/file_too_large/invalid_expiry/storage_closed/request_aborted/storage_request_failed`。上游错误只保留 HTTP 状态，不保留原文或 cause。删除遵守 S3 版本管理语义。

## 图片适配

从 `@scova/object-storage/image` 导入 `createImageStorageView(scope, options?)`，在现有作用域上识别 JPEG、PNG、GIF 和 WebP 的文件签名，检查声明的类型并生成带扩展名的默认 key。默认上限为 10 MiB，根作用域更严格的文件策略仍然生效。图片视图借用同一客户端，不单独关闭它。需要独占客户端时，可用 `createImageStorage(config)`，并在业务停止后调用 `destroy()`。

签名校验不等于完整解码或安全检测，不支持 SVG/HTML。上传签名只检查声明，浏览器应直接发送原始文件而非 FormData；内容校验、访问权限及归属记录由业务负责。头像仍由 Server 完整解码、裁切和上传。[头像配置与旧环境变量兼容](../../docs/public/guides/account-avatars.md)不变。

图片接口抛出 `ImageStorageError`；对象错误中的 `invalid_file`、`file_too_large` 分别映射为 `invalid_image`、`image_too_large`，其他错误码保持一致。

## 提供商与结构

`src/core/` 保存契约、错误、key 和策略校验；`src/providers/s3.ts` 配置 S3 SDK 与 R2 端点；`src/storage.ts` 组织共享生命周期和作用域操作。

R2 自动设置账号端点、`region: auto` 和 path style，支持 `jurisdiction: 'eu' | 'fedramp'`。S3 使用 `{ provider: 's3', region, bucket, credentials, endpoint?, forcePathStyle? }`。端点和公开域名只接受无凭据、query、fragment 的 HTTPS URL。临时凭据可传 `sessionToken`，轮换后重建实例。SDK 最多三次尝试，连接超时 5 秒、单次请求超时 30 秒，上传、元信息和删除可传总时间限制 `signal`。

API 优先读取整组 `STORAGE_*`，未设置 `STORAGE_PROVIDER` 时兼容整组 `IMAGE_STORAGE_*`，不混用两组字段。配置示例见[账号头像](../../docs/public/guides/account-avatars.md)。API 的 `services.objectStorage()` 延迟创建并复用一个 bucket，`services.avatarStorage()` 借用其图片视图；后续任务和报告服务可通过前者取得目录作用域。

## 验证

仓库根执行 `vp test packages/object-storage/tests`、`vp run object-storage#build` 和 `vp check`。测试使用受控 SDK 与真实 SDK 离线签名，不访问云端。
