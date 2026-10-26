# SIGNAL v2.30 · 环境变量与获取指南

> 本表**以代码实际读取的变量为准**（逐个核对过 `_worker.js`）。**所有变量都是可选的**：不配 = 该功能保持关闭 / 用默认值，旧功能不受影响。

## 0. 先看这个：变量加在哪、怎么加

Cloudflare 控制台 → **Workers 和 Pages** → 你的 Worker（线上是 `zcc`）→ **设置** → **变量和机密** → **添加**。

| 类型 | 用途 | 怎么选 |
|---|---|---|
| **机密 / Secret** | 一切带 Key / Secret / Token / 密码 的值 | 添加时「类型」选**机密**，保存后不可再查看，只能覆盖 |
| **文本 / Text** | 开关、模型名、域名、JSON 配置等非敏感值 | 选**文本** |

三条规则：
1. **不要把任何值写进 `wrangler.jsonc` 或提交到 GitHub**。你是 Git 连接部署，只要 `wrangler.jsonc` 里不出现 `"vars"` 字段，控制台里加的变量每次部署后都会保留。
2. 改完变量需**重新部署一次**（或点「部署」）才生效；之后用**管理员账号**登录站点 → 扩展中心 → 通用 → 最下面的「运维（管理员）」卡片，亮绿色的小标签就是已被识别的能力（Google / Microsoft / RAG / SIEM / OTel / 加密存储）。
3. 带 🔒 的变量必须选「机密」。

---

## 1. P0

### 1.1 结构化日志 + 请求 ID

无需配置，每个响应自动带 `X-Request-Id`，日志是 JSON 行。

| 变量 | 说明 | 默认 |
|---|---|---|
| `ZC_LOG_LEVEL` | `debug` / `info` / `warn` / `error` / `off` | `info` |

**怎么用**：控制台 → Worker → **可观测性 / Logs**，搜索 `rid` 字段（值就是用户看到的请求 ID）。`wrangler.jsonc` 里已经开了 `observability`。

### 1.2 CSP（内容安全策略）

| 变量 | 说明 | 默认 |
|---|---|---|
| `ZC_CSP_MODE` | `enforce` 强制 / `report` 只上报不拦截（灰度）/ `off` 关闭 | `enforce` |

**怎么获取**：无需获取。上线后若发现页面某功能被拦，先改成 `report`，到日志里搜 CSP 违规（上报端点 `/__zc_csp__`），确认后再切回 `enforce`。

### 1.3 会话归档 / 标签

纯前端功能，**无变量**。会话右键 / 菜单里「归档」「标签」。

---

## 2. P1

### 2.1 MCP 支持

| 变量 | 说明 | 默认 |
|---|---|---|
| 🔒 `MCP_SERVERS` | **管理员全局** MCP 服务器，JSON 数组（见下），所有登录用户可见，请求头不会下发给浏览器 | 空 |
| `ZC_MCP_ALLOW` | 允许的 MCP 域名白名单，逗号分隔（含其子域）。留空 = 不限（仍禁内网） | 空 |
| `ZC_MCP_ALLOW_HTTP` | `1` 才允许 `http://` 地址 | 关 |

`MCP_SERVERS` 格式（`id` 与 `url` 必填，`headers` 最多 8 个）：

```json
[{"id":"docs","name":"文档检索","url":"https://example.com/mcp","headers":{"Authorization":"Bearer xxx"}}]
```

**怎么获取**：MCP 服务器的地址和鉴权方式由**该服务商文档**给出（形如 `https://…/mcp` + 一个 Token）。**不想用全局配置也行**：登录后在「扩展中心 → MCP 工具」里自己添加，令牌只存服务端、列表不回显。
安全：地址里禁止带账号密码、禁止内网 / 元数据地址（SSRF 防护，已测试）；调用 MCP 工具时 Agent 会先请用户确认。

### 2.2 Google / Microsoft 登录

**Google**

| 变量 | 说明 |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | 客户端 ID（文本即可） |
| 🔒 `GOOGLE_OAUTH_CLIENT_SECRET` | 客户端密钥 |

获取步骤：
1. <https://console.cloud.google.com/> → 选/建一个项目 → **API 和服务 → OAuth 同意屏幕**（User Type 选「外部」，填应用名、邮箱，保存）。
2. **凭据 → 创建凭据 → OAuth 客户端 ID → 应用类型选「Web 应用」**。
3. **已获授权的重定向 URI** 填：`https://你的域名/__zc_auth__/google/callback`（必须与实际域名**完全一致**，如 `https://zcc.zcatri520.workers.dev/__zc_auth__/google/callback`）。
4. 创建后复制「客户端 ID」「客户端密钥」。
5. 同意屏幕若为「测试」状态，只有「测试用户」能登录；要对外开放需点「发布应用」。

**Microsoft（Entra ID）**

