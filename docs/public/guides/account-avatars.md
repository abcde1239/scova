# 账号头像

在「账号」页面为自己设置头像。保存后，桌面账号菜单和手机导航会同步更新，重新登录仍保留。

## 上传头像

1. 打开「账号」页面，点「选择图片」。
2. 预览满意后点「上传头像」。
3. 想恢复默认头像时，点「移除头像」。

- **支持格式**：JPEG、PNG、GIF 和 WebP。
- **大小限制**：原文件最多 5 MiB，最多 1600 万像素。
- **自动处理**：居中裁剪为 256×256 的 WebP，并移除 EXIF 等元信息。动图取第一帧。
- **默认头像**：仓库内的圆形裁剪插画，不依赖图床。图片读取失败时也会回退到默认头像；默认头像也读不到时，显示邮箱首字母。
- **预览**：选择和取消预览都不会写入存储。

「选择图片」不可用，或页面提示未启用上传时，说明部署还没有配置存储，联系管理员。这不影响其他账号功能。

## 配置存储（管理员）

头像由后端处理后保存到私有的 R2/S3 bucket。浏览器不持有存储密钥，所有上传都经 API，不需要开启公共访问或浏览器直传 CORS。头像存储复用[通用存储桶](../../../packages/object-storage/README.md)，细节见其[图片适配](../../../packages/object-storage/README.md#图片适配)说明。

### Cloudflare R2

在根 `.env.local`（本地开发）或 Compose 使用的 `.env` 中配置：

```dotenv
STORAGE_PROVIDER=r2
STORAGE_BUCKET=your-private-bucket
STORAGE_R2_ACCOUNT_ID=your-cloudflare-account-id
STORAGE_ACCESS_KEY_ID=your-r2-access-key-id
STORAGE_SECRET_ACCESS_KEY=your-r2-secret-access-key
```

- **凭据**：使用具有该 bucket 对象读写权限的 R2 S3 API 凭据。
- **EU / FedRAMP bucket**：另外设置 `STORAGE_R2_JURISDICTION=eu` 或 `fedramp`。
- **旧变量**：优先使用整组 `STORAGE_*`；未设置 `STORAGE_PROVIDER` 时兼容整组旧 `IMAGE_STORAGE_*`，两组字段不会混用。
- **生效**：这些配置只由 API 读取，修改后重启 API。不要添加 `VITE_` 前缀，也不要在网页或公开仓库填写真实密钥。

### S3 与兼容服务

设置 `STORAGE_PROVIDER=s3`，沿用 bucket 和两项密钥，另外设置 `STORAGE_REGION`。

- **兼容服务**：配置 HTTPS 的 `STORAGE_ENDPOINT` 与 `STORAGE_FORCE_PATH_STYLE=true`。默认 AWS S3 无需自定义 endpoint。
- **临时凭据**：填写 `STORAGE_SESSION_TOKEN`，轮换后重启 API。

### 本地启用

配置完成后运行：

```sh
vp run db:migrate
vp run dev:server
vp run dev:frontend
```

打开「账号」页面，「选择图片」可用即表示 API 已启用存储。上传和显示还需要对应 bucket 的读写权限。

### 升级已有部署

先备份数据库，再按[数据库说明](../../../packages/db/README.md)运行增量迁移。迁移只新增可空的 `users.avatar_version`，不会重置账号。标准 Compose 的 migrate 服务会先于 API 执行迁移。

## 限制与说明

- **访问方式**：图片通过本人 Cookie 会话校验后，跳转到五分钟有效的签名地址。签名 URL 是临时访问凭证，不要写入日志。
- **频率限制**：同一账号每分钟最多上传或移除 10 次，部署合计 100 次。
- **并发冲突**：多处同时修改会返回冲突，先点「刷新头像」再重试。
- **失败与结果不明**：上传失败会保留旧头像。网络结果不明时，先刷新确认，不要自动重发。
- **存储路径**：对象保存为 `avatars/<userId>/<version>.webp`。先上传新对象，再更新数据库，成功后尝试删除旧对象。
- **残留对象**：数据库提交结果不明或旧对象删除失败时，可能留下无引用的对象，目前没有自动清理。清理时必须与数据库中的现用 key 核对，不能按对象年龄直接删除整个头像前缀。启用 bucket 版本管理时，还需按存储服务规则管理历史版本。
