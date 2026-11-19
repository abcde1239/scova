# 账号头像

在「账号」页面选择图片，预览后点击「上传头像」。支持 JPEG、PNG、GIF 和 WebP，原文件最多 5 MiB、最多 1600 万像素；服务端居中裁剪为 256×256 WebP 并移除 EXIF 等元信息，动图取第一帧。保存后桌面账号菜单和手机导航同步更新，重新登录仍保留；「移除头像」恢复默认头像；图片读取失败时也回退默认头像。默认头像为仓库内的圆形裁剪插画，不依赖图床。

浏览器将原始图片上传至 Scova API，由后端处理后保存到 R2/S3；浏览器不持有存储密钥。选择和取消预览不会写入存储；默认图片也无法读取时，最终回退为邮箱首字母。

## Cloudflare R2 配置

头像通过 [`@scova/object-storage/image`](../../../packages/object-storage/README.md#图片适配) 保存。部署默认关闭上传，未配置时页面明确提示且不影响其他账号功能。在根 `.env.local`（本地开发）或 Compose 使用的 `.env` 中配置：

```dotenv
STORAGE_PROVIDER=r2
STORAGE_BUCKET=your-private-bucket
STORAGE_R2_ACCOUNT_ID=your-cloudflare-account-id
STORAGE_ACCESS_KEY_ID=your-r2-access-key-id
STORAGE_SECRET_ACCESS_KEY=your-r2-secret-access-key
```

优先使用整组 `STORAGE_*`；未设置 `STORAGE_PROVIDER` 时兼容整组旧 `IMAGE_STORAGE_*`，两组字段不会混用。头像通过图片适配层复用[通用存储桶](../../../packages/object-storage/README.md)，原 `avatars/<用户ID>/<版本>.webp` 路径保持不变。

使用具有该 bucket 对象读写权限的 R2 S3 API 凭据。EU/FedRAMP bucket 另外设置 `STORAGE_R2_JURISDICTION=eu` 或 `fedramp`。头像使用私有 bucket，无需开启公共访问或浏览器直传 CORS；所有上传经 API，图片通过本人 Cookie 会话校验后跳转至五分钟签名地址。签名 URL 是临时访问凭证，不应写入日志。

配置仅由 API 读取；不要添加 `VITE_` 前缀，也不要在网页或公开仓库填写真实密钥。修改后重启 API；会话 DTO 只包含随机 `avatarVersion`，不返回对象路径、存储配置或密钥。

升级已有部署时，先备份数据库，再按[数据库说明](../../../packages/db/README.md)运行增量迁移。新增的 `0005_fresh_iron_patriot.sql` 仅增加可空的 `users.avatar_version`，不重置账号。标准 Compose 的 migrate 服务会先于 API 执行迁移。

本地配置完成后运行 `vp run db:migrate`，再分别通过 `vp run dev:server` 和 `vp run dev:frontend` 启动 API 与前端。打开「账号」页面后，「选择图片」可用表示 API 已启用存储；保存后的图片还需具备对应桶的读写权限才能正常上传和显示。

## S3 与兼容服务

设置 `STORAGE_PROVIDER=s3`，沿用 bucket 和两项密钥，另外设置 `STORAGE_REGION`。兼容服务可配置 HTTPS `STORAGE_ENDPOINT` 与 `STORAGE_FORCE_PATH_STYLE=true`；使用临时凭据时填写 `STORAGE_SESSION_TOKEN`，轮换后重启 API。默认 AWS S3 无需自定义 endpoint。

## 行为与维护

头像上传和移除要求本人会话、Origin、CSRF 和预期版本，同账号每分钟最多 10 次，部署合计 100 次。并发更新返回冲突，先点「刷新头像」后重试；上传失败保留旧头像。网络结果不明时也应先刷新确认，不自动重发。

对象使用 `avatars/<userId>/<version>.webp` 独立 key。先上传新对象，再原子更新数据库；更新成功后尝试删除旧对象，明确的并发冲突会清理候选。数据库提交结果不明或旧对象删除失败时可能残留无引用对象，当前没有自动垃圾回收；清理时必须与数据库现用 key 核对，不能按对象年龄直接删除整个头像前缀。启用 bucket 版本管理时还需按存储服务规则管理历史版本。

仓库根目录验证：

```sh
vp test apps/server/tests/avatar.test.ts
vp test --config tests/avatar.vite.config.ts
vp run test:e2e -- tests/e2e/avatar.spec.ts
```

集成测试使用独立测试 PostgreSQL/Redis 与受控图床；浏览器测试使用固定接口响应，不代表真实 R2 读写已验证。