| 变量 | 说明 | 默认 |
|---|---|---|
| `MICROSOFT_OAUTH_CLIENT_ID` | 应用（客户端）ID | — |
| 🔒 `MICROSOFT_OAUTH_CLIENT_SECRET` | 客户端密码的**值** | — |
| `MICROSOFT_OAUTH_TENANT` | `common`（任意 Microsoft 账号）/ `organizations`（仅工作或学校）/ `consumers`（仅个人）/ 你的租户 ID（仅本组织） | `common` |

获取步骤：
1. <https://entra.microsoft.com/> → **应用注册 → 新注册**；「受支持的账户类型」按需选；**重定向 URI** 选「Web」，填 `https://你的域名/__zc_auth__/microsoft/callback`。
2. 注册后在概览页复制「应用程序(客户端) ID」「目录(租户) ID」。
3. **证书和密码 → 新客户端密码**，创建后立刻复制「**值**」（不是「密码 ID」，且只显示一次）。

⚠️ **开启 Google / Microsoft 登录等于对外开放注册**：任何有这类账号的人都能自己登录并拿到「成员」权限（可用对话、Agent、沙箱）。只给内部用的站点请不要开。

**限制登录范围**：`ZC_AUTH_OAUTH_DOMAINS`（逗号分隔邮箱域名，如 `corp.com,corp.cn`）。
⚠️ **此变量只对 Google 生效，且只认「已验证」邮箱；一旦设置，Microsoft 登录会全部被拒绝**（代码刻意不信任 Microsoft 的邮箱声明）。想限制 Microsoft 登录范围，请改用 `MICROSOFT_OAUTH_TENANT=<你的租户ID>`，不要设此变量。

登录页会在**两对变量都配齐后**自动出现对应按钮；没配的提供方返回 501，不泄露任何配置。

### 2.3 管理员（运维接口）

| 变量 | 说明 | 默认 |
|---|---|---|
| `ZC_ROLE_ADMINS` | 管理员邮箱 / 账号标识，逗号分隔，如 `你的GitHub用户名@github` | 空 |

**作用**：只用于「扩展中心 → 通用 → 运维（管理员）」卡片和审计导出接口 `/__zc_ops__/*`。其余功能不分角色，登录用户一视同仁。
**怎么获取**：自己决定。**未开账号体系（单人自用）时，访问者一律按管理员处理。**

---

### 2.4 联网搜索 Key（v2.34.1，可选）
**用在哪**：聊天模式的「联网」开关、Agent 的 `web_search`。**不配也能用**——Worker 会走 DuckDuckGo-lite，没结果再走 Bing 网页版；但这两个是免费网页抓取，随时可能改版或限流，所以**经常搜不到时建议配一个 Key**。
| 变量 | 说明 |
|---|---|
| `TAVILY_API_KEY` | 优先使用。到 tavily.com 注册即可拿到 Key（有免费额度，具体以官网为准），专为 AI 检索设计，结果带摘要 |
| `BRAVE_SEARCH_KEY` | 其次使用。到 Brave Search API 官网申请 Key（额度与是否免费以官网为准） |
| `SEARCH_API_URL` + `SEARCH_API_KEY` | 自建 / 第三方搜索接口，URL 里用 `{q}` 占位关键词 |
**怎么加**：Cloudflare → Worker → 设置 → 变量和机密 → 添加，类型选「密钥」，保存后重新部署即可（同 0 节）。优先级：Tavily → Brave → 自定义 → DuckDuckGo-lite → Bing。

## 3. P2

| 功能 | 变量 | 说明 |
|---|---|---|
| 对话分支树 | 无 | 重新生成保留旧版本、可从任意消息分叉、编辑前自动备份 |
| 团队共享工作区 | 无 | 需**登录账号 + 已绑定 KV/D1**；创建团队 → 一次性邀请码 → 成员加入 → 分享对话 |
| PWA 离线 | 无 | `public/sw.js` + `manifest.webmanifest` + `icon.svg`，已在 `.assetsignore` 放行；浏览器会提示「安装」 |
| i18n | 无 | 前端中英切换 |

### 可观测性（OpenTelemetry）

| 变量 | 说明 | 默认 |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 地址（会自动补 `/v1/traces`）。**不配 = 不导出** | 空 |
| 🔒 `OTEL_EXPORTER_OTLP_HEADERS` | 鉴权头，格式 `键=值,键2=值2` | 空 |
| `OTEL_SERVICE_NAME` | 服务名 | `zc-gura` |
| `OTEL_SAMPLE` | 采样率 0~1 | `1` |

**怎么获取**：任选一个支持 OTLP/HTTP 的后端，注册后在其「接入 / Ingest」页面能拿到地址和 Key：
- **Grafana Cloud**：Connections → OpenTelemetry → 生成 token，得到 `…/otlp` 地址和 `Authorization=Basic …`。
- **Honeycomb**：Environment Settings → API Keys；`OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io`，`OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=你的Key`。
- 自建 **Jaeger / Tempo / OTel Collector**：填其 `http(s)://主机:4318` 即可。
（具体页面名称以各服务商当前界面为准。）每个请求导出一个 span，并续接入站 `traceparent`。

