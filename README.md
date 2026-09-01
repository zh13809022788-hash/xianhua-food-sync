# 公众号自动同步服务

这个目录是小程序的后端同步层，不会被打进小程序前端包。

## 能力

- 用公众号 `AppID + AppSecret` 自动获取 `access_token`
- 分页调用 `/cgi-bin/freepublish/batchget`
- 首次全量扫描历史已发布内容
- 后续定时扫描最新内容，并按文章 ID 去重
- 把公众号文章标准化后交给 `utils/article-import.js`
- 有完整门店结构化信息的文章进入 accepted 结果
- 缺少门店信息的文章进入 `article-review-queue.json`
- 保存原始响应、同步状态和失败信息，便于重试与审计

## 配置

复制 `.env.example` 中的变量到运行环境。不要把 `AppSecret` 写进小程序代码、提交到仓库或发到聊天里。

```text
WECHAT_OFFICIAL_APPID=公众号AppID
WECHAT_OFFICIAL_APPSECRET=公众号AppSecret
WECHAT_SYNC_DATA_DIR=./data
```

## 运行

Node.js 18 或更高版本可直接使用内置 `fetch`：

```bash
node sync.js --full
node sync.js
```

首次使用 `--full` 扫描历史内容；之后用不带参数的命令做增量同步。建议由服务器计划任务每 30 分钟或每 1 小时执行一次。

Windows 计划任务示例：

```text
工作目录：I:\娴话逛吃小程序\backend
程序：node
参数：sync.js
```

## 内容 API

云托管部署时使用 `npm start` 或直接运行 `node api.js`，服务监听 `process.env.PORT`；本地开发仍可继续使用 `CONTENT_API_HOST` / `CONTENT_API_PORT`。

当前 CloudBase 环境已经创建唯一的云存储桶 `xianhua-content`，后端通过云存储保存同步数据。

```text
CLOUDBASE_ENV_ID=xianhuanshuo-d0g06ofbub52c6721
CLOUDBASE_SERVICE_NAME=xianhua-content-api
# 为空：直接写入唯一桶 xianhua-content 的根目录
CLOUDBASE_STORAGE_PREFIX=
```

首次同步时会自动写入 `content.json`、`published-articles.json`、`article-review-queue.json`、`sync-state.json` 四个文件。不要手动上传、创建文件夹或创建 `xianhua_content` 数据库集合。公众号凭证只放在云托管环境变量里，不要写进小程序代码或仓库。

接口：

- `GET /health`：健康检查。
- `GET /api/content`：返回小程序需要的 `articles`、`stores`、`goods`、`generatedAt`、`syncState`。
- `GET /api/stores/:id`：按门店 ID 获取门店。
- `GET /api/articles/:id`：按文章 ID 获取文章。
- `POST /api/sync`：远程触发一次公众号同步（云端部署时用，免登录服务器）。需要配置 `SYNC_TRIGGER_TOKEN` 环境变量，并在请求头带 `x-sync-token`。触发后立即返回，同步在后台执行。
- `GET /api/sync/status`：查询同步状态（是否正在同步、上次结果、上次错误、sync-state 统计）。

云端触发同步示例：

```bash
curl -X POST https://<服务访问地址>/api/sync -H "x-sync-token: <你的SYNC_TRIGGER_TOKEN>"
curl https://<服务访问地址>/api/sync/status
```

小程序通过 `wx.cloud.callContainer` 调用时，不需要配置 request 合法域名；但必须在小程序开发者工具和 CloudBase 控制台关联同一环境，且服务名必须精确匹配。`app.js` 里需要填写环境 ID 和服务名。`CONTENT_API_BASE` 仍保留作 HTTPS 备用链路，要求使用已备案、可访问、证书有效的 HTTPS 地址。

## 重要限制

公众号接口能否返回已发布内容，取决于账号当前权限。个人主体、企业主体未认证账号及不支持认证的账号，相关发布能力接口可能被平台回收。遇到微信接口权限错误时，服务会失败退出并保留错误码；不能通过本服务绕过平台权限。

如果接口不可用，使用批量导入兜底：一次准备一个 JSON 数组，交给 `utils/article-import.js` 统一校验，不需要逐篇在聊天里发送。没有真实公众号文章链接或没有可靠门店来源的记录不会进入正式门店数据。