---

## 4. P3（按需）

### 4.1 数据加密密钥

| 变量 | 说明 | 默认 |
|---|---|---|
| 🔒 `ZC_DATA_KEY` | 加密存储用的主密钥（MCP 令牌等都用它加密）。**强烈建议自己设** | 未设时回退用 `ZC_ADMIN_TOKEN` |

**怎么获取**：自己生成一段随机串：`openssl rand -base64 32`（或任何密码管理器生成 32 位以上随机串）。
⚠️ **设了就不要再改**：更换后已加密的数据（MCP 令牌）无法解密，用户要重新填写。若不设，则 `ZC_ADMIN_TOKEN` 就兼任这个角色，之后改管理员令牌也会连带失效——所以最好现在就单独设一个。

### 4.2 向量知识库 / RAG

| 变量 | 说明 | 默认 |
|---|---|---|
| 🔒 `RAG_EMBED_API_KEY` | 嵌入（embedding）服务 Key | 沿用 `OPENAI_API_KEY` |
| `RAG_EMBED_BASE` | 接口根地址 | 默认 OpenAI |
| `RAG_EMBED_MODEL` | 嵌入模型名 | `text-embedding-3-small` |

**怎么获取**：已经配了 `OPENAI_API_KEY` 的话，**这一项可以完全不配**。要用别家就去该服务商控制台取 Key，并把 `RAG_EMBED_BASE` / `RAG_EMBED_MODEL` 改成该服务商的嵌入接口与模型。需要登录账号 + 绑定 KV/D1；文档按人隔离，向量以 int8 量化存储。

### 4.3 SIEM 审计归档

| 变量 | 说明 | 默认 |
|---|---|---|
| `SIEM_URL` | 接收端地址，**必须 https**。不配 = 不转发 | 空 |
| 🔒 `SIEM_TOKEN` | 接收端令牌 | 空 |
| `SIEM_FORMAT` | `splunk` = Splunk HEC 格式（`Authorization: Splunk <token>`）；其他 = JSON + `Bearer` | JSON |
| 🔒 `SIEM_HMAC_KEY` | 设置后每个请求带 `X-ZC-Signature: sha256=<hex>`，接收端可验签；也用于给导出的哈希链签名 | 空 |
| `SIEM_HTTP_ALL` | `1` = 连普通 HTTP 访问事件也转发（量很大，默认只转审计类事件） | 关 |

**怎么获取**：
- **Splunk**：Settings → Data inputs → HTTP Event Collector → New Token，得到 Token；URL 形如 `https://<主机>:8088/services/collector/event`，`SIEM_FORMAT=splunk`。
- **Datadog / Elastic / Axiom / Loki 等**：用其「HTTP 日志接入」端点和 API Key 作为 `SIEM_URL` / `SIEM_TOKEN`（接收端需接受 JSON + Bearer；不接受就在前面放一个转换用的 Worker）。
- `SIEM_HMAC_KEY`：自己生成，`openssl rand -hex 32`，同时配到接收端用来验签。
**导出**：管理员在 扩展中心 → 通用 → 「运维（管理员）」卡片里点「导出审计」，下载 `.ndjson`，每行带哈希链，逐行可验，篡改会被发现。转发失败不影响业务。（直接在地址栏打开接口地址不行：会话令牌放在请求头里，浏览器地址栏不会带。）

---

## 5. 推荐的最小上线配置

先只配这几项就能把大部分能力点亮：

| 优先 | 变量 | 点亮的能力 |
|---|---|---|
| 1 | 🔒 `ZC_DATA_KEY` | 先把加密主密钥固定下来（MCP 令牌） |
| 2 | `ZC_ROLE_ADMINS`（填 `你的GitHub用户名@github`） | 运维接口 / 审计导出 |
| 3 | 🔒 `RAG_EMBED_API_KEY`（或 `OPENAI_API_KEY`） | 知识库 |
| 4 | Google / Microsoft 两对变量 | 第三方登录 |
| 按需 | `MCP_SERVERS` · `OTEL_*` · `SIEM_*` | 集成与合规 |

## 6. 自检清单

- 管理员登录后看 扩展中心 → 通用 → 「运维（管理员）」卡片，每项能力亮绿色即识别成功。
- 控制台「变量和机密」里**所有 🔒 项**类型必须是「机密」。
- OAuth 回调地址与线上域名**逐字符一致**（含 `https`、无多余斜杠）。
- 先在 `ZC_CSP_MODE=report` 下灰度，再切正式。
- 本版本已把 v2.29 / v2.30 涉及的所有密钥加入**脱敏名单**：上游报错回显、安全自检「密钥未泄漏到前端」都会覆盖到它们。
