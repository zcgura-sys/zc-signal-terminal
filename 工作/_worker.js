// ============================================================================
// ZC-GURA · 企业级 AI 对话工作台（本构建：Cloudflare Pages · Direct Upload · 单文件 _worker.js 版，前端已内嵌）
// ----------------------------------------------------------------------------
// 部署（Cloudflare Pages 拖拽部署；本文件为自包含单文件，前端已内嵌，无需其它素材）：
//   1) Dashboard → Workers & Pages → Create → Pages → Upload assets（Direct Upload）
//   2) 拖拽本文件夹（或 SIGNAL-pages-single.zip）上传 → Deploy
//   3) Settings → Variables and Secrets 添加 GITHUB_TOKEN 等，然后重新拖拽部署一次生效
//   说明：官方文档明确 Dashboard 拖拽不支持 `functions/` 目录、但支持 `_worker.js`（Advanced Mode）。
//   本版对非文档类请求会尝试 env.ASSETS；索引与页面始终由内嵌 HTML 提供，即使没有静态素材也能打开。
//   云端沙箱（Containers）为 Workers 专属绑定，本版如实显示「未配置」；真实终端请用「GitHub 终端」。
// 可选：绑定 KV 命名空间（变量名 ZC_KV）后，设置 → 数据 中可开启跨设备云同步。
//
// 本文件包含三部分：
//   1) 同源反向代理 /__zc_relay__   —— 解决第三方 API 不带 CORS 头导致的
//      "Failed to fetch"，以及 HTTPS 页面访问 http:// 接口的混合内容拦截；
//      支持 SSE 流式透传、上游连接失败自动重试一次、客户端断开即取消上游。
//   2) 可选 KV 云同步接口 /__zc_kv__/(status|get|set|delete)
//      —— 上传前在浏览器本地用「同步密钥」派生的 AES-GCM 密钥加密，Worker/KV 中
//      只存放密文，服务端和网络中间人都无法读取明文内容（含 API Key）。
//      注意：这仍是"共享密钥"模型——任何人只要拿到与你完全相同的同步密钥，
//      就能解密并读取/覆盖这份数据，因此请使用足够长的随机密钥（建议用页面内
//      的"生成随机密钥"按钮），不要使用容易被猜到或和他人重复的词句。
//   3) 前端单页应用（下方 html 模板）：多 API 管理（OpenAI / Claude / Gemini /
//      Ollama）、流式对话、思考过程展示、图片与文件附件、图片生成、会话管理、
//      导出/备份、Token 统计等。
//
// 可选环境变量（Workers → 设置 → 变量）：
//   ZC_RELAY_ALLOW   逗号分隔的允许代理的域名后缀，如 "openai.com,anthropic.com"；
//                    留空表示允许代理任意公网 http/https 地址。
//   ZC_RELAY_TIMEOUT_MS  等待上游返回响应头的最长时间（默认 240000）。
//
// 新增（v2.1，Coding Agent 云端能力，全部为可选配置）：
//   4) /__zc_sandbox__/*  云端 Linux 沙箱（Cloudflare Containers + Durable Object
//      绑定 SANDBOX），提供真正的云端 Terminal（node/npm/python/pip/git）、
//      /workspace 文件系统与文件下载；需配合随附的 wrangler.jsonc + Dockerfile
//      部署（wrangler deploy / Workers Builds），未配置时前端自动隐藏云端入口。
//   5) /__zc_web__/(fetch|search)  Agent 的 web_fetch / web_search 工具，
//      带 SSRF 防护（拒绝内网 / localhost / Cloudflare 内部地址）。
//   6) /__zc_run__  Agent 的 run_script 工具：转发到 Piston 公共执行沙箱
//      （Judge0 / Wandbox 公共沙箱，真实容器执行 20 种语言脚本），
//      单文件粘贴部署即可用，无需任何配置。
// 可选 Secret（wrangler secret put ...，绝不写入代码 / 前端 / 模型上下文）：
//   GITHUB_TOKEN       私有仓库 clone 用（git 凭证由 Worker 注入容器，输出自动脱敏）
//   TAVILY_API_KEY     web_search 优先使用 Tavily
//   BRAVE_SEARCH_KEY   其次使用 Brave Search
//   SEARCH_API_URL / SEARCH_API_KEY  自定义搜索接口（URL 中 {q} 为关键词占位符）
// 可选环境变量：
//   PISTON_URL         自建 Piston 执行服务地址（可选；默认走免费公共执行沙箱）
//
// 新增（v2.2，一体化 Coding Agent 增强：审计 / 任务 / 审批 / 文件侧边栏）：
//   7) /__zc_audit__     审计日志（可筛选 / 导出；密钥自动脱敏；普通调用无法改写或删除历史条目）
//   8) /__zc_task__      后台任务状态（创建 / 更新 / 查询 / 请求取消）
//   9) /__zc_approval__  审批中心（敏感操作申请 → 用户批准 / 拒绝；范围：单次 / 本次任务 / 持续策略）
//  10) 前端「项目文件」侧边栏增强：刷新 / 展开 / 折叠 / 搜索 / 新建 / 重命名 / 删除 / 编辑保存，
//      显示工作区来源（云端沙箱 / 本地目录）、工作目录、文件数、用量与同步状态，改动后自动刷新。
//  11) 云端终端状态徽标：未配置 / 等待授权 / 连接失败 / 额度不足 / 已连接（据实显示，绝不伪装）。
//  12) GitHub Actions 真实终端（v2.3，粘贴部署即可用）：/__zc_ghterm__，经 GitHub 官方 REST API
//      集成官方托管的 Ubuntu Runner（真实 Bash / Python / Node / Git，有网络可装依赖、构建、测试）。
//      需一次性配置 GITHUB_TOKEN（经典 PAT：repo + workflow；或细粒度 PAT：Contents/Workflows
//      读写、Administration 读写、Metadata 只读）。公开仓库免费；私有仓库消耗账户免费分钟。
//  13) 账号体系（v2.5 邮箱验证码已于 v2.16 下线；v2.13 起支持 GitHub OAuth 一键登录 + 邀请码注册；可选，需绑定 KV 才生效）：/__zc_auth__，
//      密码只存 PBKDF2-SHA256 加盐哈希；启用后全部受控接口需携带登录会话（x-zc-session）。
//      必填变量：ZC_SMTP_USER / ZC_SMTP_PASS（QQ 邮箱 + SMTP 授权码）；
//      可选：ZC_ADMIN_TOKEN（/__zc_admin__ 用户管理）、ZC_AUTH_EMAIL_DOMAINS、ZC_AUTH_DISABLED=1。
//
//  14) E2B 云端 Linux 沙箱（v2.14，可选）：/__zc_sandbox__，配置变量 E2B_API_KEY 即启用。
//      走 e2b.dev 官方 API（api.e2b.app，头 X-API-Key）+ 沙箱内 envd（sandbox.e2b.app，
//      Connect 协议 /process.Process/Start），命令与文件操作都在真实 Linux 里执行；
//      密钥只存 Worker 变量，浏览器永远拿不到。
//      可选：E2B_TEMPLATE_ID（默认 base）、E2B_TIMEOUT_SECONDS（默认 1800，上限 3600）、E2B_AUTO_PAUSE（默认开：到期暂停而不是销毁）、E2B_MAX_RUN_SECONDS（默认 3000：连续运行满这么久主动「暂停→恢复」一次；0 关闭）、
//            E2B_ALLOW_INTERNET（默认 true）。未配置时云端工作区如实显示不可用。
//      v2.21.3 稳定性修复（Agent 云端 / GitHub 终端）：
//        · 安全网关：/__zc_sandbox__ 与 /__zc_ghterm__ 改用独立的宽额度分桶（ZC_SEC_RATE_AGENT，默认 600 次/分钟），
//          限流只回 429 + Retry-After，不再因“超频”累计封禁 IP（旧版同步几十个文件会触发 403 并连带 GitHub 终端一起断开）；
//          旧版遗留的「rate:」封禁记录自动失效。
//        · E2B：默认存活 1800 秒，每次调用/心跳用 /timeout 覆盖式续期；网络抖动重试时复用原沙箱，不再误建空沙箱；
//          新增 writemany 批量写入（一次沙箱执行写多个文件）、写入后大小校验；响应带 sandboxId 供前端发现沙箱被重建。
//        · GitHub：API 请求遇到 5xx / 429 / 次级限流自动退避重试；同步推送改为「分批生成 blob + 一次提交」，
//          拉回改为分批，规避 Cloudflare 单次请求子请求数上限；触发工作流后按时间戳匹配本次运行，避免读到旧运行结果。
//        · 新增 /__zc_web__/oss：GitHub / GitLab / Codeberg / npm 开源平台检索（Agent 工具 open_source_search）。
//      v2.22（Agent「云端执行 + 本地目录」混合模式）：
// v2.30.5：① zcE2bInfoEx 三态（alive / gone / unknown）：只有 E2B 明确 404 / 410 才重建沙箱，接口抖动 / 限流绝不新建空沙箱（旧逻辑会让 /workspace 里没拉回的文件全部丢失）；
//         ② 新增 /__zc_web__/ghtar：流式透传 GitHub 公开仓库源码包（Agent 工具 github_to_local 用，不解压、不带 token、≤80MB）。
// v2.30.4：沙箱新增 readmany 批量读取接口（一次执行读回一批小文件，逐个带大小 + SHA-1）——拉回几百个文件不再是几百次沙箱往返（旧逐个 readchunk 会撞 SEC_RATE 限流、拖到十几分钟）。
//
//        · 修复“开着产物拉回却拉不回文件”：沙箱新增 readchunk 分块读取接口（二进制安全、带 SHA-1 校验），突破旧 read 只能读回约 150KB 的上限；
//          原先超过该大小的文件被判“读被截断”而静默跳过，二进制 / >1MB 的文件更是直接 continue，拉回 0 个时也完全不提示。
//        · 修复混合模式一直拿到“本地模式”系统提示词（混合模式提示词是死代码），模型因此让用户去点混合模式里根本不存在的「拉回」按钮。
//        · 混合模式工具栏新增「拉回」按钮（手动对比云端 /workspace 与本地，支持文本与二进制）。
//        · 新增工具 pull_from_cloud：模型可向用户申请授权拉回指定文件（含二进制 / 大文件），并可同时申请“本次会话内自动拉回”。
//        · 命令结果里如实列出“未拉回的文件与原因”，模型据此决定是否申请授权。
//        · 新增「技能（Skills）」：用户可自己编写 / 导入 / 导出 / 启停技能，Agent 通过 use_skill 工具按需载入，输入框支持 /技能名 直接点名。
//  13.1) GitHub OAuth 一键登录（v2.13，推荐主入口；不受邮箱服务商反垃圾影响）：
//      GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET  在 GitHub → Settings → Developer settings →
//        OAuth Apps → New OAuth app 里创建；Authorization callback URL 必须填
//        https://<你的站点域名>/__zc_auth__/github/callback
//      ZC_AUTH_GH_LOGINS    可选白名单，逗号分隔的 GitHub 用户名；填了就只允许这些人登录
//      GITHUB_OAUTH_REDIRECT_URI  可选，站点有多个域名时指定固定回调前缀（不含路径）
//  13.2) 邀请码注册（v2.13，兜底入口）：ZC_AUTH_INVITE_CODES，逗号分隔的邀请码
//      （账号为 账号名@invite.local，登录时只填账号名即可）
// 可选环境变量：
//   ZC_REQUIRE_APPROVALS=1  启用后，云端沙箱高风险接口（exec/write/delete/mkdir/download）
//      必须存在已批准的匹配审批单（请求头 x-zc-approval 或同源页面刚批准）才会执行；
//      未启用时由页面内的确认弹窗负责审批，同样会写入审计日志。
//
// 与旧版数据兼容：沿用 localStorage 键前缀 zc_gura_ 及数据结构，同一域名下
// 旧版保存的 API 配置、会话记录、系统提示词会被自动读取。
// ============================================================================
// v2.23（前后端分离 + Agent 能力增强）：
//   · 前后端分离（扁平布局）：前端页面从 _worker.js 中抽出，放在**仓库根目录**：
//       index.html   主应用（与旧版内嵌 HTML 逐字节一致）
//       admin.html   用户管理页
//     之所以放根目录而不是 public/ 子目录，是为了让手机 / 网页端上传时能直接
//     选文件，不必先建文件夹。
//     wrangler.jsonc 增加 assets 绑定（directory=".", binding=ASSETS,
//     run_worker_first=true ⇒ 先过安全网关，再由 Worker 取静态文件）。
//     ⚠️ 静态资源是「公开可访问」的，因此仓库根目录必须配套 .assetsignore
//     白名单（* + !index.html + !admin.html），只放行这两个页面，
//     其余文件（含本文件、wrangler.jsonc、node_modules、.git）全部不上传。
//     取不到静态资源时回退到极简兜底页，站点不会白屏。
//     本文件此后只含后端；页面请改 index.html / admin.html。
//   · 上下文压缩（对齐 Claude Code 的 compact）：Agent 长任务历史接近窗口
//     上限时自动把早先对话段压成结构化摘要；设置里可开关/调阈值；输入框
//     支持 /compact 手动压缩任务执行记录。摘要写入快照，续接不丢。
//   · TodoWrite 任务清单：新增 todo_write 工具，模型维护结构化待办，
//     面板实时显示，清单随快照持久化并在续接时注入系统提示词。
//   · 计划增强：执行计划改由模型结合任务目标与项目上下文生成（JSON），
//     失败时自动回退关键词推断，并标注计划来源（模型生成/关键词推断/续接沿用）。
// ============================================================================
// v2.25（安全修复 · 隐私）审计 / 后台任务 / 审批按登录账号隔离
//   · 修复：/__zc_audit__、/__zc_task__、/__zc_approval__ 三类记录原先共用全局 KV 键
//     且只校验「是否登录」——任何登录用户都能在「审计与权限」面板看到别人的后台
//     任务 / 审计条目 / 审批详情，还能改写、取消别人的任务、批准别人的审批单、
//     一键清空所有人的审计日志。
//   · 现每条记录写入时打上服务端解析的 owner（登录会话邮箱，客户端无法伪造），
//     查询 / 追加 / 清空 / 任务更新与取消 / 审批决定 / 策略撤销全部按 owner 过滤，
//     跨账号操作一律 404（不暴露存在性）并写一条 denied 审计；沙箱与 GitHub 终端
//     的审批闸门也只认当前账号自己的审批单。
//   · 持久化按 owner 分组各保留最近 N 条，别人的高频写入不会挤掉自己的记录。
//   · 无归属的历史条目按 anon 处理：启用登录后不再可见（宁可看不到也不跨账号泄露）。
//   · 回归测试：node test_owner_isolation.mjs。
// ============================================================================

//（Pages 版：Durable Object 为 Cloudflare Workers 专属，此构建已移除其导入与实现）
//（Pages 版：SMTP 走运行时动态加载 cloudflare:sockets；若运行时不支持，会在发信时给出明确报错）
let __zcPagesSockMod = null;
async function zcPagesConnect(opts) {
  if (!__zcPagesSockMod) __zcPagesSockMod = await import('cloudflare:sockets');
  return __zcPagesSockMod.connect(opts, { secureTransport: 'on', allowHalfOpen: false });
}

const ZC_VERSION = '2.34.2';
const ZC_RELAY_PATH = '/__zc_relay__';
const ZC_KV_PATH = '/__zc_kv__';
const ZC_HEALTH_PATH = '/__zc_health__';
const ZC_SBX_PATH = '/__zc_sandbox__';
const ZC_WEB_PATH = '/__zc_web__';
const ZC_WEB_MAX_BYTES = 2 * 1024 * 1024;   // web_fetch 单页面上限
const ZC_SBX_MAX_BODY_BYTES = 24 * 1024 * 1024;
const ZC_RUN_PATH = '/__zc_run__'; // 沙箱接口请求体上限（write_file 内容）
const ZC_KV_KEY_PREFIX = 'zc_sync:';
const ZC_KV_MAX_BYTES = 8 * 1024 * 1024;          // 单个同步空间上限（KV 单值上限 25MB）
const ZC_RELAY_DEFAULT_TIMEOUT_MS = 240000;       // 等待上游响应头（非流式+深度思考可能很久）
const ZC_RELAY_MAX_TIMEOUT_MS = 600000;
const ZC_RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024; // 请求体上限（含 base64 图片）

// v2.2：审计 / 任务 / 审批（绑定 KV 时持久化到 KV，未绑定则退化为实例内存）
const ZC_AUDIT_PATH = '/__zc_audit__';
const ZC_TASK_PATH = '/__zc_task__';
const ZC_APPROVAL_PATH = '/__zc_approval__';
const ZC_AUDIT_MAX = 2000;               // 内存中保留的审计条目上限
const ZC_AUDIT_KV_KEY = 'zc_audit:v1';   // 审计日志 KV 键
const ZC_TASK_KV_KEY = 'zc_task:v1';     // 任务状态 KV 键
const ZC_APPROVAL_KV_KEY = 'zc_approval:v1'; // 审批与持续策略 KV 键
const ZC_APPROVE_TTL_MS = 24 * 60 * 60 * 1000; // 审批单有效期 24 小时

// v2.3：GitHub Actions 真实终端（粘贴部署即可用；官方 REST API 集成）
const ZC_GHT_PATH = '/__zc_ghterm__';
const ZC_GHT_WORKFLOW_FILE = 'zc-signal-terminal.yml';
const ZC_GHT_WORKFLOW_PATH = '.github/workflows/' + ZC_GHT_WORKFLOW_FILE;
const ZC_GHT_DEFAULT_REPO = 'zc-signal-terminal';
const ZC_GHT_STATE_KEY = 'zc_ghterm:v1';
const ZC_GHT_MAX_FILE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function zcCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

function zcJson(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' }, zcCorsHeaders(), extra || {})
  });
}

function zcSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 只允许本站页面自身调用代理 / KV，避免被第三方网站当成开放代理滥用。
// 现代浏览器几乎总会带 Sec-Fetch-Site（其次 Origin）；两者都没有时（非浏览器客户端）放行。
function zcIsSameOriginRequest(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site !== 'cross-site';
  const origin = request.headers.get('origin');
  if (origin) {
    try { return origin === new URL(request.url).origin; } catch (e) { return false; }
  }
  return true;
}

// 拒绝代理到内网 / 本机地址（SSRF 基本防护）
function zcIsBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:');
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function zcHostAllowed(hostname, env) {
  const list = String((env && env.ZC_RELAY_ALLOW) || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const h = String(hostname).toLowerCase();
  return list.some((s) => h === s || h.endsWith('.' + s.replace(/^\*?\./, '')));
}

// ---------------------------------------------------------------------------
// 1) 同源反向代理
// ---------------------------------------------------------------------------
const ZC_DROP_REQ_HEADERS = /^(x-zc-|cf-|x-forwarded-|x-real-ip|sec-|host$|content-length$|origin$|referer$|cookie$|connection$|upgrade$|te$|trailer$|transfer-encoding$|accept-encoding$|keep-alive$|proxy-)/i;

async function zcHandleRelay(request, env) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) {
    return zcJson({ error: '禁止跨站调用该代理接口', code: 'RELAY_FORBIDDEN' }, 403, { 'x-zc-relay-error': '1' });
  }

  const rawTarget = request.headers.get('x-zc-target-url');
  if (!rawTarget) return zcJson({ error: '缺少 x-zc-target-url 请求头', code: 'RELAY_BAD_REQUEST' }, 400, { 'x-zc-relay-error': '1' });

  let target;
  try {
    let decoded = rawTarget;
    try { decoded = decodeURIComponent(rawTarget); } catch (e) { /* 保持原值 */ }
    target = new URL(decoded);
  } catch (e) {
    return zcJson({ error: '目标地址不是合法的 URL', code: 'RELAY_BAD_TARGET' }, 400, { 'x-zc-relay-error': '1' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return zcJson({ error: '仅支持 http/https 目标地址', code: 'RELAY_BAD_TARGET' }, 400, { 'x-zc-relay-error': '1' });
  }
  if (zcIsBlockedHost(target.hostname)) {
    return zcJson({ error: '代理不允许访问内网或本机地址（' + target.hostname + '）。若使用本地 Ollama，请让浏览器直连并设置 OLLAMA_ORIGINS。', code: 'RELAY_BLOCKED_HOST' }, 400, { 'x-zc-relay-error': '1' });
  }
  if (!zcHostAllowed(target.hostname, env)) {
    return zcJson({ error: '该域名不在代理白名单内（ZC_RELAY_ALLOW）', code: 'RELAY_HOST_NOT_ALLOWED' }, 403, { 'x-zc-relay-error': '1' });
  }

  const method = String(request.headers.get('x-zc-target-method') || request.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const fwd = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (!ZC_DROP_REQ_HEADERS.test(k)) fwd.set(k, v);
  }

  // 缓冲请求体，便于"连接阶段失败"时安全地重试一次（请求体只是 JSON，体积有限）
  let body;
  if (hasBody) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > ZC_RELAY_MAX_BODY_BYTES) {
      return zcJson({ error: '请求体过大（超过 ' + Math.round(ZC_RELAY_MAX_BODY_BYTES / 1048576) + 'MB），请减少图片数量或压缩图片', code: 'RELAY_BODY_TOO_LARGE' }, 413, { 'x-zc-relay-error': '1' });
    }
    body = buf;
  }

  const envTimeout = parseInt((env && env.ZC_RELAY_TIMEOUT_MS) || '', 10);
  let timeoutMs = parseInt(request.headers.get('x-zc-timeout-ms') || '', 10) || envTimeout || ZC_RELAY_DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.max(10000, Math.min(ZC_RELAY_MAX_TIMEOUT_MS, timeoutMs));

  const startedAt = Date.now();
  let upstream = null;
  let lastErr = null;
  let timedOut = false;

  for (let attempt = 0; attempt < 2 && !upstream; attempt++) {
    const ctrl = new AbortController();
    timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const clientSignal = request.signal;
    const onClientAbort = () => ctrl.abort();
    if (clientSignal && typeof clientSignal.addEventListener === 'function') {
      if (clientSignal.aborted) { clearTimeout(timer); return new Response(null, { status: 499 }); }
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
    try {
      upstream = await fetch(target.toString(), { method, headers: fwd, body: hasBody ? body : undefined, redirect: 'follow', signal: ctrl.signal });
    } catch (err) {
      lastErr = err;
      if (timedOut) break;
      if (clientSignal && clientSignal.aborted) return new Response(null, { status: 499 });
      if (attempt === 0) await zcSleep(250);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!upstream) {
    if (timedOut) {
      return zcJson({ error: '上游服务在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有响应', code: 'RELAY_TIMEOUT' }, 504, { 'x-zc-relay-error': '1' });
    }
    return zcJson({ error: '代理转发失败：' + (lastErr && lastErr.message ? lastErr.message : String(lastErr)), code: 'RELAY_UPSTREAM_ERROR' }, 502, { 'x-zc-relay-error': '1' });
  }

  const h = new Headers(upstream.headers);
  // fetch 已自动解压，必须去掉这两个头；set-cookie / www-authenticate 会污染本站（后者还会弹出浏览器登录框）
  ['content-encoding', 'content-length', 'set-cookie', 'www-authenticate', 'content-security-policy', 'x-frame-options'].forEach((k) => h.delete(k));
  Object.keys(cors).forEach((k) => h.set(k, cors[k]));
  h.set('x-zc-relay', '1');
  h.set('x-zc-upstream-status', String(upstream.status));
  h.set('x-zc-upstream-ms', String(Date.now() - startedAt));
  const ct = (h.get('content-type') || '').toLowerCase();
  if (ct.indexOf('text/event-stream') >= 0 || ct.indexOf('ndjson') >= 0) {
    h.set('Cache-Control', 'no-cache, no-transform');
    h.set('X-Accel-Buffering', 'no');
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
}

// ---------------------------------------------------------------------------
// 2) 可选 KV 云同步
// ---------------------------------------------------------------------------
function zcIsValidSyncNs(ns) {
  return typeof ns === 'string' && /^[a-f0-9]{16,64}$/.test(ns);
}

async function zcHandleKV(request, env) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);

  const url = new URL(request.url);
  const sub = url.pathname.slice(ZC_KV_PATH.length).replace(/^\//, '');
  const kv = env && env.ZC_KV;

  if (!kv) {
    if (sub === 'status') return zcJson({ available: false });
    return zcJson({ error: '未绑定 KV 命名空间（变量名 ZC_KV），云同步不可用', available: false }, 501);
  }
  if (sub === 'status') return zcJson({ available: true, maxBytes: ZC_KV_MAX_BYTES });

  // 优先从请求头读取 ns（避免作为 URL 查询参数出现在服务端访问日志 / 浏览器历史 / Referer 中而被动泄露）；
  // 仍兼容旧版通过 query 传参，便于滚动发布期间新旧前端混用。
  const ns = request.headers.get('x-zc-sync-ns') || url.searchParams.get('ns') || '';
  if (!zcIsValidSyncNs(ns)) return zcJson({ error: '缺少或非法的 ns 参数' }, 400);
  const key = ZC_KV_KEY_PREFIX + ns;

  try {
    if (sub === 'get' && request.method === 'GET') {
      const val = await kv.get(key);
      return zcJson({ value: val === null ? null : val });
    }
    if (sub === 'set' && request.method === 'POST') {
      const text = await request.text();
      if (text.length > ZC_KV_MAX_BYTES) return zcJson({ error: '同步数据超出大小限制' }, 413);
      await kv.put(key, text);
      return zcJson({ ok: true, bytes: text.length });
    }
    if (sub === 'delete' && request.method === 'POST') {
      await kv.delete(key);
      return zcJson({ ok: true });
    }
    return zcJson({ error: '未知的 KV 接口: ' + sub }, 404);
  } catch (err) {
    return zcJson({ error: 'KV 操作失败: ' + (err && err.message ? err.message : String(err)) }, 500);
  }
}

// ---------------------------------------------------------------------------
// 2.4) 审计日志 / 后台任务 / 审批中心（v2.2，新增能力；均为可选 KV 持久化）
//  设计要点：
//   - 只提供「追加 + 查询」接口：普通调用方无法改写或删除历史条目（清空需显式 confirm）。
//   - 所有文本落库前先脱敏（GITHUB_TOKEN、常见 Key 形态、Authorization 头等）。
//   - 未绑定 KV 时退化为实例内存：日志可能随实例回收而丢失，前端会标注存储类型。
// ---------------------------------------------------------------------------
function zcState() {
  const g = globalThis;
  if (!g.__zcState) g.__zcState = { audit: [], tasks: [], approvals: [], policies: [] };
  return g.__zcState;
}

// ---------------------------------------------------------------------------
// v2.25：审计 / 后台任务 / 审批按登录账号隔离（owner）
//   修复：以前这三类记录存在全局 KV 键（zc_audit:v1 / zc_task:v1 / zc_approval:v1）
//   里，任何已登录用户都能读到、改写甚至清空别人的记录 —— 等于把别人的任务、
//   审计与审批详情同步给了所有人。
//   · owner 取自登录会话（zc_sess → email）；未登录 / 关闭登录（单人自用）时为 'anon'。
//   · owner 随条目一起持久化，读取 / 追加 / 删除 / 审批决定一律按 owner 过滤。
//   · 启用登录前的历史条目没有 owner 字段，一律按 'anon' 处理（登录用户不再可见）：
//     宁可看不到也无法确认归属，也不能跨账号泄露；关闭登录自用时仍可读。
//   · 持久化按 owner 分组各保留最近 N 条，别人的记录不会把自己的挤掉。
// ---------------------------------------------------------------------------
const ZC_OWNER_ANON = 'anon';
function zcOwnerSess(sess) {
  const email = sess && sess.email ? String(sess.email).trim().toLowerCase() : '';
  return email ? ('u:' + email) : ZC_OWNER_ANON;
}
// 当前请求的 owner：存储/登录未启用时退化为单一匿名空间（与旧行为一致）
async function zcRequestOwner(request, env) {
  if (!zcStoreReady(env)) return ZC_OWNER_ANON;
  try { return zcOwnerSess(await zcAuthSession(request, env)); } catch (e) { return ZC_OWNER_ANON; }
}
function zcItemOwner(x) {
  const o = x && typeof x.owner === 'string' ? x.owner.trim() : '';
  return o || ZC_OWNER_ANON;
}
function zcOwnerView(list, owner) {
  const me = owner || ZC_OWNER_ANON;
  return (Array.isArray(list) ? list : []).filter((x) => zcItemOwner(x) === me);
}
function zcTrimByOwner(list, keep) {
  const arr = Array.isArray(list) ? list : [];
  const n = Math.max(1, parseInt(keep, 10) || 1);
  const seen = new Map();
  const keepFlag = new Array(arr.length).fill(false);
  for (let i = arr.length - 1; i >= 0; i--) {
    const o = zcItemOwner(arr[i]);
    const c = seen.get(o) || 0;
    if (c < n) { keepFlag[i] = true; seen.set(o, c + 1); }
  }
  return arr.filter((x, i) => keepFlag[i]);
}

function zcMaskSecrets(text, env) {
  let s = String(text == null ? '' : text);
  try {
    const token = env && env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN) : '';
    if (token) s = s.split(token).join('***');
    const keys = [env && env.TAVILY_API_KEY, env && env.BRAVE_SEARCH_KEY, env && env.SEARCH_API_KEY];
    keys.forEach((k) => { if (k) s = s.split(String(k)).join('***'); });
  } catch (e) { /* ignore */ }
  s = s.replace(/(bearer\s+)[A-Za-z0-9._~+\/=-]{12,}/gi, '$1***');
  s = s.replace(/sk-[A-Za-z0-9_-]{12,}/g, '***');
  s = s.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***');
  s = s.replace(/((?:api[-_]?key|token|secret|password|passwd|authorization)["'\s:=]+)([A-Za-z0-9._~+\/=-]{8,})/gi, '$1***');
  return s;
}

/* ==========================================================================
 * v2.19 存储层：D1（SQLite）优先 + KV 回退 + 读时懒迁移
 *   绑定 D1（变量名 DB）后：账号 / 会话 / 审计 / 任务 / 审批 / 限流计数 / 一次性 token 全部走 SQL，
 *   不再消耗 KV 的写入额度（免费版 1000 写/天 → D1 免费 10 万行/天）。
 *   没绑定 D1（或 D1 报错）时：自动回退 KV，行为与升级前完全一致，站点不会挂。
 *   旧数据：D1 查不到就去 KV 找，命中即写回 D1（懒迁移）——旧账号用原密码照旧能登录。
 * ========================================================================== */
function zcDbReady(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }
let ZC_DB_INIT = null;
function zcDbEnsure(env) {
  if (!zcDbReady(env)) return Promise.resolve(false);
  if (!ZC_DB_INIT) {
    ZC_DB_INIT = (async function () {
      try {
        await env.DB.batch([
          env.DB.prepare('CREATE TABLE IF NOT EXISTS zc_store (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT, md TEXT, exp INTEGER, PRIMARY KEY (ns, k))'),
          env.DB.prepare('CREATE INDEX IF NOT EXISTS zc_store_exp ON zc_store (exp)')
        ]);
        return true;
      } catch (e) { ZC_DB_INIT = null; throw e; }
    })();
    ZC_DB_INIT.catch(function () { /* 首次失败静默，下次请求会重试 */ });
  }
  return ZC_DB_INIT;
}
function zcNsOf(key) {
  const k = String(key == null ? '' : key);
  if (k.indexOf(ZC_USER_PREFIX) === 0) return { ns: 'user', k: k.slice(ZC_USER_PREFIX.length) };
  if (k.indexOf(ZC_SESS_PREFIX) === 0) return { ns: 'sess', k: k.slice(ZC_SESS_PREFIX.length) };
  return { ns: 'kv', k: k };
}
function zcFullKeyOf(ns, k) {
  if (ns === 'user') return ZC_USER_PREFIX + k;
  if (ns === 'sess') return ZC_SESS_PREFIX + k;
  return k;
}
function zcStoreMode(env) { return zcDbReady(env) ? 'd1' : ((env && env.ZC_KV) ? 'kv' : 'memory'); }
function zcStoreReady(env) { return zcDbReady(env) || !!(env && env.ZC_KV); }

/* KV 兼容门面：get / put / delete / list（含 metadata 与 expirationTtl） */
function zcKV(env) {
  const kv = (env && env.ZC_KV) ? env.ZC_KV : null;
  const useDb = zcDbReady(env);
  const nowSec = function () { return Math.floor(Date.now() / 1000); };

  async function dbPut(key, value, metadata, ttl) {
    const p = zcNsOf(key);
    await zcDbEnsure(env);
    const md = metadata ? JSON.stringify(metadata) : null;
    const exp = ttl ? (nowSec() + (parseInt(ttl, 10) || 0)) : null;
    await env.DB.prepare('INSERT INTO zc_store (ns, k, v, md, exp) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, md = excluded.md, exp = excluded.exp')
      .bind(p.ns, p.k, String(value == null ? '' : value), md, exp).run();
  }
  async function dbGetRow(key) {
    const p = zcNsOf(key);
    await zcDbEnsure(env);
    const row = await env.DB.prepare('SELECT v, md, exp FROM zc_store WHERE ns = ? AND k = ?').bind(p.ns, p.k).first();
    if (!row) return null;
    if (row.exp && row.exp <= nowSec()) {
      try { await env.DB.prepare('DELETE FROM zc_store WHERE ns = ? AND k = ?').bind(p.ns, p.k).run(); } catch (e) { /* ignore */ }
      return null;
    }
    return row;
  }
  /* D1 未命中 → 去 KV 找，命中就懒迁移（连 metadata 一起搬，管理页才看得到创建时间/哈希） */
  async function kvFallback(key, type) {
    if (!kv) return type === 'json' ? null : null;
    let raw = null, md = null;
    try {
      if (typeof kv.getWithMetadata === 'function') {
        const r = await kv.getWithMetadata(key, type === 'json' ? 'json' : 'text');
        if (r) { raw = r.value; md = r.metadata; }
      } else {
        raw = type === 'json' ? await kv.get(key, 'json') : await kv.get(key);
      }
    } catch (e) { return type === 'json' ? null : null; }
    if (raw === null || raw === undefined) return null;
    try {
      let ttl = null;
      if (String(key).indexOf(ZC_SESS_PREFIX) === 0) {
        // 会话必须带着剩余有效期迁移，否则迁移后在 D1 里永不过期
        let cr = 0;
        try { cr = Number((typeof raw === 'string' ? JSON.parse(raw) : raw).createdAt) || 0; } catch (e) { cr = 0; }
        if (cr) { ttl = ZC_SESS_TTL_SEC - Math.floor((Date.now() - cr) / 1000); if (ttl <= 0) return null; }
      }
      await dbPut(key, (typeof raw === 'string') ? raw : JSON.stringify(raw), md, ttl);
    } catch (e) { /* 迁移失败不影响本次读取 */ }
    return raw;
  }

  return {
    async get(key, type) {
      if (useDb) {
        try {
          const row = await dbGetRow(key);
          if (row) {
            if (type === 'json') { try { return JSON.parse(row.v); } catch (e) { return null; } }
            return row.v;
          }
          return await kvFallback(key, type);
        } catch (e) { /* D1 故障 → 落到 KV */ }
      }
      if (!kv) return null;
      return type === 'json' ? await kv.get(key, 'json') : await kv.get(key);
    },
    async put(key, value, opts) {
      const o = opts || {};
      if (useDb) {
        try { await dbPut(key, value, o.metadata, o.expirationTtl); return; }
        catch (e) { /* D1 故障 → 落到 KV */ }
      }
      if (!kv) return;
      await kv.put(key, value, o);
    },
    async delete(key) {
      if (useDb) {
        try {
          await zcDbEnsure(env);
          const p = zcNsOf(key);
          await env.DB.prepare('DELETE FROM zc_store WHERE ns = ? AND k = ?').bind(p.ns, p.k).run();
        } catch (e) { /* ignore */ }
      }
      if (kv) { try { await kv.delete(key); } catch (e) { /* ignore */ } }
    },
    /* list：D1 结果 + KV 里「还没懒迁移」的旧键合并（仅第一页合并，避免分页错乱） */
    async list(opts) {
      const o = opts || {};
      const prefix = String(o.prefix || '');
      const limit = Math.max(1, Math.min(parseInt(o.limit, 10) || 1000, 1000));
      const cursor = o.cursor ? String(o.cursor) : '';
      const keys = [];
      let complete = true, next;
      if (useDb) {
        try {
          await zcDbEnsure(env);
          const p0 = zcNsOf(prefix);
          const like = String(p0.k).replace(/[%_]/g, '') + '%';
          const res = await env.DB.prepare('SELECT k, md, exp FROM zc_store WHERE ns = ? AND k LIKE ? AND k > ? ORDER BY k LIMIT ?')
            .bind(p0.ns, like, cursor, limit + 1).all();
          const rows = ((res && res.results) || []);
          const page = rows.slice(0, limit);
          page.forEach(function (r) {
            if (r.exp && r.exp <= nowSec()) return;
            let md; try { md = r.md ? JSON.parse(r.md) : undefined; } catch (e) { md = undefined; }
            keys.push({ name: zcFullKeyOf(p0.ns, r.k), metadata: md });
          });
          if (rows.length > limit) { complete = false; next = keys.length ? keys[keys.length - 1].name : undefined; }
        } catch (e) { complete = true; }
      }
      if (kv && !cursor) {
        try {
          const r2 = await kv.list({ prefix: prefix, limit: limit });
          const seen = {};
          keys.forEach(function (x) { seen[x.name] = 1; });
          ((r2 && r2.keys) || []).forEach(function (k) { if (!seen[k.name]) keys.push(k); });
          if (r2 && !r2.list_complete) { complete = false; if (r2.cursor) next = r2.cursor; }
        } catch (e) { /* ignore */ }
      }
      return { keys: keys, list_complete: complete, cursor: next };
    }
  };
}

async function zcKvGetJson(env, key) {
  if (!zcStoreReady(env)) return null;
  try {
    const v = await zcKV(env).get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}
async function zcKvPutJson(env, key, val) {
  if (!zcStoreReady(env)) return false;
  try { await zcKV(env).put(key, JSON.stringify(val)); return true; } catch (e) { return false; }
}
function zcNowId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function zcAuditAppend(env, entry, ctx) {
  const st = zcState();
  const item = {
    id: zcNowId('a_'),
    ts: Date.now(),
    owner: zcItemOwner(entry),
    actor: String(entry.actor || 'system'),
    taskId: entry.taskId ? String(entry.taskId) : '',
    type: String(entry.type || 'event'),
    reason: zcMaskSecrets(entry.reason || '', env),
    target: zcMaskSecrets(entry.target || '', env).slice(0, 400),
    permission: zcMaskSecrets(entry.permission || '', env).slice(0, 200),
    approval: entry.approval ? String(entry.approval) : '',
    status: String(entry.status || 'ok'),
    result: zcMaskSecrets(entry.result || '', env).slice(0, 2000),
    ms: Number(entry.ms) || 0
  };
  st.audit.push(item);
  zcSiemPushMaybe(env, ctx, { kind: 'audit', entry: item }, true);   // v2.29：SIEM 实时转发（未配置 SIEM_URL 时无操作）
  if (st.audit.length > ZC_AUDIT_MAX) st.audit.splice(0, st.audit.length - ZC_AUDIT_MAX);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(zcKvPutJson(env, ZC_AUDIT_KV_KEY, zcTrimByOwner(st.audit, 400)).catch(() => {}));
  }
  return item;
}

async function zcAuditQuery(env, q, owner) {
  q = q || {};
  let list = null;
  const kvList = await zcKvGetJson(env, ZC_AUDIT_KV_KEY);
  if (Array.isArray(kvList) && kvList.length >= zcState().audit.length) list = kvList.slice();
  else list = zcState().audit.slice();
  list = zcOwnerView(list, owner);   // v2.25：只返回调用者自己的条目
  const since = parseInt(q.since, 10) || 0;
  const until = parseInt(q.until, 10) || 0;
  const type = q.type ? String(q.type) : '';
  const status = q.status ? String(q.status) : '';
  const kw = q.kw ? String(q.kw).toLowerCase() : '';
  const taskId = q.taskId ? String(q.taskId) : '';
  const limit = Math.max(1, Math.min(500, parseInt(q.limit, 10) || 200));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  if (since) list = list.filter((x) => x.ts >= since);
  if (until) list = list.filter((x) => x.ts <= until);
  if (type) list = list.filter((x) => x.type === type);
  if (status) list = list.filter((x) => x.status === status);
  if (taskId) list = list.filter((x) => x.taskId === taskId);
  if (kw) list = list.filter((x) => (x.reason + ' ' + x.target + ' ' + x.result + ' ' + x.type + ' ' + (x.taskId || '')).toLowerCase().indexOf(kw) >= 0); 
  const total = list.length;
  list = list.slice(Math.max(0, total - offset - limit), total - offset).reverse();
  return { total: total, items: list, storage: zcStoreMode(env) };
}

async function zcHandleAudit(request, env, ctx) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const url = new URL(request.url);
  const owner = await zcRequestOwner(request, env);
  if (request.method === 'GET') {
    const q = {};
    ['since', 'until', 'type', 'status', 'kw', 'taskId', 'limit', 'offset'].forEach((k) => { q[k] = url.searchParams.get(k) || ''; });
    const r = await zcAuditQuery(env, q, owner);
    return zcJson(Object.assign({ ok: true }, r));
  }
  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
    if (body && body.action === 'clear') {
      if (body.confirm !== true) return zcJson({ error: '清空审计日志需要 confirm:true' }, 400);
      // v2.25：只清自己的条目（旧实现 st.audit = [] 会把其他登录用户的审计一并清掉）
      const st = zcState();
      const kvList = await zcKvGetJson(env, ZC_AUDIT_KV_KEY);
      const base = (Array.isArray(kvList) && kvList.length >= st.audit.length) ? kvList : st.audit;
      const removed = zcOwnerView(base, owner).length;
      st.audit = st.audit.filter((x) => zcItemOwner(x) !== owner);
      await zcKvPutJson(env, ZC_AUDIT_KV_KEY, zcTrimByOwner((Array.isArray(base) ? base : []).filter((x) => zcItemOwner(x) !== owner), 400));
      await zcAuditAppend(env, { owner: owner, actor: 'user', type: 'audit', reason: '清空审计日志', status: 'ok', result: '用户确认清空（仅本人条目，共 ' + removed + ' 条）' }, ctx);
      return zcJson({ ok: true, removed: removed });
    }
    if (!body || typeof body !== 'object') return zcJson({ error: '非法请求体' }, 400);
    // owner 放在最后覆盖：客户端无法伪造条目归属
    const item = await zcAuditAppend(env, Object.assign({ actor: 'client' }, body, { owner: owner }), ctx);
    return zcJson({ ok: true, item: item });
  }
  return zcJson({ error: 'Method Not Allowed' }, 405);
}

async function zcTaskPersist(env, ctx) {
  const st = zcState();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(zcKvPutJson(env, ZC_TASK_KV_KEY, zcTrimByOwner(st.tasks, 200)).catch(() => {}));
}
async function zcHandleTask(request, env, ctx) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const st = zcState();
  const owner = await zcRequestOwner(request, env);
  if (request.method === 'GET') {
    const kvList = await zcKvGetJson(env, ZC_TASK_KV_KEY);
    const list = (Array.isArray(kvList) && kvList.length > st.tasks.length) ? kvList : st.tasks;
    // v2.25：只返回当前登录账号自己的任务（旧实现返回全部用户的，等于把别人的任务同步给了所有人）
    return zcJson({ ok: true, items: zcOwnerView(list, owner).slice(-100).reverse() });
  }
  if (request.method !== 'POST') return zcJson({ error: 'Method Not Allowed' }, 405);
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
  const action = String(body.action || 'create');
  if (action === 'create') {
    const t = { id: zcNowId('t_'), owner: owner, title: zcMaskSecrets(body.title || '未命名任务', env).slice(0, 200), kind: String(body.kind || 'task'), status: 'running', progress: 0, note: '', cancelRequested: false, createdAt: Date.now(), updatedAt: Date.now() };
    st.tasks.push(t);
    if (st.tasks.length > 400) st.tasks.splice(0, st.tasks.length - 400);
    await zcTaskPersist(env, ctx);
    await zcAuditAppend(env, { owner: owner, actor: 'client', taskId: t.id, type: 'task', reason: '创建任务：' + t.title, target: t.kind, status: 'running' }, ctx);
    return zcJson({ ok: true, task: t });
  }
  const id = String(body.id || '');
  let t = zcOwnerView(st.tasks, owner).filter((x) => x.id === id)[0];
  if (!t) {
    const kv = await zcKvGetJson(env, ZC_TASK_KV_KEY);
    const found = zcOwnerView(kv, owner).filter((x) => x.id === id)[0];
    if (found) { st.tasks.push(found); t = found; }
  }
  if (!t) {
    // v2.25：更新 / 取消不属于自己的任务 → 一律 404（不暴露存在性），并记下越权尝试
    await zcAuditAppend(env, { owner: owner, actor: 'user', type: 'task', reason: '操作任务被拒绝：任务不存在或不属于当前账号', target: String(action) + ' ' + id.slice(0, 60), status: 'denied' }, ctx);
    return zcJson({ error: '找不到任务 ' + id }, 404);
  }
  if (action === 'update') {
    ['status', 'note'].forEach((k) => { if (body[k] != null) t[k] = zcMaskSecrets(String(body[k]), env).slice(0, 400); });
    if (body.progress != null) t.progress = Math.max(0, Math.min(100, parseInt(body.progress, 10) || 0));
    t.updatedAt = Date.now();
    await zcTaskPersist(env, ctx);
    return zcJson({ ok: true, task: t });
  }
  if (action === 'cancel') {
    t.cancelRequested = true;
    t.note = '取消请求已记录（实际中断取决于具体执行通道）';
    t.updatedAt = Date.now();
    await zcTaskPersist(env, ctx);
    await zcAuditAppend(env, { owner: owner, actor: 'user', taskId: t.id, type: 'task', reason: '请求取消任务：' + t.title, status: 'cancelling' }, ctx);
    return zcJson({ ok: true, task: t });
  }
  return zcJson({ error: '未知任务操作：' + action }, 400);
}

async function zcApprovalPersist(env, ctx) {
  const st = zcState();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(zcKvPutJson(env, ZC_APPROVAL_KV_KEY, { approvals: zcTrimByOwner(st.approvals, 300), policies: zcTrimByOwner(st.policies, 100) }).catch(() => {}));
}
// 合并后的全量（含所有账号）——仅供服务端内部校验 / 写回使用，绝不直接回给客户端
async function zcApprovalsAll(env) {
  const st = zcState();
  const kv = await zcKvGetJson(env, ZC_APPROVAL_KV_KEY);
  const approvals = (kv && Array.isArray(kv.approvals) && kv.approvals.length > st.approvals.length) ? kv.approvals : st.approvals;
  const policies = (kv && Array.isArray(kv.policies) && kv.policies.length > st.policies.length) ? kv.policies : st.policies;
  return { approvals: approvals, policies: policies };
}
// v2.25：按 owner 过滤后的视图 —— 接口响应与审批闸门只看得到自己的审批单 / 策略
async function zcApprovalsMerged(env, owner) {
  const all = await zcApprovalsAll(env);
  return { approvals: zcOwnerView(all.approvals, owner), policies: zcOwnerView(all.policies, owner) };
}
async function zcHandleApproval(request, env, ctx) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const st = zcState();
  const owner = await zcRequestOwner(request, env);
  if (request.method === 'GET') {
    const merged = await zcApprovalsMerged(env, owner);
    const now = Date.now();
    return zcJson({ ok: true, pending: merged.approvals.filter((a) => a.decision === 'pending' && now - a.ts < ZC_APPROVE_TTL_MS).slice(-50).reverse(), recent: merged.approvals.slice(-50).reverse(), policies: merged.policies.slice(-50).reverse() });
  }
  if (request.method !== 'POST') return zcJson({ error: 'Method Not Allowed' }, 405);
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
  const action = String(body.action || 'create');
  if (action === 'create') {
    const a = {
      id: zcNowId('p_'), ts: Date.now(), owner: owner,
      kind: String(body.kind || 'op').slice(0, 60),
      title: zcMaskSecrets(body.title || '需要审批的操作', env).slice(0, 300),
      detail: zcMaskSecrets(body.detail || '', env).slice(0, 4000),
      risk: String(body.risk || 'normal'), taskId: body.taskId ? String(body.taskId) : '',
      scope: 'once', decision: 'pending', decidedAt: 0, note: '', used: false, usedAt: 0
    };
    st.approvals.push(a);
    if (st.approvals.length > 600) st.approvals.splice(0, st.approvals.length - 600);
    await zcApprovalPersist(env, ctx);
    await zcAuditAppend(env, { owner: owner, actor: 'agent', taskId: a.taskId, type: 'approval', reason: '申请审批：' + a.title, target: a.kind, permission: a.risk, approval: a.id, status: 'pending' }, ctx);
    return zcJson({ ok: true, approval: a });
  }
  if (action === 'decide') {
    const id = String(body.id || '');
    let a = zcOwnerView(st.approvals, owner).filter((x) => x.id === id)[0];
    if (!a) {
      const kv = await zcKvGetJson(env, ZC_APPROVAL_KV_KEY);
      const found = zcOwnerView((kv && kv.approvals) || [], owner).filter((x) => x.id === id)[0];
      if (found) { st.approvals.push(found); a = found; }
    }
    if (!a) {
      // v2.25：处理不属于自己的审批单 → 404 + 审计（防止用别人的批准单 / 替别人放行）
      await zcAuditAppend(env, { owner: owner, actor: 'user', type: 'approval', reason: '审批决定被拒绝：审批单不存在或不属于当前账号', target: id.slice(0, 60), status: 'denied' }, ctx);
      return zcJson({ error: '找不到审批单' }, 404);
    }
    if (a.decision !== 'pending') return zcJson({ error: '该审批单已被处理', approval: a }, 409);
    const decision = String(body.decision || '');
    if (decision !== 'approve' && decision !== 'deny') return zcJson({ error: 'decision 必须是 approve 或 deny' }, 400);
    const scope = ['once', 'task', 'persist'].indexOf(String(body.scope || 'once')) >= 0 ? String(body.scope || 'once') : 'once';
    a.decision = decision; a.scope = scope; a.decidedAt = Date.now(); a.note = zcMaskSecrets(body.note || '', env).slice(0, 300);
    if (decision === 'approve' && scope === 'persist') {
      st.policies.push({ id: zcNowId('g_'), owner: zcItemOwner(a), kind: a.kind, title: a.title, ts: Date.now(), by: 'user' });
      if (st.policies.length > 200) st.policies.splice(0, st.policies.length - 200);
    }
    await zcApprovalPersist(env, ctx);
    await zcAuditAppend(env, { owner: owner, actor: 'user', taskId: a.taskId, type: 'approval', reason: '审批决定：' + (decision === 'approve' ? '批准' : '拒绝') + '（范围 ' + scope + '）', target: a.title, permission: a.risk, approval: a.id, status: decision === 'approve' ? 'approved' : 'denied' }, ctx);
    return zcJson({ ok: true, approval: a });
  }
  if (action === 'revokePolicy') {
    const id = String(body.id || '');
    const before = st.policies.length;
    st.policies = st.policies.filter((x) => !(x.id === id && zcItemOwner(x) === owner));   // v2.25：只能撤销自己的策略
    await zcApprovalPersist(env, ctx);
    if (before !== st.policies.length) await zcAuditAppend(env, { owner: owner, actor: 'user', type: 'approval', reason: '撤销持续授权 ' + id, status: 'ok' }, ctx);
    return zcJson({ ok: true, removed: before - st.policies.length });
  }
  return zcJson({ error: '未知审批操作：' + action }, 400);
}

async function zcApprovalValid(env, approvalId, opts) {
  // v2.25：只认当前账号自己的审批单（防止拿别人的批准单解锁沙箱 / 终端）
  const merged = await zcApprovalsMerged(env, (opts && opts.owner) || ZC_OWNER_ANON);
  const a = merged.approvals.filter((x) => x.id === approvalId)[0];
  if (!a || a.decision !== 'approve') return { ok: false, reason: '审批单不存在或未批准' };
  if (Date.now() - a.ts > ZC_APPROVE_TTL_MS) return { ok: false, reason: '审批单已过期' };
  if (opts && opts.kind && a.kind && opts.kind !== a.kind) return { ok: false, reason: '审批单种类不匹配' };
  if (a.scope === 'task' && opts && opts.taskId && a.taskId && opts.taskId !== a.taskId) return { ok: false, reason: '审批单不适用于该任务' };
  if (a.scope === 'once') { a.used = true; a.usedAt = Date.now(); }
  return { ok: true, approval: a };
}
async function zcApprovalConsumeLatest(env, kind, owner) {
  const me = owner || ZC_OWNER_ANON;
  const all = await zcApprovalsAll(env);
  const now = Date.now();
  const cands = zcOwnerView(all.approvals, me).slice().reverse().filter((x) => x.decision === 'approve' && x.kind === kind && (now - x.ts) < ZC_APPROVE_TTL_MS);
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i];
    if (a.scope === 'persist') return { ok: true, approval: a };
    if (a.scope === 'task' && a.taskId) return { ok: true, approval: a };
    if (a.scope === 'once' && !a.used) {
      a.used = true; a.usedAt = now;
      // 写回时保留其他账号的条目（旧实现写回过滤后的列表，会把别人的审批单抹掉）
      await zcKvPutJson(env, ZC_APPROVAL_KV_KEY, { approvals: zcTrimByOwner(all.approvals, 300), policies: zcTrimByOwner(all.policies, 100) });
      return { ok: true, approval: a };
    }
  }
  return { ok: false, reason: '没有可用（未使用且未过期）的匹配审批单' };
}

// 云端沙箱 HTTP 层审批闸门（仅在 ZC_REQUIRE_APPROVALS=1 时启用；不改变沙箱内部实现）
async function zcGateSandbox(request, env) {
  if (String((env && env.ZC_REQUIRE_APPROVALS) || '') !== '1') return null;
  const url = new URL(request.url);
  const sub = url.pathname.slice(ZC_SBX_PATH.length).replace(/^\//, '');
  const GUARDED = { exec: 1, write: 1, delete: 1, mkdir: 1, download: 1 };
  if (!GUARDED[sub]) return null;
  const owner = await zcRequestOwner(request, env);
  const approvalId = request.headers.get('x-zc-approval') || '';
  let v = null;
  if (approvalId) v = await zcApprovalValid(env, approvalId, { kind: 'sandbox:' + sub, owner: owner });
  else v = await zcApprovalConsumeLatest(env, 'sandbox:' + sub, owner);
  if (v && v.ok) return null;
  await zcAuditAppend(env, { owner: owner, actor: 'system', type: 'approval', reason: '沙箱请求被阻断：需要审批', target: 'sandbox:' + sub, status: 'pending', result: (v && v.reason) || '缺少审批单' });
  return zcJson({ error: '该操作需要审批：请在「审计与权限」中批准后重试（或携带请求头 x-zc-approval）', needApproval: true, code: 'SBX_APPROVAL_REQUIRED', detail: (v && v.reason) || '' }, 428);
}

// ---------------------------------------------------------------------------
// 2.6) GitHub Actions 真实终端（v2.3；经 GitHub 官方 REST API 集成，已核对官方文档）
//   事实与边界（绝不夸大）：
//   - 在 GitHub 官方托管的 Ubuntu Runner 上执行真实命令（bash/python/node/npm/git，有公网）。
//   - 费用（docs.github.com/en/billing）：标准 Runner 在公开仓库免费；私有仓库消耗账户套餐
//     免费分钟，超出部分取决于账户支出限额（默认 $0 时超额会暂停，不会自动扣费）。
//   - 需要一次性配置 GITHUB_TOKEN；初始化时创建/复用私有仓库并写入工作流；
//     每次 run = 一次 workflow_dispatch；工作流结束自动提交工作区改动（GitHub 即持久化工作区）。
//   - 未配置/未初始化时接口如实返回状态，绝不假装可用。
// ---------------------------------------------------------------------------
const ZC_GHT_WORKFLOW_YML = [
  'name: zc-signal-terminal',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      command:',
  "        description: 'command'",
  '        required: true',
  '        type: string',
  '      cwd:',
  "        description: 'cwd'",
  '        required: false',
  "        default: '.'",
  '        type: string',
  '      timeout:',
  "        description: 'timeout-minutes'",
  '        required: false',
  "        default: '10'",
  '        type: string',
  'permissions:',
  '  contents: write',
  'jobs:',
  '  run:',
  '    runs-on: ubuntu-latest',
  "    timeout-minutes: ${{ fromJSON(github.event.inputs.timeout || '10') }}",
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: Cache deps (npm / pip)',
  '        uses: actions/cache@v4',
  '        with:',
  '          path: |',
  '            ~/.npm',
  '            ~/.cache/pip',
  "          key: zc-deps-${{ runner.os }}-${{ hashFiles('**/package-lock.json', '**/package.json', '**/requirements.txt') }}",
  '          restore-keys: |',
  '            zc-deps-${{ runner.os }}-',
  '      - name: Run',
  '        shell: bash',
  '        env:',
  '          ZC_CMD: ${{ github.event.inputs.command }}',
  '          ZC_CWD: ${{ github.event.inputs.cwd }}',
  '        run: |',
  '          set -uo pipefail',
  '          echo "ZC-SENTINEL-START"',
  '          cd "${ZC_CWD:-.}" 2>/dev/null || cd .',
  '          bash -lc "$ZC_CMD"',
  '          ec=$?',
  '          echo "ZC-EXIT:$ec"',
  '          echo "ZC-SENTINEL-END"',
  '          exit 0',
  '      - name: Persist workspace',
  '        if: always()',
  '        shell: bash',
  '        run: |',
  '          git config user.name "zc-signal-bot"',
  '          git config user.email "zc-signal-bot@users.noreply.github.com"',
  '          [ -f .gitignore ] || printf "node_modules/\\n__pycache__/\\n*.pyc\\n.venv/\\nvenv/\\n.cache/\\n" > .gitignore',
  '          git add -A',
  '          git rm -r --cached -q --ignore-unmatch node_modules __pycache__ .venv venv .cache 2>/dev/null || true',
  '          git commit -m "zc-signal: run ${{ github.run_id }}" || true',
  '          git push || true'
].join('\n') + '\n';

function zcGhtState() {
  const st = zcState();
  if (!st.ghterm) st.ghterm = { owner: '', repo: '', branch: 'main' };
  return st.ghterm;
}
/* v2.19.1：GitHub 终端状态持久化 —— 纯内存态在 Workers 上不可靠（每个请求可能落在不同
 * isolate），初始化结果必须落到存储（D1 优先 / KV 回退），否则下一请求读到空状态，
 * 前端表现为「刚初始化完又断开 / 一直要求重新初始化」。 */
async function zcGhtLoad(env) {
  const st = zcGhtState();
  try {
    if (!st.owner || !st.repo) {
      const j = await zcKV(env).get(ZC_GHT_STATE_KEY, 'json');
      if (j && typeof j === 'object') {
        if (!st.owner && j.owner) st.owner = String(j.owner);
        if (!st.repo && j.repo) st.repo = String(j.repo);
        if (j.branch) st.branch = String(j.branch);
      }
    }
  } catch (e) { /* 存储不可用时保持内存态，不影响本次请求 */ }
  const repoSel = String((env && env.GH_TERM_REPO) || '').trim();
  if (repoSel) st.repo = repoSel;
  return st;
}
async function zcGhtSave(env) {
  const st = zcGhtState();
  if (!st.owner && !st.repo) return;
  try { await zcKV(env).put(ZC_GHT_STATE_KEY, JSON.stringify({ owner: st.owner || '', repo: st.repo || '', branch: st.branch || 'main' })); } catch (e) { /* ignore */ }
}
function zcGhHeaders(env, extra) {
  const h = Object.assign({
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'zc-signal-ghterm/2.3'
  }, extra || {});
  const t = env && env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN) : '';
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}
// v2.21.3：瞬时错误（网络抖动 / 502 503 504 / 429 / 次级限流 403）自动退避重试，最多 4 次；
// 读 Retry-After，单次等待上限 6 秒（总时长仍在前端各接口的超时之内）
function zcGhRetryWait(r, attempt) {
  let w = 0;
  try { w = parseInt(r && r.headers && r.headers.get('retry-after') || '0', 10) || 0; } catch (e) { w = 0; }
  if (w > 0) return Math.min(w * 1000, 6000);
  return Math.min(900 * Math.pow(2, attempt), 6000);
}
async function zcGhApi(env, method, path, body, opts) {
  opts = opts || {};
  const maxTry = opts.noRetry ? 1 : 4;
  const init = { method: method, headers: zcGhHeaders(env, opts.headers), redirect: opts.redirect || 'follow' };
  if (body !== undefined && body !== null) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let r = null;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    try { r = await fetch('https://api.github.com' + path, init); }
    catch (e) {
      if (attempt < maxTry - 1) { await zcSleep(Math.min(700 * Math.pow(2, attempt), 5000)); continue; }
      throw new Error('无法连接 GitHub API：' + (e && e.message ? e.message : String(e)));
    }
    if (attempt < maxTry - 1) {
      let retry = (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 429);
      if (!retry && r.status === 403) {
        let t403 = '';
        try { t403 = await r.clone().text(); } catch (e) { t403 = ''; }
        retry = /secondary rate limit|abuse detection|rate limit|retry/i.test(t403) && !/bad credentials|requires authentication|resource not accessible/i.test(t403);
      }
      if (retry) {
        const wait = zcGhRetryWait(r, attempt);
        try { await r.arrayBuffer(); } catch (e) { /* ignore */ }
        await zcSleep(wait);
        continue;
      }
    }
    break;
  }
  if (opts && opts.binary) {
    const buf = await r.arrayBuffer();
    return { status: r.status, ok: r.ok, buf: buf };
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* ignore */ }
  return { status: r.status, ok: r.ok, json: json, text: text };
}
function zcB64Encode(s) {
  const bytes = new TextEncoder().encode(String(s == null ? '' : s));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function zcB64Decode(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
function zcBufB64(buf) {
  const u8 = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(bin);
}
function zcGhSanitize(p) {
  let s = String(p == null ? '' : p).trim();
  if (s.indexOf('\\') >= 0) throw new Error('路径不允许包含反斜杠');
  if (/[\x00-\x1f]/.test(s)) throw new Error('路径包含非法字符');
  while (s.charAt(0) === '/') s = s.slice(1);
  const parts = s.split('/').filter((x) => x && x !== '.');
  parts.forEach((seg) => { if (seg === '..') throw new Error('路径不允许包含 ..（不能越权访问仓库之外）'); });
  return parts.join('/');
}
function zcGhEnc(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}
async function zcGhResolve(env) {
  const st = zcGhtState();
  let owner = st.owner;
  if (!owner) {
    const me = await zcGhApi(env, 'GET', '/user');
    if (me.status === 401) throw new Error('GITHUB_TOKEN 无效或未配置（HTTP 401），请在 Worker Secrets 中配置');
    if (!me.ok) throw new Error('获取 GitHub 账户失败：HTTP ' + me.status);
    owner = me.json && me.json.login ? String(me.json.login) : '';
    if (!owner) throw new Error('无法识别 GitHub 账户');
    st.owner = owner;
  }
  const repoSel = String((env && env.GH_TERM_REPO) || '').trim();
  const repo = repoSel || (owner + '/' + ZC_GHT_DEFAULT_REPO);
  st.repo = repo;
  return { owner: owner, repo: repo, branch: st.branch || 'main' };
}
// v2.21.3：终端状态自动接管 —— 状态只存在内存 / KV 里，Worker 换 isolate 或没绑 KV 时会“失忆”，
// 前端表现为 GitHub 终端无故掉线。这里改为：有 Token 就直接去 GitHub 核对终端仓库与工作流是否存在，存在则自动恢复为就绪。
async function zcGhAutoAttach(env) {
  const st = zcGhtState();
  if (st.owner && st.repo) return true;
  if (st._noAttachAt && Date.now() - st._noAttachAt < 30000) return false;
  try {
    const info = await zcGhResolve(env);
    const rr = await zcGhApi(env, 'GET', '/repos/' + info.repo);
    if (!rr.ok) throw new Error('repo-missing');
    const br = rr.json && rr.json.default_branch ? String(rr.json.default_branch) : 'main';
    const wf = await zcGhApi(env, 'GET', '/repos/' + info.repo + '/actions/workflows/' + ZC_GHT_WORKFLOW_FILE);
    if (wf.status !== 200) throw new Error('workflow-missing');
    st.branch = br;
    st._noAttachAt = 0;
    await zcGhtSave(env);
    return true;
  } catch (e) {
    st.owner = ''; st.repo = ''; st._noAttachAt = Date.now();
    return false;
  }
}
async function zcGhInit(env, ctx, auditOwner) {
  const info = await zcGhResolve(env);
  const st = zcGhtState();
  let repoRes = await zcGhApi(env, 'GET', '/repos/' + info.repo);
  if (repoRes.status === 404) {
    const hasSel = !!String((env && env.GH_TERM_REPO) || '').trim();
    if (hasSel) throw new Error('GH_TERM_REPO 指定的仓库不存在或无权访问：' + info.repo);
    const created = await zcGhApi(env, 'POST', '/user/repos', { name: info.repo.split('/')[1], private: true, auto_init: true, description: 'ZC-SIGNAL terminal workspace (auto-created by Worker)' });
    if (created.status !== 201 && created.status !== 200) throw new Error('创建仓库失败：HTTP ' + created.status + ' ' + String((created.json && created.json.message) || ''));
  }
  let branch = 'main';
  for (let i = 0; i < 8; i++) {
    const repoInfo = await zcGhApi(env, 'GET', '/repos/' + info.repo);
    if (!repoInfo.ok) throw new Error('读取仓库信息失败：HTTP ' + repoInfo.status + ' ' + String((repoInfo.json && repoInfo.json.message) || ''));
    if (repoInfo.json && repoInfo.json.default_branch) { branch = String(repoInfo.json.default_branch); break; }
    await zcSleep(2000);
  }
  st.branch = branch;
  await zcGhtSave(env);
  await zcGhApi(env, 'PUT', '/repos/' + info.repo + '/actions/permissions/workflow', { default_workflow_permissions: 'write' });
  const wfApi = '/repos/' + info.repo + '/contents/' + ZC_GHT_WORKFLOW_PATH;
  const cur = await zcGhApi(env, 'GET', wfApi + '?ref=' + branch);
  let sha = '';
  let curText = '';
  if (cur.status === 200 && cur.json && cur.json.content) {
    sha = cur.json.sha || '';
    try { curText = zcB64Decode(cur.json.content); } catch (e) { curText = ''; }
  }
  if (curText !== ZC_GHT_WORKFLOW_YML) {
    const put = await zcGhApi(env, 'PUT', wfApi, { message: 'zc-signal: init terminal workflow', content: zcB64Encode(ZC_GHT_WORKFLOW_YML), sha: sha || undefined, branch: branch });
    if (put.status !== 200 && put.status !== 201) throw new Error('写入工作流文件失败：HTTP ' + put.status + ' ' + String((put.json && put.json.message) || ''));
  }
  let wfVisible = false;
  for (let i = 0; i < 8 && !wfVisible; i++) {
    const wf = await zcGhApi(env, 'GET', '/repos/' + info.repo + '/actions/workflows/' + ZC_GHT_WORKFLOW_FILE);
    if (wf.status === 200) { wfVisible = true; break; }
    await zcSleep(2500);
  }
  await zcAuditAppend(env, { owner: auditOwner, actor: 'user', type: 'ghterm', reason: '初始化 GitHub 终端仓库', target: info.repo, status: 'ok', result: '分支 ' + branch + '；工作流' + (wfVisible ? '已就绪' : '等待 GitHub 索引（稍后自动可用）') }, ctx);
  return { owner: info.owner, repo: info.repo, branch: branch, workflowVisible: wfVisible };
}
async function zcGhRun(env, body, ctx, auditOwner) {
  const st = zcGhtState();
  if (!st.owner || !st.repo) throw new Error('GitHub 终端尚未初始化');
  const command = String(body.command || '');
  if (!command.trim()) throw new Error('缺少 command');
  const cwd = String(body.cwd || '.').slice(0, 300) || '.';
  let minutes = 10;
  const t = Number(body.timeout) || 0;
  if (t > 1000) minutes = Math.ceil(t / 60000);
  else if (t > 0) minutes = Math.ceil(t / 60);
  minutes = Math.max(1, Math.min(30, minutes));
  // v2.21.3：先记下“触发前最新一次运行”的 ID，触发后只认 ID 更大的运行 —— 旧实现直接取列表第一条，
  // 新运行尚未出现时会把上一次命令的结果当成本次结果返回
  let baseId = 0;
  try {
    const b0 = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/actions/workflows/' + ZC_GHT_WORKFLOW_FILE + '/runs?event=workflow_dispatch&per_page=1');
    const a0 = (b0.json && b0.json.workflow_runs) || [];
    if (a0.length) baseId = Number(a0[0].id) || 0;
  } catch (e) { baseId = 0; }
  let disp = null;
  for (let k = 0; k < 4; k++) {
    disp = await zcGhApi(env, 'POST', '/repos/' + st.repo + '/actions/workflows/' + ZC_GHT_WORKFLOW_FILE + '/dispatches', {
      ref: st.branch || 'main',
      inputs: { command: command.slice(0, 20000), cwd: cwd, timeout: String(minutes) },
      return_run_details: true
    });
    // 刚初始化的工作流 GitHub 还没索引完时会返回 404 / 422，稍等重试
    if ((disp.status === 404 || disp.status === 422) && k < 3) { await zcSleep(3000); continue; }
    break;
  }
  let runId = 0;
  if ((disp.status === 200 || disp.status === 201) && disp.json && disp.json.workflow_run_id) runId = Number(disp.json.workflow_run_id) || 0;
  if (!runId) {
    if (!(disp.status === 200 || disp.status === 201 || disp.status === 204)) {
      throw new Error('触发工作流失败：HTTP ' + disp.status + ' ' + String((disp.json && disp.json.message) || disp.text || '').slice(0, 200));
    }
    for (let i = 0; i < 10 && !runId; i++) {
      if (i > 0) await zcSleep(2000);
      const runs = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/actions/workflows/' + ZC_GHT_WORKFLOW_FILE + '/runs?event=workflow_dispatch&per_page=10');
      const arr = ((runs.json && runs.json.workflow_runs) || []).filter(function (x) { return Number(x.id) > baseId; });
      arr.sort(function (a, b) { return Number(a.id) - Number(b.id); });
      if (arr.length) runId = Number(arr[0].id) || 0;
    }
  }
  if (!runId) throw new Error('已触发运行，但未获取到运行 ID：请在仓库 Actions 页面查看');
  await zcAuditAppend(env, { owner: auditOwner, actor: 'agent', type: 'ghterm', reason: '触发 GitHub 终端运行', target: st.repo, status: 'running', result: 'run ' + runId }, ctx);
  return { runId: runId, runUrl: 'https://github.com/' + st.repo + '/actions/runs/' + runId };
}
async function zcGhRunStatus(env, runId) {
  const st = zcGhtState();
  const run = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/actions/runs/' + runId);
  if (!run.ok) throw new Error('查询运行状态失败：HTTP ' + run.status);
  const j = run.json || {};
  const out = { runId: Number(runId), status: j.status || '', conclusion: j.conclusion || '', runUrl: j.html_url || '', createdAt: j.created_at || '', updatedAt: j.updated_at || '' };
  if (j.status === 'completed') {
    const jobs = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/actions/runs/' + runId + '/jobs');
    const arr = (jobs.json && jobs.json.jobs) || [];
    const job = arr[0] || null;
    out.log = '';
    if (job && job.id) {
      out.jobId = job.id;
      try {
        const lr = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/actions/jobs/' + job.id + '/logs');
        if (lr.ok) {
          let text = lr.text || '';
          let exitCode = null;
          const m = /ZC-EXIT:(\d+)/.exec(text);
          if (m) exitCode = parseInt(m[1], 10);
          const a = text.indexOf('ZC-SENTINEL-START');
          const b = text.indexOf('ZC-SENTINEL-END');
          if (a >= 0 && b > a) text = text.slice(a + 'ZC-SENTINEL-START'.length, b);
          else {
            const lines = text.split('\n');
            text = lines.slice(Math.max(0, lines.length - 150)).join('\n') + '\n（仅显示日志尾部）';
          }
          text = text.replace(/\u001b\[[0-9;]*m/g, '');
          if (text.length > 60000) text = text.slice(0, 60000) + '\n…（输出过长，已截断）';
          out.log = text.trim();
          out.exitCode = exitCode == null ? (job.conclusion === 'success' ? 0 : 1) : exitCode;
        } else {
          out.log = '（无法获取日志：HTTP ' + lr.status + '）';
          out.exitCode = job.conclusion === 'success' ? 0 : 1;
        }
      } catch (e) {
        out.log = '（获取日志失败：' + (e && e.message ? e.message : String(e)) + '）';
        out.exitCode = job.conclusion === 'success' ? 0 : 1;
      }
    } else {
      out.log = '（未找到运行作业）';
    }
  }
  return out;
}
async function zcGhFileOp(env, action, body) {
  const st = zcGhtState();
  if (!st.owner || !st.repo) throw new Error('GitHub 终端尚未初始化');
  const branch = st.branch || 'main';
  const rel = zcGhSanitize(String(body.path || ''));
  const enc = rel ? zcGhEnc(rel) : '';
  const base = '/repos/' + st.repo + '/contents/';
  if (action === 'list') {
    const r = await zcGhApi(env, 'GET', (rel ? base + enc : '/repos/' + st.repo + '/contents') + '?ref=' + branch);
    if (r.status === 404) return { entries: [] };
    if (!r.ok) throw new Error('读取目录失败：HTTP ' + r.status);
    const arr = Array.isArray(r.json) ? r.json : [];
    return { entries: arr.map((e) => ({ name: e.name, path: e.path, kind: e.type === 'dir' ? 'dir' : 'file', size: e.size || 0 })) };
  }
  if (action === 'read') {
    const r = await zcGhApi(env, 'GET', base + enc + '?ref=' + branch, undefined, { headers: { 'Accept': 'application/vnd.github.raw+json' } });
    if (r.status === 404) throw new Error('文件不存在：' + rel);
    if (!r.ok) throw new Error('读取文件失败：HTTP ' + r.status);
    const text = r.text || '';
    const truncated = text.length > 220000;
    return { text: truncated ? text.slice(0, 220000) : text, binary: false, size: text.length, truncated: truncated };
  }
  if (action === 'create' || action === 'write') {
    const content = String(body.content == null ? '' : body.content);
    if (content.length > ZC_GHT_MAX_FILE_BYTES) throw new Error('文件过大（>1MB）：请用 run_command 处理大文件');
    let sha = '';
    const cur = await zcGhApi(env, 'GET', base + enc + '?ref=' + branch);
    if (cur.status === 200 && cur.json && cur.json.sha) sha = cur.json.sha;
    if (action === 'create' && sha) throw new Error('文件已存在：' + rel);
    const put = await zcGhApi(env, 'PUT', base + enc, { message: 'zc-signal: ' + (sha ? 'update ' : 'add ') + rel, content: zcB64Encode(content), sha: sha || undefined, branch: branch });
    if (put.status !== 200 && put.status !== 201) throw new Error('写入失败：HTTP ' + put.status + ' ' + String((put.json && put.json.message) || ''));
    return { path: rel, size: content.length };
  }
  if (action === 'delete') {
    const cur = await zcGhApi(env, 'GET', base + enc + '?ref=' + branch);
    if (cur.status !== 200 || !cur.json || !cur.json.sha) throw new Error('文件不存在：' + rel);
    const del = await zcGhApi(env, 'DELETE', base + enc, { message: 'zc-signal: delete ' + rel, sha: cur.json.sha, branch: branch });
    if (del.status !== 200) throw new Error('删除失败：HTTP ' + del.status + ' ' + String((del.json && del.json.message) || ''));
    return { path: rel };
  }
  if (action === 'mkdir') {
    const keep = (rel ? rel + '/' : '') + '.gitkeep';
    const put = await zcGhApi(env, 'PUT', base + zcGhEnc(keep), { message: 'zc-signal: mkdir ' + rel, content: zcB64Encode(''), branch: branch });
    if (put.status !== 200 && put.status !== 201) throw new Error('创建目录失败：HTTP ' + put.status + ' ' + String((put.json && put.json.message) || ''));
    return { path: rel };
  }
  if (action === 'tree') {
    const r = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/git/trees/' + branch + '?recursive=1');
    if (!r.ok) throw new Error('读取文件树失败：HTTP ' + r.status);
    const arr = (r.json && r.json.tree) || [];
    return { entries: arr.filter((e) => e.type === 'blob' || e.type === 'tree').map((e) => ({ path: e.path, kind: e.type === 'tree' ? 'dir' : 'file', size: e.size || 0 })) };
  }
  throw new Error('未知文件操作：' + action);
}
async function zcGateGhTerm(env, request, kind) {
  if (String((env && env.ZC_REQUIRE_APPROVALS) || '') !== '1') return null;
  const owner = await zcRequestOwner(request, env);
  const approvalId = request.headers.get('x-zc-approval') || '';
  const v = approvalId ? await zcApprovalValid(env, approvalId, { kind: 'ghterm:' + kind, owner: owner }) : await zcApprovalConsumeLatest(env, 'ghterm:' + kind, owner);
  if (v && v.ok) return null;
  await zcAuditAppend(env, { owner: owner, actor: 'system', type: 'approval', reason: 'GitHub 终端请求被阻断：需要审批', target: 'ghterm:' + kind, status: 'pending', result: (v && v.reason) || '缺少审批单' });
  return zcJson({ error: '该操作需要审批：请在「审计与权限」中批准后重试（或携带请求头 x-zc-approval）', needApproval: true, code: 'GHT_APPROVAL_REQUIRED', detail: (v && v.reason) || '' }, 428);
}
// Git blob SHA-1（"blob <字节数>\0<内容>"），用于在不额外请求的情况下得到每个文件的 sha（前端据此判断云端是否有变更）
async function zcGitBlobSha(text) {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode('blob ' + body.length + '\0');
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0); all.set(body, head.length);
  const dig = await crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(dig)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
async function zcGhSyncPush(env, body, ctx, auditOwner) {
  const st = zcGhtState();
  if (!st.owner || !st.repo) throw new Error('GitHub 终端尚未初始化');
  const branch = st.branch || 'main';
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new Error('没有要同步的文件');
  if (files.length > 500) throw new Error('一次最多同步 500 个文件');
  let total = 0;
  files.forEach((f) => { total += String(f && f.content != null ? f.content : '').length; });
  if (total > 50 * 1024 * 1024) throw new Error('本次同步内容过大（>50MB），请分批');
  // v2.21.3：文本文件直接作为 tree 条目的 content 内联提交（GitHub 在服务端生成 blob），
  // 整个推送只需约 5 次 GitHub 请求，与文件个数无关 —— 旧实现每个文件 1 次 blob 请求，
  // 文件一多就会撞上 Workers 单次请求的子请求上限（免费版 50）与 GitHub 的次级限流，表现为“同步失败 / GitHub 连接失败”。
  // 单个 >300KB 的大文件仍走 blob 接口（避开 tree 请求体过大），最多 30 个。
  const prepared = [];
  const seen = {};
  for (let i = 0; i < files.length; i++) {
    const raw = files[i] || {};
    const pth = zcGhSanitize(String(raw.path || ''));
    if (!pth || seen[pth]) continue;
    seen[pth] = 1;
    prepared.push({ path: pth, content: String(raw.content == null ? '' : raw.content) });
  }
  if (!prepared.length) throw new Error('没有有效文件');
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/git/ref/heads/' + branch);
    if (!ref.ok) throw new Error('读取分支失败：HTTP ' + ref.status);
    const headSha = ref.json && ref.json.object ? ref.json.object.sha : '';
    if (!headSha) throw new Error('无法读取分支 HEAD');
    const commit = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/git/commits/' + headSha);
    if (!commit.ok) throw new Error('读取提交失败：HTTP ' + commit.status);
    const baseTree = commit.json && commit.json.tree ? commit.json.tree.sha : '';
    const tree = [];
    const results = [];
    let bigBlobs = 0;
    for (let i = 0; i < prepared.length; i++) {
      const f = prepared[i];
      const sha = await zcGitBlobSha(f.content);
      if (f.content.length > 300000 && bigBlobs < 30) {
        bigBlobs++;
        const b = await zcGhApi(env, 'POST', '/repos/' + st.repo + '/git/blobs', { content: zcB64Encode(f.content), encoding: 'base64' });
        if (!(b.status === 201 || b.status === 200) || !b.json || !b.json.sha) throw new Error('生成 blob 失败（' + f.path + '）：HTTP ' + b.status + ' ' + String((b.json && b.json.message) || ''));
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.json.sha });
        results.push({ path: f.path, sha: b.json.sha, size: f.content.length });
      } else {
        tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
        results.push({ path: f.path, sha: sha, size: f.content.length });
      }
    }
    const t = await zcGhApi(env, 'POST', '/repos/' + st.repo + '/git/trees', { base_tree: baseTree, tree: tree });
    if (!(t.status === 201 || t.status === 200) || !t.json || !t.json.sha) throw new Error('创建 tree 失败：HTTP ' + t.status + ' ' + String((t.json && t.json.message) || ''));
    const msg = String(body.message || ('zc-signal: sync ' + results.length + ' files')).slice(0, 200);
    const c = await zcGhApi(env, 'POST', '/repos/' + st.repo + '/git/commits', { message: msg, tree: t.json.sha, parents: [headSha] });
    if (!(c.status === 201 || c.status === 200) || !c.json || !c.json.sha) throw new Error('创建提交失败：HTTP ' + c.status + ' ' + String((c.json && c.json.message) || ''));
    const up = await zcGhApi(env, 'PATCH', '/repos/' + st.repo + '/git/refs/heads/' + branch, { sha: c.json.sha, force: false });
    if (up.status === 200) {
      await zcAuditAppend(env, { owner: auditOwner, actor: 'user', type: 'sync', reason: '本地目录同步到 GitHub 终端仓库', target: st.repo + '@' + branch, status: 'ok', result: results.length + ' 个文件；提交 ' + c.json.sha.slice(0, 8) + (attempt ? '（第 ' + (attempt + 1) + ' 次尝试）' : '') }, ctx);
      return { ok: true, commit: c.json.sha, branch: branch, files: results };
    }
    // 工作流刚好在这一刻往同一分支推了提交（Persist workspace 步骤）→ 非快进（422/409）：重新读取 HEAD 再来一次
    lastErr = 'HTTP ' + up.status + ' ' + String((up.json && up.json.message) || '');
    if (up.status !== 422 && up.status !== 409) break;
    await zcSleep(1200 * (attempt + 1));
  }
  throw new Error('更新分支失败：' + lastErr + '（已重试；若仓库里有正在运行的工作流，请等它结束后再同步）');
}
async function zcGhSyncPull(env, body) {
  const st = zcGhtState();
  if (!st.owner || !st.repo) throw new Error('GitHub 终端尚未初始化');
  const branch = st.branch || 'main';
  const r = await zcGhApi(env, 'GET', '/repos/' + st.repo + '/git/trees/' + branch + '?recursive=1');
  if (!r.ok) throw new Error('读取文件树失败：HTTP ' + r.status);
  const arr = (r.json && r.json.tree) || [];
  const entries = arr.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
  return { ok: true, branch: branch, entries: entries };
}
async function zcGhSyncPullFiles(env, body) {
  const st = zcGhtState();
  if (!st.owner || !st.repo) throw new Error('GitHub 终端尚未初始化');
  const branch = st.branch || 'main';
  const want = Array.isArray(body.files) ? body.files.slice(0, 45) : [];   // v2.21.3：300 → 45（每个文件 1 次 GitHub 请求，须在子请求上限内；前端按 40 个一批）
  const binary = !!body.binary;
  const MAX_ONE = 30 * 1024 * 1024;
  const MAX_ALL = 40 * 1024 * 1024;
  let total = 0;
  const out = [];
  for (let i = 0; i < want.length; i++) {
    const p = zcGhSanitize(String(want[i] || ''));
    if (!p) continue;
    const url = '/repos/' + st.repo + '/contents/' + zcGhEnc(p) + '?ref=' + branch;
    if (binary) {
      const rr = await zcGhApi(env, 'GET', url, undefined, { headers: { 'Accept': 'application/vnd.github.raw+json' }, binary: true });
      if (!rr.ok) { out.push({ path: p, error: 'HTTP ' + rr.status }); continue; }
      const size = rr.buf ? rr.buf.byteLength : 0;
      if (size > MAX_ONE) { out.push({ path: p, error: '单文件超过 30MB' }); continue; }
      if (total + size > MAX_ALL) { out.push({ path: p, error: '超出本批 40MB 限制' }); continue; }
      total += size;
      out.push({ path: p, size: size, b64: zcBufB64(rr.buf) });
    } else {
      const rr = await zcGhApi(env, 'GET', url, undefined, { headers: { 'Accept': 'application/vnd.github.raw+json' } });
      if (!rr.ok) { out.push({ path: p, error: 'HTTP ' + rr.status }); continue; }
      const text = rr.text || '';
      if (total + text.length > 40 * 1024 * 1024) { out.push({ path: p, error: '超出本批 40MB 限制' }); continue; }
      total += text.length;
      out.push({ path: p, content: text, size: text.length });
    }
  }
  return { ok: true, files: out };
}

async function zcHandleGhTerm(request, env, ctx) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const url = new URL(request.url);
  const sub = url.pathname.slice(ZC_GHT_PATH.length).replace(/^\//, '');
  const owner = await zcRequestOwner(request, env);   // v2.25：终端相关审计归属到当前登录账号
  const token = !!(env && env.GITHUB_TOKEN);
  await zcGhtLoad(env);
  try {
    if (token && sub !== 'init') {
      const __s0 = zcGhtState();
      if (!(__s0.owner && __s0.repo)) { try { await zcGhAutoAttach(env); } catch (e) { /* 接管失败 → 走原有“待初始化”提示 */ } }
    }
    if (sub === 'status') {
      const st = zcGhtState();
      let ready = !!(token && st.owner && st.repo);
      let note = '';
      if (!token) note = '未配置 GITHUB_TOKEN（Worker Secrets，一次性）';
      else if (!st.owner) note = 'Token 已配置，尚未初始化终端仓库';
      return zcJson({ ok: true, token: token, ready: ready, repo: st.repo || '', branch: st.branch || 'main', note: note, customRepo: String((env && env.GH_TERM_REPO) || '') });
    }
    if (sub === 'init' && request.method === 'POST') {
      if (!token) return zcJson({ error: '未配置 GITHUB_TOKEN：请在 Cloudflare Worker 的 Secrets 中添加后重试', needToken: true }, 501);
      const r = await zcGhInit(env, ctx, owner);
      return zcJson(Object.assign({ ok: true }, r));
    }
    if (sub === 'run' && request.method === 'POST') {
      if (!token) return zcJson({ error: '未配置 GITHUB_TOKEN', needToken: true }, 501);
      const gate = await zcGateGhTerm(env, request, 'run');
      if (gate) return gate;
      let body = null;
      try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
      const r = await zcGhRun(env, body, ctx, owner);
      return zcJson(Object.assign({ ok: true }, r));
    }
    if (sub === 'run' && request.method === 'GET') {
      if (!token) return zcJson({ error: '未配置 GITHUB_TOKEN', needToken: true }, 501);
      const id = url.searchParams.get('id') || '';
      if (!id) return zcJson({ error: '缺少 id 参数' }, 400);
      const r = await zcGhRunStatus(env, id);
      return zcJson(Object.assign({ ok: true }, r));
    }
    if (sub === 'file' && request.method === 'POST') {
      if (!token) return zcJson({ error: '未配置 GITHUB_TOKEN', needToken: true }, 501);
      let body = null;
      try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
      const action = String(body.action || '');
      if (action === 'write' || action === 'create' || action === 'delete' || action === 'mkdir') {
        const gate = await zcGateGhTerm(env, request, action === 'delete' ? 'delete' : 'write');
        if (gate) return gate;
      }
      const r = await zcGhFileOp(env, action, body);
      return zcJson(Object.assign({ ok: true }, r));
    }
    if (sub === 'sync' && request.method === 'POST') {
      if (!token) return zcJson({ error: '未配置 GITHUB_TOKEN', needToken: true }, 501);
      let body = null;
      try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
      const act = String(body.action || '');
      if (act === 'push') {
        const gate = await zcGateGhTerm(env, request, 'write');
        if (gate) return gate;
        return zcJson(await zcGhSyncPush(env, body, ctx, owner));
      }
      if (act === 'pull') return zcJson(await zcGhSyncPull(env, body));
      if (act === 'pull-files') return zcJson(await zcGhSyncPullFiles(env, body));
      return zcJson({ error: '未知同步操作：' + act }, 400);
    }
    return zcJson({ error: '未知的 GitHub 终端接口: ' + sub }, 404);
  } catch (e) {
    return zcJson({ error: (e && e.message ? e.message : String(e)) }, 500);
  }
}

// ---------------------------------------------------------------------------
// 账号体系：GitHub OAuth 登录 / 邀请码注册 / 管理员查看用户（QQ 邮箱验证码流程已于 v2.16 下线）
// ---------------------------------------------------------------------------
// 依赖：KV 命名空间（变量名 ZC_KV，与云同步共用同一个即可）。
//
// 必填环境变量（Workers → 设置 → 变量和机密，授权码请添加为「机密」）：
//   ZC_SMTP_USER      发信用的 QQ 邮箱完整地址，如 12345678@qq.com
//   ZC_SMTP_PASS      该 QQ 邮箱的 SMTP「授权码」（不是 QQ 密码；
//                     QQ 邮箱网页版 → 设置 → 账号 → 开启 POP3/SMTP 服务后获取）
//   ZC_ADMIN_TOKEN    管理员口令（越长越随机越好），用于打开 /__zc_admin__ 查看用户
// 可选：
//   ZC_AUTH_EMAIL_DOMAINS  允许注册的邮箱域名，逗号分隔，默认 qq.com；填 * 表示不限制
//   ZC_SMTP_HOST / ZC_SMTP_PORT  默认 smtp.qq.com / 465（仅支持 465 隐式 TLS）
//   ZC_SMTP_FROM_NAME      邮件中显示的发件人名称，默认 ZC-GURA
//   ZC_AUTH_DISABLED       设为 1 可临时关闭登录验证（本地调试用）
//
// 接口：/__zc_auth__/(status|send-code|register|login|me|logout|admin/users)
//      v2.13 新增：github/start（跳 GitHub 授权）、github/callback（收 code 换令牌并签发会话）、
//                  github/handoff（前端用一次性票据换回令牌）、register-invite（邀请码注册）
// 密码只保存 PBKDF2-SHA256 加盐哈希（不可逆）；管理页 /__zc_admin__ 展示邮箱、密码哈希、注册/登录时间。
// 启用后，/__zc_relay__ 与 /__zc_kv__ 也必须携带有效登录会话（请求头 x-zc-session）。
// ---------------------------------------------------------------------------
const ZC_AUTH_PATH = '/__zc_auth__';
const ZC_ADMIN_PATH = '/__zc_admin__';
const ZC_USER_PREFIX = 'zc_user:';
const ZC_CODE_PREFIX = 'zc_code:';
const ZC_SESS_PREFIX = 'zc_sess:';
const ZC_LOGINFAIL_PREFIX = 'zc_lf:';
const ZC_ADMINFAIL_PREFIX = 'zc_af:';
const ZC_CODE_TTL_SEC = 600;                 // 验证码有效期：10 分钟
const ZC_CODE_COOLDOWN_MS = 60 * 1000;       // 同一邮箱两次发送的最小间隔
const ZC_CODE_MAX_TRIES = 5;                 // 单个验证码最多可试错次数
const ZC_SESS_TTL_SEC = 30 * 24 * 3600;      // 登录会话有效期：30 天
const ZC_PBKDF2_ITER = 100000;               // Workers 的 PBKDF2 迭代次数上限即为 100000
const ZC_PASS_MIN = 8;
const ZC_PASS_MAX = 128;
const ZC_LOGIN_MAX_FAILS = 8;                // 连续输错 8 次锁定 15 分钟

// ---- GitHub OAuth + 邀请码（v2.13.0） ----
const ZC_GH_STATE_PREFIX = 'zc_ghst:';       // 一次性 state 票据（防 CSRF）
const ZC_GH_HANDOFF_PREFIX = 'zc_ghho:';     // 回跳握手票据（会话交给前端，避免令牌进地址栏历史）
const ZC_GH_STATE_TTL_SEC = 600;             // state 有效期 10 分钟
const ZC_GH_HANDOFF_TTL_SEC = 300;           // 握手票据有效期 5 分钟
const ZC_GH_SCOPE = 'read:user';             // 只读用户资料，不申请仓库等任何权限
const ZC_IR_PREFIX = 'zc_ir:';                 // 邀请码试错计数键前缀（按 IP 限流）
const ZC_IR_MAX_FAILS = 10;                  // 邀请码试错上限（按 IP，锁 15 分钟）
const ZC_INVITE_DOMAIN = 'invite.local';     // 邀请码账号在用户表里的内部占位域名（不用于发信）
// 兜底常量：环境变量优先；不想在面板配置时可把值直接填这里
const ZC_AUTH_BUILTIN = { GITHUB_OAUTH_CLIENT_ID: '', GITHUB_OAUTH_CLIENT_SECRET: '', GITHUB_OAUTH_REDIRECT_URI: '', ZC_AUTH_GH_LOGINS: '', ZC_AUTH_INVITE_CODES: '', TURNSTILE_SITE_KEY: '' };

function zcAuthVar(env, name, fallback) {
  const v = env && env[name];
  if (v != null && String(v).trim()) return String(v).trim();
  const b = ZC_AUTH_BUILTIN[name];
  if (b != null && String(b).trim()) return String(b).trim();
  return fallback == null ? '' : fallback;
}

function zcGhClientId(env) { return zcAuthVar(env, 'GITHUB_OAUTH_CLIENT_ID'); }
function zcGhClientSecret(env) { return zcAuthVar(env, 'GITHUB_OAUTH_CLIENT_SECRET'); }
function zcGhOAuthReady(env) { return !!(zcGhClientId(env) && zcGhClientSecret(env)); }

// 白名单：ZC_AUTH_GH_LOGINS 逗号分隔；留空表示不限制（任何 GitHub 账号都能登录）
function zcGhAllowedLogins(env) {
  return zcAuthVar(env, 'ZC_AUTH_GH_LOGINS').split(',').map(function (x) { return x.trim().toLowerCase().replace(/^@/, ''); }).filter(Boolean);
}

// 回调地址必须与 GitHub OAuth App 里登记的完全一致
function zcGhRedirectUri(request, env) {
  const fixed = zcAuthVar(env, 'GITHUB_OAUTH_REDIRECT_URI');
  if (fixed) return fixed.replace(/\/+$/, '') + ZC_AUTH_PATH + '/github/callback';
  return new URL(request.url).origin + ZC_AUTH_PATH + '/github/callback';
}

function zcAuthInviteCodes(env) {
  return zcAuthVar(env, 'ZC_AUTH_INVITE_CODES').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

function zcGhUserName(login) { return String(login == null ? '' : login).trim().toLowerCase().replace(/[^a-z0-9-]/g, ''); }
function zcInviteEmail(name) { return name + '@' + ZC_INVITE_DOMAIN; }

function zcAuthEnabled(env) {
  const v = String((env && env.ZC_AUTH_DISABLED) || '').trim().toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes' || v === 'on');
}

function zcAuthDomains(env) {
  return String((env && env.ZC_AUTH_EMAIL_DOMAINS) || 'qq.com').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

function zcAuthNormEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function zcAuthEmailValid(email) {
  return email.length <= 254 && /^[a-z0-9._%+\-]{1,64}@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/.test(email);
}

function zcAuthEmailAllowed(email, env) {
  const list = zcAuthDomains(env);
  if (list.indexOf('*') >= 0) return true;
  return list.indexOf(email.slice(email.lastIndexOf('@') + 1)) >= 0;
}

function zcMailReady(env) {
  return !!(env && env.ZC_SMTP_USER && env.ZC_SMTP_PASS);
}

function zcHexOf(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function zcHexToBytes(hex) {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function zcRandHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return zcHexOf(a);
}

async function zcSha256Hex(str) {
  return zcHexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))));
}

async function zcPbkdf2Hex(password, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: zcHexToBytes(saltHex), iterations: iter }, key, 256);
  return zcHexOf(new Uint8Array(bits));
}

function zcSafeEqual(a, b) {
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}

function zcB64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function zcAuthBody(request) {
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

// ---- Cloudflare Turnstile 人机验证（v2.24） ----
// 变量：TURNSTILE_SITE_KEY（站点密钥，公开，可填在这里的 ZC_AUTH_BUILTIN 或环境变量）
//       TURNSTILE_SECRET_KEY（私密密钥，只能放「机密 Secret」，不要写进代码/仓库）
// 两个都配置才启用；任何一个缺失 → 视为未启用，登录行为与旧版完全一致（不会把站点锁死）。
// 启用后：站内账号登录、邀请码注册、GitHub 登录入口都必须先通过验证；服务端验证失败或验证服务不可达一律拒绝（fail closed）。
const ZC_TS_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
function zcTsSiteKey(env) { return zcAuthVar(env, 'TURNSTILE_SITE_KEY'); }
function zcTsSecret(env) { return String((env && env.TURNSTILE_SECRET_KEY) || '').trim(); }
function zcTsEnabled(env) { return !!(zcTsSiteKey(env) && zcTsSecret(env)); }

async function zcTsVerify(env, token, ip) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t || t.length > 2048) return { ok: false, codes: ['missing-input-response'] };
  try {
    const fd = new FormData();
    fd.append('secret', zcTsSecret(env));
    fd.append('response', t);
    if (ip) fd.append('remoteip', ip);
    const r = await fetch(ZC_TS_VERIFY_URL, { method: 'POST', body: fd });
    const d = await r.json();
    return { ok: !!(d && d.success), codes: (d && d['error-codes']) || [] };
  } catch (e) {
    return { ok: false, net: true, codes: ['internal-error'] };
  }
}

// 通过返回 null；未通过返回应直接回给前端的 Response
async function zcTsGate(request, env, token) {
  if (!zcTsEnabled(env)) return null;
  const r = await zcTsVerify(env, token, request.headers.get('cf-connecting-ip') || '');
  if (r.ok) return null;
  if (r.net) return zcJson({ error: '人机验证服务暂时不可用，请稍后重试', code: 'TURNSTILE_UNAVAILABLE' }, 503);
  const expired = r.codes.indexOf('timeout-or-duplicate') >= 0;
  return zcJson({ error: expired ? '人机验证已过期，请重新验证后再试' : '人机验证未通过，请重试', code: 'TURNSTILE_FAILED' }, 403);
}

// ---- 登录会话 ----
const zcSessCache = new Map(); // isolate 内短时缓存，减少 KV 读取（退出登录后最多延迟 30 秒在其他 isolate 失效）

async function zcAuthSession(request, env) {
  const token = String(request.headers.get('x-zc-session') || '');
  if (!/^[a-f0-9]{64}$/.test(token) || !zcStoreReady(env)) return null;
  const key = ZC_SESS_PREFIX + (await zcSha256Hex(token));
  const now = Date.now();
  const c = zcSessCache.get(key);
  if (c && c.exp > now) return c.val;
  const raw = await zcKV(env).get(key);
  if (!raw) { zcSessCache.delete(key); return null; }
  let val = null;
  try { val = JSON.parse(raw); } catch (e) { return null; }
  val = await zcSessTouch(env, key, val, now);
  if (zcSessCache.size > 500) zcSessCache.clear();
  zcSessCache.set(key, { val, exp: now + 30000 });
  return val;
}

// 活跃心跳：已登录用户直接带会话访问（不再走登录流程）时，最多每 10 分钟记一次「最近活跃」。
// 会话有效期不变（不续期），只更新 seenAt 与用户的 lastActiveAt。
const ZC_TOUCH_MS = 10 * 60 * 1000;
async function zcSessTouch(env, key, val, now) {
  const last = Number(val.seenAt || val.createdAt) || 0;
  if (now - last < ZC_TOUCH_MS) return val;
  val.seenAt = now;
  try {
    const cr = Number(val.createdAt) || now;
    const ttl = Math.max(60, ZC_SESS_TTL_SEC - Math.floor((now - cr) / 1000));
    await zcKV(env).put(key, JSON.stringify(val), { expirationTtl: ttl, metadata: { e: val.email || '', p: val.provider || 'email' } });
    if (val.email) await zcUserTouch(env, val.email, now);
  } catch (e) { /* 心跳失败不影响正常访问 */ }
  return val;
}
async function zcUserTouch(env, email, now) {
  if (zcDbReady(env)) {
    await zcDbEnsure(env);
    const sql = "UPDATE zc_store SET v = json_set(v, '$.lastActiveAt', ?), md = json_set(COALESCE(md, '{}'), '$.a', ?) WHERE ns = 'user' AND k = ?";
    let r = await env.DB.prepare(sql).bind(now, now, email).run();
    if (r && r.meta && r.meta.changes === 0) {
      // 旧用户可能还只在 KV 里：读一次触发懒迁移，再更新一次
      await zcKV(env).get(ZC_USER_PREFIX + email);
      await env.DB.prepare(sql).bind(now, now, email).run();
    }
    return;
  }
  const kv = zcKV(env);
  const raw = await kv.get(ZC_USER_PREFIX + email);
  if (!raw) return;
  let u = null;
  try { u = JSON.parse(raw); } catch (e) { return; }
  u.lastActiveAt = now;
  await kv.put(ZC_USER_PREFIX + email, JSON.stringify(u), { metadata: { c: u.createdAt, l: u.lastLoginAt || 0, a: now, h: u.hash || '', gh: u.ghLogin || '', iv: u.provider === 'invite' ? 1 : 0 } });
}
// 新建会话 / 用户记录时，同步镜像一份到 KV（仅登录时触发，量很小；D1 模式下门面默认只写 D1）
async function zcKvMirror(env, key, value, opts) {
  try { if (env && env.ZC_KV && zcDbReady(env)) await env.ZC_KV.put(key, value, opts); } catch (e) { /* 镜像失败不影响登录 */ }
}

// 保护全部受控接口（relay / kv / run / web / ghterm / audit / task / approval / sandbox）：
// 登录验证启用且已绑定 KV 时，未登录一律拒绝（返回 Response 表示拦截，null 表示放行）。
async function zcAuthGuard(request, env) {
  if (!zcAuthEnabled(env) || request.method === 'OPTIONS') return null;
  const extra = { 'x-zc-auth': 'required' };
  if (new URL(request.url).pathname === ZC_RELAY_PATH) extra['x-zc-relay-error'] = '1';
  if (!zcStoreReady(env)) {
    // 未绑定 KV / D1 时没有任何已注册用户，也无法校验会话；此时按“未配置”放行，避免把站点锁死。
    // 绑定 KV 后本守卫立即生效；如需彻底关闭可设置 ZC_AUTH_DISABLED=1。
    return null;
  }
  if (await zcAuthSession(request, env)) return null;
  return zcJson({ error: '未登录或登录已过期，请重新登录', code: 'AUTH_REQUIRED' }, 401, extra);
}

// 受登录保护的全部接口前缀（绑定 KV 后生效）
function zcAuthGuardedPath(path) {
  const list = [ZC_RELAY_PATH, ZC_KV_PATH, ZC_RUN_PATH, ZC_WEB_PATH, ZC_GHT_PATH, ZC_AUDIT_PATH, ZC_TASK_PATH, ZC_APPROVAL_PATH, ZC_SBX_PATH];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (path === p || path.indexOf(p + '/') === 0) return p;
  }
  return '';
}

// ---- QQ 邮箱 SMTP（465 端口隐式 TLS，AUTH LOGIN） ----
function zcSmtpBuildMessage(fromName, fromAddr, to, subject, text, html) {
  const boundary = 'zc_' + zcRandHex(12);
  const wrap = (s) => zcB64Utf8(s).replace(/(.{76})/g, '$1\r\n');
  const head = [
    'From: =?UTF-8?B?' + zcB64Utf8(fromName) + '?= <' + fromAddr + '>',
    'To: <' + to + '>',
    'Subject: =?UTF-8?B?' + zcB64Utf8(subject) + '?=',
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + zcRandHex(12) + '@' + (fromAddr.split('@')[1] || 'localhost') + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  ].join('\r\n');
  const parts = [
    '--' + boundary, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(text),
    '--' + boundary, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(html),
    '--' + boundary + '--', ''
  ].join('\r\n');
  return head + '\r\n\r\n' + parts;
}

async function zcSmtpSend(env, to, subject, text, html) {
  const user = String(env.ZC_SMTP_USER).trim();
  const pass = String(env.ZC_SMTP_PASS).replace(/\s+/g, '');
  const host = String(env.ZC_SMTP_HOST || 'smtp.qq.com').trim();
  const port = parseInt(env.ZC_SMTP_PORT || '465', 10) || 465;
  const fromName = String(env.ZC_SMTP_FROM_NAME || 'ZC-GURA');
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const socket = await zcPagesConnect({ hostname: host, port });
  if (socket.closed && socket.closed.catch) socket.closed.catch(() => {});
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const deadline = Date.now() + 25000;
  let buf = '';

  const withTimeout = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('与邮件服务器通信超时')), Math.max(1, deadline - Date.now()));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  // 读取一条完整的 SMTP 响应（兼容 250-xxx 多行格式）
  const readResp = async () => {
    const lines = [];
    for (;;) {
      let idx;
      while ((idx = buf.indexOf('\r\n')) < 0) {
        const r = await withTimeout(reader.read());
        if (r.done) throw new Error('邮件服务器提前关闭了连接');
        buf += dec.decode(r.value, { stream: true });
      }
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) return { code: parseInt(line.slice(0, 3), 10), text: lines.join(' | ') };
    }
  };
  const write = (s) => withTimeout(writer.write(enc.encode(s)));
  const cmd = async (line, okCodes, hide) => {
    await write(line + '\r\n');
    const r = await readResp();
    if (okCodes.indexOf(r.code) < 0) {
      const e = new Error('SMTP ' + r.code + '：' + r.text);
      e.smtpCode = r.code;
      e.smtpCmd = hide ? '' : line;
      throw e;
    }
    return r;
  };

  try {
    const hello = await readResp();
    if (hello.code !== 220) throw new Error('邮件服务器拒绝连接：' + hello.text);
    await cmd('EHLO zc-gura', [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(zcB64Utf8(user), [334], true);
    try {
      await cmd(zcB64Utf8(pass), [235], true);
    } catch (e) {
      if (e && e.smtpCode) throw new Error('QQ 邮箱登录失败：请确认 ZC_SMTP_USER 是完整的 QQ 邮箱地址、ZC_SMTP_PASS 是 SMTP 授权码（不是 QQ 密码），并已在 QQ 邮箱设置中开启 SMTP 服务');
      throw e;
    }
    await cmd('MAIL FROM:<' + user + '>', [250]);
    await cmd('RCPT TO:<' + to + '>', [250, 251]);
    await cmd('DATA', [354]);
    await write(zcSmtpBuildMessage(fromName, user, to, subject, text, html) + '.\r\n');
    const done = await readResp();
    if (done.code !== 250) throw new Error('SMTP ' + done.code + '：' + done.text);
    try { await cmd('QUIT', [221]); } catch (e) { /* 忽略 */ }
  } finally {
    try { reader.releaseLock(); } catch (e) { /* ignore */ }
    try { writer.releaseLock(); } catch (e) { /* ignore */ }
    try { await socket.close(); } catch (e) { /* ignore */ }
  }
}

function zcAuthMailContent(code) {
  const mins = Math.round(ZC_CODE_TTL_SEC / 60);
  const subject = '【ZC-GURA】注册验证码：' + code;
  const text = '您正在注册 ZC-GURA，验证码：' + code + '（' + mins + ' 分钟内有效）。\n如非本人操作，请忽略本邮件。';
  const html = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">'
    + '<h2 style="margin:0 0 12px;font-size:18px">ZC-GURA 注册验证码</h2>'
    + '<p style="margin:0 0 16px;color:#55555e">您正在注册 ZC-GURA，请在页面中输入下方验证码：</p>'
    + '<div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:14px 0;text-align:center;background:#f7f7f8;border-radius:10px">' + code + '</div>'
    + '<p style="margin:16px 0 0;color:#8b8b95;font-size:13px">验证码 ' + mins + ' 分钟内有效。如非本人操作，请忽略本邮件。</p>'
    + '</div>';
  return { subject, text, html };
}

// ---- 接口实现 ----
async function zcAuthSendCode(request, env) {
  const kv = zcKV(env);
  const body = await zcAuthBody(request);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  const email = zcAuthNormEmail(body.email);
  if (!zcAuthEmailValid(email)) return zcJson({ error: '邮箱格式不正确' }, 400);
  if (!zcAuthEmailAllowed(email, env)) {
    return zcJson({ error: '仅支持 ' + zcAuthDomains(env).map((d) => '@' + d).join('、') + ' 邮箱注册' }, 400);
  }
  if (!zcMailReady(env)) {
    return zcJson({ error: '服务端尚未配置发信邮箱（ZC_SMTP_USER / ZC_SMTP_PASS）', code: 'MAIL_NOT_CONFIGURED' }, 501);
  }
  if (await kv.get(ZC_USER_PREFIX + email)) return zcJson({ error: '该邮箱已注册，请直接登录', code: 'EMAIL_EXISTS' }, 409);

  const now = Date.now();
  const prevRaw = await kv.get(ZC_CODE_PREFIX + email);
  if (prevRaw) {
    let prev = null;
    try { prev = JSON.parse(prevRaw); } catch (e) { prev = null; }
    if (prev && prev.sentAt && now - prev.sentAt < ZC_CODE_COOLDOWN_MS) {
      const wait = Math.ceil((ZC_CODE_COOLDOWN_MS - (now - prev.sentAt)) / 1000);
      return zcJson({ error: '发送过于频繁，请 ' + wait + ' 秒后再试', retryAfter: wait }, 429, { 'Retry-After': String(wait) });
    }
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const salt = zcRandHex(8);
  const rec = { h: await zcSha256Hex(salt + ':' + email + ':' + code), salt, sentAt: now, exp: now + ZC_CODE_TTL_SEC * 1000, tries: 0 };
  await kv.put(ZC_CODE_PREFIX + email, JSON.stringify(rec), { expirationTtl: ZC_CODE_TTL_SEC });
  try {
    const m = zcAuthMailContent(code);
    await zcSmtpSend(env, email, m.subject, m.text, m.html);
  } catch (err) {
    try { await kv.delete(ZC_CODE_PREFIX + email); } catch (e) { /* ignore */ }
    return zcJson({ error: '验证码邮件发送失败：' + (err && err.message ? err.message : String(err)), code: 'MAIL_SEND_FAILED' }, 502);
  }
  return zcJson({ ok: true, cooldown: Math.round(ZC_CODE_COOLDOWN_MS / 1000), ttl: ZC_CODE_TTL_SEC });
}

async function zcAuthRegister(request, env) {
  const kv = env.ZC_KV;
  const body = await zcAuthBody(request);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  const email = zcAuthNormEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const code = String(body.code == null ? '' : body.code).trim();
  if (!zcAuthEmailValid(email)) return zcJson({ error: '邮箱格式不正确' }, 400);
  if (!zcAuthEmailAllowed(email, env)) {
    return zcJson({ error: '仅支持 ' + zcAuthDomains(env).map((d) => '@' + d).join('、') + ' 邮箱注册' }, 400);
  }
  if (password.length < ZC_PASS_MIN) return zcJson({ error: '密码至少 ' + ZC_PASS_MIN + ' 位' }, 400);
  if (password.length > ZC_PASS_MAX) return zcJson({ error: '密码不能超过 ' + ZC_PASS_MAX + ' 位' }, 400);
  if (!/^\d{6}$/.test(code)) return zcJson({ error: '请输入 6 位邮箱验证码' }, 400);
  if (await kv.get(ZC_USER_PREFIX + email)) return zcJson({ error: '该邮箱已注册，请直接登录', code: 'EMAIL_EXISTS' }, 409);

  const now = Date.now();
  const raw = await kv.get(ZC_CODE_PREFIX + email);
  let rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
  if (!rec || rec.exp <= now) return zcJson({ error: '验证码不存在或已过期，请重新获取', code: 'CODE_EXPIRED' }, 400);
  if (rec.tries >= ZC_CODE_MAX_TRIES) return zcJson({ error: '验证码错误次数过多，请重新获取', code: 'CODE_LOCKED' }, 429);

  const h = await zcSha256Hex(rec.salt + ':' + email + ':' + code);
  if (!zcSafeEqual(h, rec.h)) {
    rec.tries += 1;
    await kv.put(ZC_CODE_PREFIX + email, JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil((rec.exp - now) / 1000)) });
    const left = ZC_CODE_MAX_TRIES - rec.tries;
    return zcJson({ error: left > 0 ? '验证码错误，还可尝试 ' + left + ' 次' : '验证码错误次数过多，请重新获取', code: 'CODE_WRONG' }, 400);
  }

  const salt = zcRandHex(16);
  const hash = await zcPbkdf2Hex(password, salt, ZC_PBKDF2_ITER);
  const user = { email, salt, hash, iter: ZC_PBKDF2_ITER, createdAt: now, lastLoginAt: 0 };
  // metadata 冗余保存摘要信息，管理页用一次 list 即可列出全部用户（避免逐个 get 触发子请求上限）
  await kv.put(ZC_USER_PREFIX + email, JSON.stringify(user), { metadata: { c: now, l: 0, h: hash } });
  await kv.delete(ZC_CODE_PREFIX + email);
  return zcJson({ ok: true, email });
}

async function zcAuthLogin(request, env) {
  const kv = zcKV(env);
  const body = await zcAuthBody(request);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  const tsDeny = await zcTsGate(request, env, body.cf_turnstile);
  if (tsDeny) return tsDeny;
  let email = zcAuthNormEmail(body.email);
  if (email && email.indexOf('@') < 0) email = zcInviteEmail(email);   // 邀请码账号：允许只填账号名
  const password = typeof body.password === 'string' ? body.password : '';
  if (!zcAuthEmailValid(email) || !password || password.length > ZC_PASS_MAX) return zcJson({ error: '邮箱或密码错误' }, 401);

  const lfKey = ZC_LOGINFAIL_PREFIX + email;
  const fails = parseInt((await kv.get(lfKey)) || '0', 10) || 0;
  if (fails >= ZC_LOGIN_MAX_FAILS) return zcJson({ error: '尝试次数过多，请 15 分钟后再试', code: 'LOGIN_LOCKED' }, 429);

  const raw = await kv.get(ZC_USER_PREFIX + email);
  let user = null;
  try { user = raw ? JSON.parse(raw) : null; } catch (e) { user = null; }
  // 用户不存在时也做一次等价的哈希运算，避免通过响应时间探测邮箱是否注册
  const hash = await zcPbkdf2Hex(password, user ? user.salt : '00000000000000000000000000000000', user ? (user.iter || ZC_PBKDF2_ITER) : ZC_PBKDF2_ITER);
  if (!user || !zcSafeEqual(hash, user.hash)) {
    await kv.put(lfKey, String(fails + 1), { expirationTtl: 900 });
    return zcJson({ error: '邮箱或密码错误' }, 401);
  }
  if (fails) { try { await kv.delete(lfKey); } catch (e) { /* ignore */ } }

  const token = zcRandHex(32);
  const now = Date.now();
  const sessKey = ZC_SESS_PREFIX + (await zcSha256Hex(token));
  const sessVal = JSON.stringify({ email, createdAt: now, seenAt: now });
  const sessOpts = { expirationTtl: ZC_SESS_TTL_SEC, metadata: { e: email, p: user.provider || 'email' } };
  await kv.put(sessKey, sessVal, sessOpts);
  await zcKvMirror(env, sessKey, sessVal, sessOpts);
  user.lastLoginAt = now;
  user.lastActiveAt = now;
  const userVal = JSON.stringify(user);
  const userOpts = { metadata: { c: user.createdAt, l: now, a: now, h: user.hash, gh: user.ghLogin || '', iv: user.provider === 'invite' ? 1 : 0 } };
  await kv.put(ZC_USER_PREFIX + email, userVal, userOpts);
  await zcKvMirror(env, ZC_USER_PREFIX + email, userVal, userOpts);
  return zcJson({ ok: true, token, email, name: user.name || '', provider: user.provider || 'email', ghLogin: user.ghLogin || '' });
}

// ---- GitHub OAuth：第一步，跳转 GitHub 授权页 ----
async function zcAuthGithubStart(request, env) {
  if (!zcGhOAuthReady(env)) {
    return zcJson({ error: '服务端未配置 GitHub 登录：请添加变量 GITHUB_OAUTH_CLIENT_ID 与 GITHUB_OAUTH_CLIENT_SECRET', code: 'GH_NOT_CONFIGURED' }, 501);
  }
  // Turnstile：这是浏览器顶层跳转，令牌通过 ?ts= 带上（一次性、几分钟内有效；失败则跳回首页提示）
  if (zcTsEnabled(env)) {
    const tsr = await zcTsVerify(env, new URL(request.url).searchParams.get('ts'), request.headers.get('cf-connecting-ip') || '');
    if (!tsr.ok) return zcAuthGithubBack(request, tsr.net ? '人机验证服务暂时不可用，请稍后重试' : '请先完成人机验证后再用 GitHub 登录');
  }
  const ret = String(new URL(request.url).searchParams.get('ret') || '').slice(0, 200);
  const state = zcRandHex(16);
  await zcKV(env).put(ZC_GH_STATE_PREFIX + state, JSON.stringify({ at: Date.now(), ret }), { expirationTtl: ZC_GH_STATE_TTL_SEC });
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', zcGhClientId(env));
  u.searchParams.set('redirect_uri', zcGhRedirectUri(request, env));
  u.searchParams.set('scope', ZC_GH_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'true');
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}

// 失败一律跳回首页并把原因交给前端展示（绝不把错误码留在 GitHub 页面上）
function zcAuthGithubBack(request, msg) {
  const loc = new URL(request.url).origin + '/' + (msg ? '?zc_auth_err=' + encodeURIComponent(String(msg).slice(0, 300)) : '');
  return new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store' } });
}

// ---- GitHub OAuth：第二步，收 code → 换令牌 → 读用户 → 建 KV 用户 → 签发会话 ----
async function zcAuthGithubCallback(request, env) {
  const url = new URL(request.url);
  if (!zcGhOAuthReady(env)) return zcAuthGithubBack(request, 'GitHub 登录未配置（缺少 GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET）');
  const state = String(url.searchParams.get('state') || '');
  const code = String(url.searchParams.get('code') || '');
  if (!/^[a-f0-9]{32}$/.test(state)) return zcAuthGithubBack(request, '登录状态校验失败（state 不合法），请重新登录');
  const stKey = ZC_GH_STATE_PREFIX + state;
  const stx2 = zcKV(env);
  const stRaw = await stx2.get(stKey);
  try { await stx2.delete(stKey); } catch (e) { /* ignore */ }   // 一次性使用，防重放
  if (!stRaw) return zcAuthGithubBack(request, '登录已超时或已使用过，请重新点击「用 GitHub 登录」');
  const oe = url.searchParams.get('error');
  if (oe || !code) return zcAuthGithubBack(request, 'GitHub 授权未完成：' + (url.searchParams.get('error_description') || oe || '未完成授权'));

  const body = new URLSearchParams();
  body.set('client_id', zcGhClientId(env));
  body.set('client_secret', zcGhClientSecret(env));
  body.set('code', code);
  body.set('redirect_uri', zcGhRedirectUri(request, env));
  let tok = null;
  try {
    const tr = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'zc-gura-signal' },
      body: body.toString()
    });
    tok = await tr.json();
  } catch (e) {
    return zcAuthGithubBack(request, '与 GitHub 通信失败：' + (e && e.message ? e.message : String(e)));
  }
  if (!tok || !tok.access_token) {
    return zcAuthGithubBack(request, '换取 GitHub 令牌失败：' + ((tok && (tok.error_description || tok.error)) || '未知错误'));
  }

  let gh = null;
  try {
    const ur = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer ' + tok.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'zc-gura-signal' }
    });
    if (!ur.ok) return zcAuthGithubBack(request, '读取 GitHub 用户信息失败（HTTP ' + ur.status + '）');
    gh = await ur.json();
  } catch (e) {
    return zcAuthGithubBack(request, '读取 GitHub 用户信息失败：' + (e && e.message ? e.message : String(e)));
  }

  const login = zcGhUserName(gh && gh.login);
  if (!login) return zcAuthGithubBack(request, '未能取得 GitHub 用户名');
  const wl = zcGhAllowedLogins(env);
  if (wl.length && wl.indexOf(login) < 0) return zcAuthGithubBack(request, '账号 ' + login + ' 不在允许登录的名单内');

  const kv = zcKV(env);
  const email = login + '@github';
  const now = Date.now();
  let user = null;
  try { user = JSON.parse((await kv.get(ZC_USER_PREFIX + email)) || 'null'); } catch (e) { user = null; }
  if (!user) user = { email, salt: '', hash: '', iter: 0, createdAt: now, lastLoginAt: now };
  user.provider = 'github';
  user.ghLogin = login;
  user.ghId = (gh && gh.id) || 0;
  user.ghName = String((gh && gh.name) || '');
  user.ghAvatar = String((gh && gh.avatar_url) || '');
  user.lastLoginAt = now;
  user.lastActiveAt = now;
  const userVal = JSON.stringify(user);
  const userOpts = { metadata: { c: user.createdAt || now, l: now, a: now, h: user.hash || '', gh: login, iv: 0 } };
  await kv.put(ZC_USER_PREFIX + email, userVal, userOpts);
  await zcKvMirror(env, ZC_USER_PREFIX + email, userVal, userOpts);

  const token = zcRandHex(32);
  const sessKey = ZC_SESS_PREFIX + (await zcSha256Hex(token));
  const sessVal = JSON.stringify({ email, createdAt: now, seenAt: now, provider: 'github', ghLogin: login });
  const sessOpts = { expirationTtl: ZC_SESS_TTL_SEC, metadata: { e: email, p: 'github' } };
  await kv.put(sessKey, sessVal, sessOpts);
  await zcKvMirror(env, sessKey, sessVal, sessOpts);
  const handoff = zcRandHex(32);
  await kv.put(ZC_GH_HANDOFF_PREFIX + handoff, JSON.stringify({ token, email, provider: 'github', ghLogin: login }), { expirationTtl: ZC_GH_HANDOFF_TTL_SEC });
  return new Response(null, { status: 302, headers: { Location: new URL(request.url).origin + '/?zc_handoff=' + handoff, 'Cache-Control': 'no-store' } });
}

// ---- 握手：前端用一次性票据换回真正的会话令牌（票据一次性、5 分钟过期） ----
async function zcAuthGithubHandoff(request, env) {
  const body = await zcAuthBody(request);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  const code = String(body.code || '').trim();
  if (!/^[a-f0-9]{64}$/.test(code)) return zcJson({ error: '登录凭据不合法' }, 400);
  const key = ZC_GH_HANDOFF_PREFIX + code;
  const stx = zcKV(env);
  const raw = await stx.get(key);
  try { await stx.delete(key); } catch (e) { /* ignore */ }
  if (!raw) return zcJson({ error: '登录凭据已失效，请重新登录', code: 'HANDOFF_EXPIRED' }, 400);
  let v = null;
  try { v = JSON.parse(raw); } catch (e) { v = null; }
  if (!v || !v.token) return zcJson({ error: '登录凭据已失效，请重新登录' }, 400);
  return zcJson({ ok: true, token: v.token, email: v.email, provider: v.provider || 'github', ghLogin: v.ghLogin || '', label: v.label || '' });
}

// ---- 邀请码注册（邮箱通道被拦截时的兜底入口） ----
async function zcAuthRegisterInvite(request, env) {
  const kv = zcKV(env);
  const body = await zcAuthBody(request);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  const codes = zcAuthInviteCodes(env);
  if (!codes.length) return zcJson({ error: '服务端未配置邀请码（变量 ZC_AUTH_INVITE_CODES）', code: 'INVITE_NOT_CONFIGURED' }, 501);
  const tsDeny = await zcTsGate(request, env, body.cf_turnstile);
  if (tsDeny) return tsDeny;

  const ipKey = ZC_IR_PREFIX + (request.headers.get('cf-connecting-ip') || 'unknown');
  const fails = parseInt((await kv.get(ipKey)) || '0', 10) || 0;
  if (fails >= ZC_IR_MAX_FAILS) return zcJson({ error: '尝试次数过多，请 15 分钟后再试', code: 'REG_LOCKED' }, 429);

  const name = String(body.name || '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const invite = String(body.invite || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(name)) return zcJson({ error: '账号名需为 3~32 位字母/数字/下划线/短横线，并以字母或数字开头' }, 400);
  if (password.length < ZC_PASS_MIN) return zcJson({ error: '密码至少 ' + ZC_PASS_MIN + ' 位' }, 400);
  if (password.length > ZC_PASS_MAX) return zcJson({ error: '密码不能超过 ' + ZC_PASS_MAX + ' 位' }, 400);

  const ci = codes.map(function (c) { return c.toLowerCase(); });
  if (ci.indexOf(invite.toLowerCase()) < 0) {
    await kv.put(ipKey, String(fails + 1), { expirationTtl: 900 });
    return zcJson({ error: '邀请码不正确', code: 'INVITE_WRONG' }, 403);
  }

  const email = zcInviteEmail(name);
  if (await kv.get(ZC_USER_PREFIX + email)) return zcJson({ error: '该账号名已被使用，请换一个', code: 'NAME_EXISTS' }, 409);
  const now = Date.now();
  const salt = zcRandHex(16);
  const hash = await zcPbkdf2Hex(password, salt, ZC_PBKDF2_ITER);
  const user = { email, name, salt, hash, iter: ZC_PBKDF2_ITER, createdAt: now, lastLoginAt: 0, provider: 'invite' };
  await kv.put(ZC_USER_PREFIX + email, JSON.stringify(user), { metadata: { c: now, l: 0, h: hash, gh: '', iv: 1 } });
  if (fails) { try { await kv.delete(ipKey); } catch (e) { /* ignore */ } }
  return zcJson({ ok: true, email, name });
}

async function zcAuthAdminUsers(request, env) {
  const kv = zcKV(env);
  const expected = String(env.ZC_ADMIN_TOKEN || '');
  if (!expected) return zcJson({ error: '未设置管理员口令：请在 Worker 变量中添加 ZC_ADMIN_TOKEN', code: 'ADMIN_NOT_CONFIGURED' }, 501);
  const fKey = ZC_ADMINFAIL_PREFIX + (request.headers.get('cf-connecting-ip') || 'unknown');
  const fails = parseInt((await kv.get(fKey)) || '0', 10) || 0;
  if (fails >= 10) return zcJson({ error: '尝试次数过多，请 15 分钟后再试' }, 429);
  const given = String(request.headers.get('x-zc-admin-token') || '');
  if (!given || !zcSafeEqual(given, expected)) {
    await kv.put(fKey, String(fails + 1), { expirationTtl: 900 });
    return zcJson({ error: '管理员口令错误' }, 401);
  }
  const users = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const res = await kv.list({ prefix: ZC_USER_PREFIX, cursor, limit: 1000 });
    for (const k of res.keys) {
      const m = k.metadata || {};
      users.push({ email: k.name.slice(ZC_USER_PREFIX.length), passwordHash: m.h || '', createdAt: m.c || 0, lastLoginAt: m.l || 0, ghLogin: m.gh || '', invite: !!m.iv });
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  users.sort((a, b) => b.createdAt - a.createdAt);
  return zcJson({ total: users.length, users });
}

async function zcHandleAuth(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: zcCorsHeaders() });

  const sub = new URL(request.url).pathname.slice(ZC_AUTH_PATH.length).replace(/^\//, '');
  const method = request.method;
  const kv = zcKV(env);
  const storeReady = zcStoreReady(env);
  // github/start 与 github/callback 是浏览器顶层跳转（callback 由 github.com 302 过来，Sec-Fetch-Site 必为 cross-site），
  // 因此这两条不做同源校验；安全性由「一次性 state 票据 + 服务端换令牌 + 授权码只能用一次」保证。
  if (sub.indexOf('github/') !== 0 && !/^(google|microsoft)\/(start|callback)$/.test(sub) && !zcIsSameOriginRequest(request)) {
    return zcJson({ error: '禁止跨站调用该接口' }, 403);
  }

  try {
    if (sub === 'status' && method === 'GET') {
      return zcJson({ enabled: zcAuthEnabled(env), kv: storeReady, store: zcStoreMode(env), db: zcDbReady(env), mail: zcMailReady(env), domains: zcAuthDomains(env), passMin: ZC_PASS_MIN, github: zcGhOAuthReady(env), google: zcOidcReady(env, 'google'), microsoft: zcOidcReady(env, 'microsoft'), ghWhitelist: zcGhAllowedLogins(env).length, invite: zcAuthInviteCodes(env).length > 0, turnstile: zcTsEnabled(env) ? zcTsSiteKey(env) : '' });
    }
    if (!storeReady) return zcJson({ error: '未绑定存储：请绑定 KV（变量名 ZC_KV）或 D1（变量名 DB）', code: 'AUTH_NOT_CONFIGURED' }, 501);
    { const __ext = await zcV29Auth(sub, method, request, env); if (__ext) return __ext; }
    if (sub === 'github/start' && method === 'GET') {
      if (!zcAuthEnabled(env)) return zcJson({ error: '登录验证已被关闭（ZC_AUTH_DISABLED）' }, 404);
      return await zcAuthGithubStart(request, env);
    }
    if (sub === 'github/callback' && method === 'GET') return await zcAuthGithubCallback(request, env);
    if (sub === 'admin/users' && method === 'GET') return await zcAuthAdminUsers(request, env);
    if (!zcAuthEnabled(env)) return zcJson({ error: '登录验证已被关闭（ZC_AUTH_DISABLED）' }, 404);

    if (sub === 'github/handoff' && method === 'POST') return await zcAuthGithubHandoff(request, env);
    if (sub === 'register-invite' && method === 'POST') return await zcAuthRegisterInvite(request, env);
    // v2.16：QQ 邮箱验证码注册 / 登录已下线，统一改用 GitHub 单点登录或邀请码注册
    if (sub === 'send-code' || sub === 'register') {
      return zcJson({ error: '邮箱验证码注册/登录已下线，请使用 GitHub 登录或邀请码注册', code: 'EMAIL_FLOW_REMOVED' }, 410);
    }
    if (sub === 'login' && method === 'POST') return await zcAuthLogin(request, env);
    if (sub === 'me' && method === 'GET') {
      const s = await zcAuthSession(request, env);
      if (!s) return zcJson({ error: '未登录或登录已过期', code: 'AUTH_REQUIRED' }, 401, { 'x-zc-auth': 'required' });
      let u = null;
      try { u = JSON.parse((await kv.get(ZC_USER_PREFIX + s.email)) || 'null'); } catch (e) { u = null; }
      return zcJson({ ok: true, email: s.email, name: (u && u.name) || '', provider: s.provider || (u && u.provider) || 'email', ghLogin: (u && u.ghLogin) || '', label: (u && (u.name || u.contact)) || '' });
    }
    if (sub === 'logout' && method === 'POST') {
      const token = String(request.headers.get('x-zc-session') || '');
      if (/^[a-f0-9]{64}$/.test(token)) {
        const key = ZC_SESS_PREFIX + (await zcSha256Hex(token));
        zcSessCache.delete(key);
        await kv.delete(key);
      }
      return zcJson({ ok: true });
    }
    return zcJson({ error: '未知的账号接口: ' + sub }, 404);
  } catch (err) {
    return zcJson({ error: '账号服务异常: ' + (err && err.message ? err.message : String(err)) }, 500);
  }
}

// ---- 管理页：/__zc_admin__（页面本身不含任何数据，输入 ZC_ADMIN_TOKEN 后才会拉取用户列表） ----
// v2.23：管理页由静态资源 public/admin.html 提供（前后端分离；取不到时用极简兜底页）
const ZC_ADMIN_FALLBACK = String.raw`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>ZC-GURA · 用户管理</title></head>
<body style="font:14px/1.7 -apple-system,'PingFang SC',sans-serif;padding:28px">
<p>管理页（public/admin.html）未取到，请确认静态资源已随部署上传。</p>
</body></html>`;
async function zcAdminPage(request, env, isHead) {
  let html = null;
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    try {
      const u = new URL(request.url);
      u.pathname = '/admin.html';
      const r = await env.ASSETS.fetch(new Request(u.toString(), { method: 'GET' }));
      if (r && r.status !== 404) html = await r.text();
    } catch (e) { /* 静态资源不可用 → 用兜底页 */ }
  }
  if (!html) html = ZC_ADMIN_FALLBACK;
  const __adminCsp = zcCspMode(env) === 'off' ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" : await zcCspForHtml(html, env, { admin: true });
  return new Response(isHead ? null : html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': __adminCsp
    }
  });
}

// ---------------------------------------------------------------------------
// 2.5) 云端 Linux 沙箱（Cloudflare Containers）+ Web 工具（Agent 专用）
//      结构：浏览器 → Worker（本文件）→ Durable Object（ZcSandboxDO）→
//      Container（Dockerfile 中的 sandbox-server）→ Linux /workspace
// ---------------------------------------------------------------------------
function zcValidWorkspace(ws) {
  return typeof ws === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(ws);
}

// v2.24 安全修复：沙箱工作区必须由服务端按「登录身份」派生，绝不能直接信任客户端的 x-zc-workspace。
// 旧逻辑：ws = 请求头 || 'main' → 所有用户落在同一个 E2B 沙箱，互相能 list/read/exec，造成源码泄露。
// 新逻辑：ws = 'u' + sha256(登录账号 + 客户端项目名)[0..24]；
//   · 账号来自服务端校验过的会话（GitHub 登录 = login@github；邀请码登录 = 其邮箱账号），客户端无法伪造；
//   · 客户端的 x-zc-workspace 仅作为“该用户自己的项目名”，不同用户即使都叫 main 也互不相通；
//   · 没有有效会话一律拒绝（不再回落到共享的 main）；仅当显式设置 ZC_SBX_ALLOW_ANON=1（单人自用、关闭登录）才允许匿名共享。
async function zcSbxResolveWs(request, env, clientWs) {
  const sess = await zcAuthSession(request, env);
  const acct = sess && sess.email ? String(sess.email).trim().toLowerCase() : '';
  if (acct) {
    const h = await zcSha256Hex('zc-sbx-v1|' + acct + '|' + clientWs);
    return { ok: true, ws: 'u' + h.slice(0, 24), owner: acct };
  }
  if (String((env && env.ZC_SBX_ALLOW_ANON) || '') === '1') return { ok: true, ws: clientWs, owner: '' };
  return { ok: false };
}

// 在响应文本中脱敏 GitHub Token（防止命令回显把凭证带进模型上下文）
function zcScrub(text, token) {
  if (!token || typeof text !== 'string') return text;
  return text.indexOf(token) >= 0 ? text.split(token).join('***') : text;
}

/* ===========================================================================
 * 2.5.1) E2B 云端沙箱驱动（v2.14，可选；配置 E2B_API_KEY 即启用）
 * 事实与边界（逐条按 e2b.dev 官方文档 / OpenAPI 核对，绝不夸大）：
 *   - 平台 API：https://api.e2b.app（请求头 X-API-Key）
 *       POST   /v2/sandboxes               创建沙箱（templateID / timeout / allow_internet_access）
 *       GET    /sandboxes/{id}             查询沙箱（返回 sandboxID / envdAccessToken / state / endAt）
 *       POST   /sandboxes/{id}/refreshes   延长存活（body 可选 {duration}）
 *       POST   /sandboxes/{id}/timeout     重设存活（body {timeout}，秒）
 *       DELETE /sandboxes/{id}             销毁
 *   - 沙箱内执行：https://sandbox.e2b.app（envd；共享域名 + 请求头定位目标沙箱）
 *       请求头：E2b-Sandbox-Id / E2b-Sandbox-Port(49983) / X-Access-Token(envdAccessToken)
 *       POST /process.Process/Start 为 Connect 协议（application/connect+json）：
 *         请求与响应都是「1 字节标志 + 4 字节大端长度 + JSON」的帧；响应为流式事件
 *         （start / data{stdout|stderr} / end{exitCode} / keepalive），data 内为 base64 字节。
 *   - 命令与文件操作全部只走这一条通道（文件由沙箱内 shell 完成），不依赖 Node SDK。
 *   - 密钥只存 Worker 变量；浏览器与前端代码永远拿不到，也不会回显进命令输出。
 *   - 沙箱按「工作区名」复用：实例内存缓存 + KV 备份（KV 写失败不影响功能）。
 * =========================================================================== */
const ZC_E2B_API = 'https://api.e2b.app';
const ZC_E2B_ENVD = 'https://sandbox.e2b.app';
const ZC_E2B_PORT = 49983;
const ZC_E2B_KV_PREFIX = 'zc_e2b_sbx_';
const ZC_E2B_MAX_OUT = 200000;
const ZC_E2B_MAX_READ = 1024 * 1024;   // v2.20.1：读通道上限提到 1MB（配合分块拉取，>1MB 由前端多次拉）
const ZC_E2B_CHUNK = 120000;   // v2.22：readchunk 每块原始字节数（须为 3 的倍数；base64 后 160000 字符 < ZC_E2B_MAX_OUT）
const ZC_E2B_LIST_MAX = 400;
const ZC_E2B_WRITE_CHUNK = 96000;   // v2.21.3：24000 → 96000（须为 4 的倍数；单个 shell 参数上限约 128KB），大文件写入的沙箱调用次数降到 1/4
const ZC_E2B_WRITE_MAX = 4 * 1024 * 1024;
const ZC_E2B_SESS = new Map();
const ZC_E2B_CREATING = new Map();   // v2.21.3：同一 isolate 内“正在创建沙箱”的标记（纯对象，不跨请求共享 Promise）
const ZC_E2B_STAT = { created: 0, memHit: 0, cacheHit: 0, kvHit: 0, execs: 0, retries: 0, lastCreatedAt: 0, lastCreatedId: '', resumed: 0, lastResumeAt: 0, cycled: 0, cycleFail: 0, lastCycleAt: 0, last: [] };
function zcE2bNote(type, msg) {
  try {
    ZC_E2B_STAT.last.push({ t: Date.now(), type: String(type || ''), msg: String(msg == null ? '' : msg).slice(0, 300) });
    if (ZC_E2B_STAT.last.length > 12) ZC_E2B_STAT.last.shift();
  } catch (e) { /* ignore */ }
}

function zcE2bKey(env) {
  return env && env.E2B_API_KEY ? String(env.E2B_API_KEY).trim() : '';
}
function zcE2bReady(env) { return zcE2bKey(env).length > 8; }
function zcE2bTemplate(env) {
  const t = env && env.E2B_TEMPLATE_ID ? String(env.E2B_TEMPLATE_ID).trim() : '';
  return t || 'base';
}
function zcE2bTtl(env) {
  const n = parseInt(String((env && env.E2B_TIMEOUT_SECONDS) || ''), 10);
  if (!n || isNaN(n)) return 1800;   // v2.21.3：默认 300 秒太短（沙箱会在创建后约 5 分钟失效，工作区随之清空）
  return Math.max(60, Math.min(3600, n));
}
function zcE2bNet(env) {
  const v = String((env && env.E2B_ALLOW_INTERNET) || '').trim().toLowerCase();
  if (!v) return true;
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}
/* v2.34：「沙箱在 Agent 工作到一半时被重置」的根因与对策（逐条按 E2B 官方文档 / OpenAPI 核对）：
 *   根因 ①：E2B 默认到期即 kill（lifecycle.onTimeout 默认 "kill"），kill = 文件系统和进程全部销毁、不可恢复。
 *           手机锁屏 / 切后台 / 网络断开 > 存活时长（默认 30 分钟）时，前端心跳停了，沙箱到点被杀，下一次请求只能新建一个空沙箱。
 *   根因 ②：不暂停的连续运行有上限（Hobby 1 小时 / Pro 24 小时），长任务跑到上限同样会被收回。
 *   对策 ①：创建时带 autoPause: true（到期改为「暂停」：保存文件系统 + 内存，暂停的沙箱无限期保留）+ autoResume: { enabled: true }；
 *           任何请求发现沙箱是暂停态，都先 POST /connect 恢复（200 = 本来就在跑；201 = 刚恢复；约 1 秒），而不是新建。
 *   对策 ②：连续运行快到上限时，主动「暂停 → 恢复」一次（计时清零，进程与内存都保留）。默认每 50 分钟；E2B_MAX_RUN_SECONDS 可调（0 = 关闭；Pro 可调大，上限 23 小时）。
 *   兜底   ：账号 / 接口版本不认这些字段时（HTTP 400）自动退回旧的「到期即 kill」，并在状态里如实标明；任何一步失败都不会 kill 沙箱。 */
function zcE2bAutoPause(env) {
  const v = String((env && env.E2B_AUTO_PAUSE) || '').trim().toLowerCase();
  if (!v) return true;
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}
function zcE2bMaxRunMs(env) {
  const raw = env && env.E2B_MAX_RUN_SECONDS != null ? String(env.E2B_MAX_RUN_SECONDS).trim() : '';
  if (raw === '') return 3000 * 1000;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return 3000 * 1000;
  if (n <= 0) return 0;
  return Math.max(300, Math.min(82800, n)) * 1000;
}

// ---- Connect 协议：帧编码 / base64 / 字节工具 ----
function zcE2bFrame(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(5 + bytes.length);
  out[0] = 0;
  out[1] = (bytes.length >>> 24) & 255;
  out[2] = (bytes.length >>> 16) & 255;
  out[3] = (bytes.length >>> 8) & 255;
  out[4] = bytes.length & 255;
  out.set(bytes, 5);
  return out;
}
function zcE2bB64Dec(s) {
  const str = String(s == null ? '' : s);
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  } catch (e) {
    // b64 被截断/含非法字符时 atob 会抛 InvalidCharacterError；容错返回空，绝不抛穿
    return new Uint8Array(0);
  }
}
function zcE2bB64Enc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  }
  return btoa(s);
}
function zcBytesJoin(list, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
  return out;
}
function zcBytesText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) { return ''; }
}
function zcShq(s) { return '\'' + String(s == null ? '' : s).split('\'').join('\'\\\'\'') + '\''; }

// ---- 平台 API ----
async function zcE2bApi(env, path, method, body) {
  const init = {
    method: method || 'GET',
    headers: { 'X-API-Key': zcE2bKey(env), 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'zc-signal-e2b/2.14' }
  };
  if (method && method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body == null ? {} : body);
  const resp = await fetch(ZC_E2B_API + path, init);
  let text = '';
  try { text = await resp.text(); } catch (e) { /* ignore */ }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { ok: resp.ok, status: resp.status, json: json, text: text };
}
function zcE2bApiMsg(r) {
  if (r && r.json && (r.json.message || r.json.error)) return String(r.json.message || r.json.error);
  if (r && r.text) return String(r.text).slice(0, 200);
  return 'HTTP ' + (r && r.status ? r.status : '?');
}
async function zcE2bRemember(env, sess) {
  if (!sess || !sess.id) return false;
  const rec = { id: sess.id, root: sess.root || '', at: Date.now(), runStart: sess.runStart || 0, mode: sess.mode || '' };
  const okCache = await zcE2bCachePut(sess.ws || 'main', rec);
  let okKv = false;
  try {
    if (zcStoreReady(env)) {
      await zcKV(env).put(ZC_E2B_KV_PREFIX + (sess.ws || 'main'), JSON.stringify(rec), { expirationTtl: 7200 });
      okKv = true;
    }
  } catch (e) { zcE2bNote('kvPut', e && e.message); }
  return okCache || okKv;
}
async function zcE2bCreate(env, ws) {
  const base = {
    templateID: zcE2bTemplate(env),
    timeout: zcE2bTtl(env),
    allow_internet_access: zcE2bNet(env),
    metadata: { app: 'zc-signal', ws: String(ws) }
  };
  // v2.34：先要「到期暂停 + 自动恢复」，账号 / 接口不认（400）就退一档，最后才是旧的「到期即 kill」
  const variants = [];
  if (zcE2bAutoPause(env)) {
    variants.push({ mode: 'pause', extra: { autoPause: true, autoResume: { enabled: true } } });
    variants.push({ mode: 'pause', extra: { autoPause: true } });
  }
  variants.push({ mode: 'kill', extra: {} });
  // 优先走官方推荐的 /v2/sandboxes；若该账号/模板不支持（400/404/405/410/501），回退到 /sandboxes
  const paths = ['/v2/sandboxes', '/sandboxes'];
  let last = null;
  for (let i = 0; i < paths.length; i++) {
    for (let v = 0; v < variants.length; v++) {
      const r = await zcE2bApi(env, paths[i], 'POST', Object.assign({}, base, variants[v].extra));
      if (r.ok && r.json && r.json.sandboxID) {
        if (variants[v].mode === 'kill' && zcE2bAutoPause(env)) zcE2bNote('no-autopause', '创建时不认暂停相关字段，退回「到期即 kill」：' + zcE2bApiMsg(last));
        return { id: String(r.json.sandboxID), token: String(r.json.envdAccessToken || ''), root: '', at: Date.now(), runStart: Date.now(), mode: variants[v].mode, ws: String(ws), ttl: zcE2bTtl(env), api: paths[i] };
      }
      last = r;
      if (r.status === 400 && v < variants.length - 1) continue;   // 不认暂停相关字段 → 退一档再试
      break;
    }
    const retriable = (last.status === 400 || last.status === 404 || last.status === 405 || last.status === 410 || last.status === 501);
    if (i === paths.length - 1 || !retriable) break;
  }
  throw new Error('创建 E2B 沙箱失败：' + zcE2bApiMsg(last));
}
async function zcE2bInfo(env, id) {
  const r = await zcE2bApi(env, '/sandboxes/' + encodeURIComponent(id), 'GET');
  if (!r.ok || !r.json || !r.json.sandboxID) return null;
  return r.json;
}
// v2.30.4：三态查询 —— alive（还活着）/ gone（E2B 明确说不存在：404、410）/ unknown（网络抖动、429 限流、5xx，状态不明）。
// 旧逻辑把“查不到”一律当成“已失效”→ 新建一个空沙箱，/workspace 里还没拉回本地的文件随之全部消失（截图里「沙箱被重置了，之前复制的文件已丢失」）。
// 实际上拉回几百个文件时每个请求都会查一次沙箱状态，E2B 平台接口只要有一次 429 / 5xx，就会误判重建。现在只有 gone 才重建，unknown 一律原地重试。
// v2.34：多了「暂停」这一态 —— 暂停的沙箱不是丢了，是睡着了：这里直接 connect 把它唤醒（文件系统 + 内存都在），返回 alive + resumed:true。
//        GET 在部分接口版本里对暂停的沙箱会 404，所以 404 时用 connect 再确认一次（真被 kill 了，connect 也是 404 → gone）。
async function zcE2bConnect(env, id, sec, maxWaitMs) {
  const idq = encodeURIComponent(id);
  const paths = ['/v2/sandboxes/' + idq + '/connect', '/sandboxes/' + idq + '/connect'];
  const t0 = Date.now(), budget = maxWaitMs || 20000;
  let why = '', tries = 0;
  for (;;) {
    let n404 = 0, busy = false;
    for (let i = 0; i < paths.length; i++) {
      const r = await zcE2bApi(env, paths[i], 'POST', { timeout: sec });
      if (r.ok) return { state: 'alive', info: (r.json && r.json.sandboxID) ? r.json : null, resumed: r.status === 201 };
      if (r.status === 404 || r.status === 405 || r.status === 410) { n404++; why = 'HTTP ' + r.status; continue; }
      why = 'HTTP ' + r.status + ' ' + zcE2bApiMsg(r);
      if (r.status === 409 || r.status === 429 || r.status >= 500) { busy = true; break; }   // 409 = 正在暂停 / 恢复中；429 / 5xx = 平台忙：等一下再来
      return { state: 'unknown', why: why };   // 401 / 403 / 400：状态无从判断，绝不当成「已丢失」
    }
    if (!busy && n404 >= paths.length) {
      // 两个 connect 路径都说不存在 → 最后试一次已弃用的 resume；它也说不存在才算真的没了
      const r2 = await zcE2bApi(env, '/sandboxes/' + idq + '/resume', 'POST', { timeout: sec });
      if (r2.ok) return { state: 'alive', info: (r2.json && r2.json.sandboxID) ? r2.json : null, resumed: true };
      if (r2.status === 404 || r2.status === 405 || r2.status === 410) return { state: 'gone', status: 404 };
      why = 'HTTP ' + r2.status + ' ' + zcE2bApiMsg(r2);
    }
    if (Date.now() - t0 > budget) return { state: 'unknown', why: why || '等待恢复超时' };
    tries++;
    await zcSleep(Math.min(3000, 700 * tries));
  }
}
async function zcE2bResumeBox(env, id, info0) {
  const c = await zcE2bConnect(env, id, zcE2bTtl(env), 25000);
  if (c.state !== 'alive') return c;
  if (c.resumed) { ZC_E2B_STAT.resumed++; ZC_E2B_STAT.lastResumeAt = Date.now(); zcE2bNote('resume', '已从暂停态恢复：' + id); }
  let info = null;
  try { const r = await zcE2bApi(env, '/sandboxes/' + encodeURIComponent(id), 'GET'); if (r.ok && r.json && r.json.sandboxID) info = r.json; } catch (e) { /* ignore */ }
  info = info || c.info || info0;
  if (!info) return { state: 'unknown', why: '已恢复，但取不到沙箱信息' };
  if (!info.metadata && info0 && info0.metadata) info = Object.assign({}, info, { metadata: info0.metadata });   // connect 返回的 Sandbox 不带 metadata
  if (!info.envdAccessToken && c.info && c.info.envdAccessToken) info = Object.assign({}, info, { envdAccessToken: c.info.envdAccessToken });
  return { state: 'alive', info: info, resumed: !!c.resumed };
}
async function zcE2bInfoEx(env, id) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await zcE2bApi(env, '/sandboxes/' + encodeURIComponent(id), 'GET');
      if (r.ok && r.json && r.json.sandboxID) {
        const st = String(r.json.state || 'running').toLowerCase();
        if (st === 'running') return { state: 'alive', info: r.json };
        const w = await zcE2bResumeBox(env, id, r.json);   // paused / pausing：唤醒
        if (w.state !== 'unknown') return w;
        last = w.why || '';
      } else if (r.status === 404 || r.status === 410) {
        const w2 = await zcE2bResumeBox(env, id, null);
        if (w2.state !== 'unknown') return w2;
        last = w2.why || '';
      } else last = 'HTTP ' + r.status;
    } catch (e) { last = String(e && e.message ? e.message : e); }
    await zcSleep(500 * (i + 1));
  }
  return { state: 'unknown', why: last };
}
// Cache API：同机房强一致（KV 是最终一致、且受每日写配额限制），作为会话的首选持久层
function zcE2bCacheKey(ws) { return 'https://zc-e2b-session.internal/' + encodeURIComponent(String(ws || 'main')); }
async function zcE2bCacheGet(ws) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return null;
    const r = await caches.default.match(zcE2bCacheKey(ws));
    if (!r) return null;
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  } catch (e) { zcE2bNote('cacheGet', e && e.message); return null; }
}
async function zcE2bCachePut(ws, obj) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return false;
    await caches.default.put(zcE2bCacheKey(ws), new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=7200' } }));
    return true;
  } catch (e) { zcE2bNote('cachePut', e && e.message); return false; }
}
// v2.21.3：按元数据（app=zc-signal & ws=工作区名）向 E2B 平台找回仍在运行的沙箱 —— 不依赖 KV / Cache API
// （workers.dev 域名上 Cache API 不生效、也可能没绑 KV，换 isolate 就会“失忆”并新建空沙箱，本地推上去的文件随之消失）。
async function zcE2bFindByMeta(env, ws) {
  try {
    const q = encodeURIComponent('app=zc-signal&ws=' + ws);
    // v2.34：运行中的和「暂停的」都要找（暂停 = 睡着了，文件都在）；v2 列表按 state 分开查，旧接口 /sandboxes 只列运行中的
    const urls = ['/v2/sandboxes?state=running&limit=100&metadata=' + q, '/v2/sandboxes?state=paused&limit=100&metadata=' + q, '/sandboxes?metadata=' + q];
    const cands = [], seen = {};
    for (let u = 0; u < urls.length; u++) {
      const r = await zcE2bApi(env, urls[u], 'GET');
      if (!r.ok || !r.json) continue;
      const arr = Array.isArray(r.json) ? r.json : (Array.isArray(r.json.sandboxes) ? r.json.sandboxes : []);
      arr.forEach(function (x) {
        if (!x || !x.sandboxID || seen[x.sandboxID]) return;
        if (x.state && ['running', 'paused', 'pausing'].indexOf(String(x.state)) < 0) return;
        const md = x.metadata;
        if (!(md && typeof md === 'object' && String(md.app || '') === 'zc-signal' && String(md.ws || '') === String(ws))) return;
        seen[x.sandboxID] = 1; cands.push(x);
      });
    }
    // 运行中的优先，其次按启动时间新的在前
    cands.sort(function (a, b) {
      const ra = !a.state || String(a.state) === 'running' ? 0 : 1, rb = !b.state || String(b.state) === 'running' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return String(b.startedAt || '') < String(a.startedAt || '') ? -1 : 1;
    });
    for (let i = 0; i < Math.min(cands.length, 3); i++) {
      const ix = await zcE2bInfoEx(env, String(cands[i].sandboxID));
      if (ix.state === 'alive') { if (ix.resumed) ix.info.__resumed = true; return ix.info; }
    }
  } catch (e) { zcE2bNote('findMeta', e && e.message); }
  return null;
}
// 采用浏览器带来的沙箱 ID 提示（x-zc-sbx-id）：只要该沙箱还活着且属于本应用，就直接接管，不再新建
async function zcE2bAdopt(env, ws, id) {
  const ix = await zcE2bInfoEx(env, id);   // v2.34：暂停的沙箱也接管（先唤醒）
  if (ix.state !== 'alive' || !ix.info) return false;
  const info = ix.info;
  const md = info.metadata;
  // v2.24：必须明确属于当前（派生）工作区才允许接管；缺少 ws 元数据的沙箱一律不接管，防止凭沙箱 ID 越权
  if (!(md && typeof md === 'object' && String(md.app || '') === 'zc-signal' && md.ws != null && String(md.ws) === String(ws))) return false;
  const sess = { id: String(info.sandboxID), token: String(info.envdAccessToken || ''), root: '', at: Date.now(), runStart: ix.resumed ? Date.now() : (Date.parse(info.startedAt || '') || Date.now()), mode: '', ws: ws, ttl: zcE2bTtl(env) };
  if (ix.resumed) sess.resumedAt = Date.now();
  ZC_E2B_SESS.set(ws, sess);
  await zcE2bRemember(env, sess);
  return true;
}
async function zcE2bSessionGet(env, ws, forceNew) {
  ws = String(ws || 'main');
  const mem = ZC_E2B_SESS.get(ws);
  if (!forceNew && mem && mem.id) { ZC_E2B_STAT.memHit++; return mem; }
  // 同一 isolate 内已有请求正在恢复/创建 → 轮询等它完成（只读纯对象，避免跨请求等待同一个 Promise）
  if (!forceNew) {
    const t0 = ZC_E2B_CREATING.get(ws);
    if (t0 && Date.now() - t0 < 40000) {
      for (let i = 0; i < 70; i++) {
        await zcSleep(500);
        const m2 = ZC_E2B_SESS.get(ws);
        if (m2 && m2.id) return m2;
        if (!ZC_E2B_CREATING.get(ws)) break;
      }
      const m3 = ZC_E2B_SESS.get(ws);
      if (m3 && m3.id) return m3;
    }
  }
  ZC_E2B_CREATING.set(ws, Date.now());
  try {
    if (!forceNew) {
      let saved = null, src = '';
      const c = await zcE2bCacheGet(ws);
      if (c && c.id) { saved = c; src = 'cache'; }
      if (!saved) {
        try {
          const raw = zcStoreReady(env) ? await zcKV(env).get(ZC_E2B_KV_PREFIX + ws) : null;
          if (raw) { saved = JSON.parse(raw); src = 'kv'; }
        } catch (e) { zcE2bNote('kvGet', e && e.message); }
      }
      let info = null;
      if (saved && saved.id) {
        const ix = await zcE2bInfoEx(env, saved.id);
        if (ix.state === 'alive') { info = ix.info; if (ix.resumed) info = Object.assign({}, info, { __resumed: true }); }
        else if (ix.state === 'unknown') {
          // 状态不明（E2B 平台接口抖动 / 限流）：绝不新建空沙箱 —— 直接报错让调用方稍后重试，工作区里的文件才不会丢
          zcE2bNote('restore-unknown', src + ' id=' + saved.id + ' ' + (ix.why || ''));
          throw new Error('暂时无法确认云端沙箱的状态（E2B 平台接口抖动或被限流：' + (ix.why || '未知') + '）。为避免新建一个空沙箱导致 /workspace 里的文件丢失，已中止本次请求，请几秒后重试。');
        } else zcE2bNote('restore-miss', src + ' id=' + saved.id);
      }
      if (!info) {
        info = await zcE2bFindByMeta(env, ws);
        if (info) { src = 'meta'; saved = saved || {}; zcE2bNote('restore-meta', 'id=' + info.sandboxID); }
      }
      if (info) {
        if (src === 'cache') ZC_E2B_STAT.cacheHit++; else ZC_E2B_STAT.kvHit++;
        const sameBox = !!(saved && saved.id && String(saved.id) === String(info.sandboxID));
        const sess = { id: String(info.sandboxID), token: String(info.envdAccessToken || ''), root: sameBox ? String(saved.root || '') : '', at: Date.now(), ws: ws, ttl: zcE2bTtl(env),
          runStart: info.__resumed ? Date.now() : ((sameBox && saved.runStart) || Date.parse(info.startedAt || '') || Date.now()), mode: sameBox ? String(saved.mode || '') : '' };
        if (info.__resumed) { sess.resumedAt = Date.now(); }
        ZC_E2B_SESS.set(ws, sess);
        if (src === 'meta' || info.__resumed) await zcE2bRemember(env, sess);
        return sess;
      }
    }
    const sess = await zcE2bCreate(env, ws);
    ZC_E2B_STAT.created++;
    ZC_E2B_STAT.lastCreatedAt = Date.now();
    ZC_E2B_STAT.lastCreatedId = sess.id;
    ZC_E2B_SESS.set(ws, sess);
    await zcE2bRemember(env, sess);
    return sess;
  } finally {
    ZC_E2B_CREATING.delete(ws);
  }
}
// v2.34：连续运行快到平台上限（Hobby 1 小时 / Pro 24 小时）时，主动「暂停 → 恢复」一次，计时清零。
// 暂停保存文件系统 + 内存（进程也在）；本 isolate 里还有命令在跑时不动手（暂停会断开正在读的输出流），等下一次；
// 任何一步失败都只记一笔、不 kill —— 最坏情况沙箱停在暂停态，下一次请求会自动唤醒。
async function zcE2bMaybeCycle(env, sess, force) {
  try {
    const cap = zcE2bMaxRunMs(env);
    if (!sess || !sess.id || (!cap && !force)) return false;
    if (sess.mode === 'kill') return false;   // 创建时没拿到「暂停」能力：暂停后可能回不来，不冒这个险
    const now = Date.now();
    const age = now - (sess.runStart || sess.at || now);
    if (!force && age < cap) return false;
    if ((sess.inflight || 0) > 0) return false;
    if (sess.cycling && now - sess.cycling < 90000) return false;
    sess.cycling = now;
    try {
      const idp = '/sandboxes/' + encodeURIComponent(sess.id);
      let paused = false, gone = false;
      for (let i = 0; i < 3 && !paused; i++) {
        const r = await zcE2bApi(env, idp + '/pause', 'POST', {});
        if (r.ok || r.status === 409) paused = true;          // 409 = 已经在暂停 / 已暂停
        else if (r.status === 404 || r.status === 410) { gone = true; break; }
        else await zcSleep(1500 * (i + 1));                    // 503 节点忙 / 429 / 5xx：稍后再试
      }
      if (!paused) { if (!gone) { ZC_E2B_STAT.cycleFail++; zcE2bNote('cycle-skip', '暂时无法暂停（平台忙），下次再试：' + sess.id); } return false; }
      const c = await zcE2bConnect(env, sess.id, zcE2bTtl(env), 50000);   // 暂停约 4 秒 / GiB 内存；期间 connect 遇到 409 会等
      if (c.state === 'alive') {
        sess.runStart = Date.now(); sess.resumedAt = Date.now();
        if (c.info && c.info.envdAccessToken) sess.token = String(c.info.envdAccessToken);
        ZC_E2B_STAT.cycled++; ZC_E2B_STAT.lastCycleAt = Date.now();
        zcE2bNote('cycle', '已完成「暂停→恢复」，连续运行计时清零：' + sess.id);
        await zcE2bRemember(env, sess);
        return true;
      }
      ZC_E2B_STAT.cycleFail++;
      zcE2bNote('cycle-resume', '暂停后恢复未完成（沙箱停在暂停态，下一次请求会自动唤醒）：' + (c.why || c.state));
      return false;
    } finally { sess.cycling = 0; }
  } catch (e) { zcE2bNote('cycle-err', e && e.message); return false; }
}
async function zcE2bExtend(env, sess, needMs) {
  try {
    const now = Date.now();
    const needSec = Math.max(zcE2bTtl(env), Math.min(3600, Math.ceil((needMs || 0) / 1000) + 120));
    // 节流：20 秒内已经续过且时长足够就不再调用（Workers 免费版单次请求最多 50 个子请求，续期不能每次执行都发）
    if (sess.extAt && now - sess.extAt < 20000 && (sess.extSec || 0) >= needSec) return;
    const idp = '/sandboxes/' + encodeURIComponent(sess.id);
    // v2.21.3：用 /timeout 覆盖式续期（「从现在起再活 N 秒」，可反复调用 = 真正的保活）；失败再退回 /refreshes
    let r = await zcE2bApi(env, idp + '/timeout', 'POST', { timeout: needSec });
    if (!r.ok) r = await zcE2bApi(env, idp + '/refreshes', 'POST', { duration: needSec });
    if (r.ok) { sess.ttl = needSec; sess.extAt = now; sess.extSec = needSec; }
  } catch (e) { /* 续期失败不阻断执行 */ }
}

// ---- envd：在沙箱里执行一条 shell 命令（Connect 流式） ----
async function zcE2bStart(env, sess, command, opts) {
  opts = opts || {};
  const toMs = Math.max(3000, Math.min(1500000, parseInt(opts.timeoutMs, 10) || 120000));
  const ctrl = new AbortController();
  const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, toMs + 5000);
  const body = zcE2bFrame({
    process: {
      cmd: 'bash',
      args: ['-lc', String(command == null ? '' : command)],
      cwd: opts.cwd || sess.root || '/home/user',
      envs: { TERM: 'dumb', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
    },
    stdin: false
  });
  let resp = null;
  try {
    resp = await fetch(ZC_E2B_ENVD + '/process.Process/Start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'Connect-Timeout-Ms': String(toMs + 5000),
        'Accept': 'application/connect+json',
        'E2b-Sandbox-Id': sess.id,
        'E2b-Sandbox-Port': String(ZC_E2B_PORT),
        'X-Access-Token': sess.token
      },
      body: body,
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('无法连接 E2B 沙箱执行通道：' + (e && e.message ? e.message : String(e)));
  }
  if (!resp.ok) {
    clearTimeout(timer);
    let t = '';
    try { t = await resp.text(); } catch (e) { /* ignore */ }
    if (resp.status === 401 || resp.status === 403) throw new Error('E2B 沙箱鉴权失败（会话已失效）：HTTP ' + resp.status);
    throw new Error('E2B 执行通道返回 HTTP ' + resp.status + (t ? '：' + String(t).slice(0, 200) : ''));
  }

  const outChunks = []; let outLen = 0;
  const errChunks = []; let errLen = 0;
  let exitCode = 0, ended = false, streamErr = '';
  const dec = new TextDecoder('utf-8', { fatal: false });
  let reader = null;
  try { reader = resp.body.getReader(); } catch (e) { reader = null; }
  if (reader) {
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        const chunk = step.value;
        if (!chunk || !chunk.length) continue;
        if (buf.length) {
          const merged = new Uint8Array(buf.length + chunk.length);
          merged.set(buf, 0); merged.set(chunk, buf.length);
          buf = merged;
        } else buf = new Uint8Array(chunk);
        for (;;) {
          if (buf.length < 5) break;
          const flags = buf[0];
          const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
          if (buf.length < 5 + len) break;
          const payload = buf.subarray(5, 5 + len);
          buf = buf.slice(5 + len);
          if (flags & 2) {
            try {
              const tr = JSON.parse(dec.decode(payload) || '{}');
              if (tr && tr.error && tr.error.message) streamErr = String(tr.error.message);
            } catch (e) { /* ignore */ }
            continue;
          }
          if (flags & 1) { if (!streamErr) streamErr = '收到不支持的压缩帧'; continue; }
          let msg = null;
          try { msg = JSON.parse(dec.decode(payload)); } catch (e) { continue; }
          const ev = msg && msg.event ? msg.event : null;
          if (!ev) continue;
          if (ev.end) {
            if (typeof ev.end.exitCode === 'number') exitCode = ev.end.exitCode;
            ended = true;
            if (ev.end.error) streamErr = String(ev.end.error);
          } else if (ev.data) {
            if (typeof ev.data.stdout === 'string' && outLen < ZC_E2B_MAX_OUT) {
              const b = zcE2bB64Dec(ev.data.stdout); outChunks.push(b); outLen += b.length;
            }
            if (typeof ev.data.stderr === 'string' && errLen < ZC_E2B_MAX_OUT) {
              const b = zcE2bB64Dec(ev.data.stderr); errChunks.push(b); errLen += b.length;
            }
          }
        }
      }
    } catch (e) {
      clearTimeout(timer);
      throw new Error('读取 E2B 执行输出失败：' + (e && e.message ? e.message : String(e)));
    }
  }
  clearTimeout(timer);
  let stdout = zcBytesText(zcBytesJoin(outChunks, outLen));
  let stderr = zcBytesText(zcBytesJoin(errChunks, errLen));
  if (stdout.length > ZC_E2B_MAX_OUT) stdout = stdout.slice(0, ZC_E2B_MAX_OUT) + '\n…（输出已截断）';
  if (stderr.length > ZC_E2B_MAX_OUT) stderr = stderr.slice(0, ZC_E2B_MAX_OUT) + '\n…（错误输出已截断）';
  if (!ended) {
    if (streamErr) throw new Error('E2B 执行失败：' + streamErr);
    exitCode = -1;
  }
  return { stdout: stdout, stderr: stderr, exitCode: exitCode };
}

// ---- 工作区根目录（/workspace 可写则用它，否则退回 $HOME/workspace） ----
async function zcE2bRoot(env, sess) {
  if (sess.root) return sess.root;
  // E2B 默认用非 root 用户（uid 1000，属 sudo 组且 sudo 免密），所以 /workspace 要用 sudo 建一次并改属主；
  // 拿不到 sudo 时依次退回 $HOME/workspace、当前目录（并在 exec 里做 /workspace → 真实根 的路径改写兜底）。
  const cmd = 'if [ -d /workspace ] && [ -w /workspace ]; then echo /workspace; '
    + 'elif sudo -n true 2>/dev/null && sudo -n mkdir -p /workspace 2>/dev/null && sudo -n chown "$(id -u):$(id -g)" /workspace 2>/dev/null && [ -w /workspace ]; then echo /workspace; '
    + 'elif mkdir -p "$HOME/workspace" 2>/dev/null && [ -w "$HOME/workspace" ]; then echo "$HOME/workspace"; '
    + 'else echo "$PWD"; fi';
  let root = '';
  try {
    const r = await zcE2bStart(env, sess, cmd, { timeoutMs: 30000 });
    const lines = String(r.stdout || '').trim().split('\n');
    root = String(lines[lines.length - 1] || '').trim();
  } catch (e) { root = ''; }
  if (!root || root.charAt(0) !== '/') root = '/home/user/workspace';
  sess.root = root;
  zcE2bRemember(env, sess);
  return root;
}

// ---- 统一执行入口：会话失效/网络抖动时自动重建并重试（最多3次，指数退避） ----
async function zcE2bRun(env, ws, command, opts) {
  opts = opts || {};
  let sess = await zcE2bSessionGet(env, ws, false);
  await zcE2bRoot(env, sess);
  await zcE2bMaybeCycle(env, sess, false);
  await zcE2bExtend(env, sess, opts.timeoutMs || 120000);
  const t0 = Date.now();
  let r = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // 指数退避：1s, 2s
      const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
      await new Promise((res) => setTimeout(res, waitMs));
      // v2.21.3：先确认原沙箱是否还活着 —— 只是网络抖动就原地重试，绝不新建（新建 = 空工作区，旧沙箱还继续计费）
      let __alive = null, __unknown = false, __ix = null;
      try {
        __ix = sess && sess.id ? await zcE2bInfoEx(env, sess.id) : { state: 'gone' };
        if (__ix.state === 'alive') __alive = __ix.info; else if (__ix.state === 'unknown') __unknown = true;
      } catch (e) { __unknown = true; }
      if (__alive) {
        if (__alive.envdAccessToken) sess.token = String(__alive.envdAccessToken);
        if (__ix && __ix.resumed) { sess.resumedAt = Date.now(); sess.runStart = Date.now(); zcE2bNote('exec-resume', '执行前发现沙箱在暂停态，已唤醒：' + sess.id); }
      } else if (__unknown) {
        zcE2bNote('rebuild-skip', '沙箱状态不明（接口抖动 / 限流），原地重试、不新建：' + (sess && sess.id));
      } else {
        zcE2bNote('rebuild', '原沙箱已失效，重建：' + (sess && sess.id));
        ZC_E2B_SESS.delete(String(ws || 'main'));
        sess = await zcE2bSessionGet(env, ws, true);
      }
      await zcE2bRoot(env, sess);
      await zcE2bExtend(env, sess, opts.timeoutMs || 120000);
      ZC_E2B_STAT.retries++;
    }
    try {
      sess.inflight = (sess.inflight || 0) + 1;
      try { r = await zcE2bStart(env, sess, command, { cwd: opts.cwd || sess.root, timeoutMs: opts.timeoutMs }); }
      finally { sess.inflight = Math.max(0, (sess.inflight || 1) - 1); }
      break; // 成功，跳出重试循环
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      zcE2bNote('exec-fail', m + ' (attempt ' + (attempt + 1) + ')');
      lastErr = e;
      // 鉴权失败/会话不存在 → 重建会话重试
      if (/鉴权失败|HTTP 4(04|10|09)|HTTP 50[234]|not found|not running|paused|expired|已失效/i.test(m)) continue;   // v2.34：502/503/504 + 「暂停」也走「先确认状态 → 唤醒 / 原地重试」
      // 网络错误/连接失败 → 也重试
      if (/无法连接|网络|network|ECONNREFUSED|ETIMEDOUT|timeout|fetch/i.test(m)) continue;
      // 其他错误（如命令本身报错）→ 不重试，直接抛
      throw e;
    }
  }
  if (!r) throw lastErr || new Error('E2B 执行失败：重试 3 次后仍失败');
  r.durationMs = Date.now() - t0;
  return r;
}

// ---- 路径规范化（与前端 CloudFS.sanitize 一致；服务端再校验一次） ----
function zcSbxRel(p) {
  let s = String(p == null ? '' : p).trim();
  if (s === '/workspace') s = '';
  else if (s.indexOf('/workspace/') === 0) s = s.slice('/workspace/'.length);
  s = s.replace(/^\/+/, '');
  if (s.indexOf('\\') >= 0) throw new Error('路径不允许包含反斜杠');
  const parts = s.split('/').map(function (x) { return x.trim(); }).filter(function (x) { return x !== '' && x !== '.'; });
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..') throw new Error('路径不允许包含 ..（不能越权访问工作区之外）');
    if (/[\x00-\x1f]/.test(parts[i])) throw new Error('路径包含非法字符');
  }
  return parts.join('/');
}
function zcSbxAbs(sess, rel) {
  const r = String(rel == null ? '' : rel);
  const root = String(sess.root || '/workspace').replace(/\/+$/, '');
  return r ? (root + '/' + r) : root;
}
// 兜底：当工作区根不在 /workspace 时（例如模板里没有 sudo），把命令里硬编码的 /workspace 改写到真实根
function zcE2bCmd(sess, command) {
  const cmd = String(command == null ? '' : command);
  const root = String(sess.root || '/workspace');
  if (!root || root === '/workspace') return cmd;
  return cmd.split('/workspace').join(root);
}

// v2.21.3：写入一个文件（base64 分段 → 临时文件 → mv），并用 stat 校验最终字节数，
// 避免“沙箱中途被重建导致只写进后半段”这类静默损坏。expectBytes 为期望字节数（可选）。
async function zcE2bWriteB64(env, ws, root, abs, b64, expectBytes) {
  const dir = abs.lastIndexOf('/') > 0 ? abs.slice(0, abs.lastIndexOf('/')) : root;
  const tmp = abs + '.zc-tmp';
  let r = null;
  let chunks = 1;
  if (b64.length <= ZC_E2B_WRITE_CHUNK) {
    r = await zcE2bRun(env, ws, 'mkdir -p ' + zcShq(dir) + ' && printf %s ' + zcShq(b64) + ' | base64 -d > ' + zcShq(tmp) + ' && mv -f ' + zcShq(tmp) + ' ' + zcShq(abs) + ' && stat -c%s ' + zcShq(abs), { cwd: root, timeoutMs: 90000 });
    if (r.exitCode !== 0) return { ok: false, error: '写入失败：' + String(r.stderr || '').slice(0, 200) };
  } else {
    r = await zcE2bRun(env, ws, 'mkdir -p ' + zcShq(dir) + ' && : > ' + zcShq(tmp), { cwd: root, timeoutMs: 60000 });
    if (r.exitCode !== 0) return { ok: false, error: '无法创建目标目录：' + String(r.stderr || '').slice(0, 200) };
    chunks = 0;
    for (let i = 0; i < b64.length; i += ZC_E2B_WRITE_CHUNK) {
      chunks++;
      r = await zcE2bRun(env, ws, 'printf %s ' + zcShq(b64.slice(i, i + ZC_E2B_WRITE_CHUNK)) + ' | base64 -d >> ' + zcShq(tmp), { cwd: root, timeoutMs: 90000 });
      if (r.exitCode !== 0) return { ok: false, error: '写入第 ' + chunks + ' 段失败：' + String(r.stderr || '').slice(0, 200) };
    }
    r = await zcE2bRun(env, ws, 'mv -f ' + zcShq(tmp) + ' ' + zcShq(abs) + ' && stat -c%s ' + zcShq(abs), { cwd: root, timeoutMs: 60000 });
    if (r.exitCode !== 0) return { ok: false, error: '写入失败：' + String(r.stderr || '').slice(0, 200) };
  }
  const size = parseInt(String(r.stdout || '0').trim().split('\n').pop(), 10) || 0;
  if (expectBytes != null && size !== expectBytes) {
    try { await zcE2bRun(env, ws, 'rm -f -- ' + zcShq(tmp), { cwd: root, timeoutMs: 20000 }); } catch (e) { /* ignore */ }
    return { ok: false, error: '写入校验失败：期望 ' + expectBytes + ' 字节，实际 ' + size + ' 字节（沙箱可能刚被重建，请重试）' };
  }
  return { ok: true, size: size, chunks: chunks };
}

// ---- 沙箱 HTTP 网关（E2B 通道；子接口与 CloudFS 约定完全一致） ----
async function zcE2bHandle(sub, env, ws, bodyText, request) {
  const cors = zcCorsHeaders();
  const ghToken = env && env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN) : '';
  const __t0 = Date.now();
  const out = function (obj, status) {
    // v2.21.3：响应带上当前沙箱 ID，前端据此发现“沙箱被重建（工作区已清空）”并重新同步本地文件
    // v2.34：另带 fresh（本次请求里新建了沙箱 = 工作区是空的）/ resumed（本次请求里从暂停态唤醒了沙箱 = 文件都在）/ mode（pause = 到期暂停，kill = 到期销毁）
    try {
      const __cur = ZC_E2B_SESS.get(ws);
      if (__cur && __cur.id && obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj.sandboxId = __cur.id;
        if (ZC_E2B_STAT.lastCreatedId === __cur.id && ZC_E2B_STAT.lastCreatedAt >= __t0) obj.fresh = true;
        if (__cur.resumedAt && __cur.resumedAt >= __t0) obj.resumed = true;
        if (__cur.mode) obj.sbxMode = __cur.mode;
      }
    } catch (e) { /* ignore */ }
    let text = JSON.stringify(obj);
    if (ghToken) text = zcScrub(text, ghToken);
    const h = new Headers();
    h.set('Content-Type', 'application/json; charset=utf-8');
    Object.keys(cors).forEach(function (k) { h.set(k, cors[k]); });
    return new Response(text, { status: status || 200, headers: h });
  };
  ws = String(ws || 'main');
  // v2.21.3：浏览器记着上一次的沙箱 ID（x-zc-sbx-id）；本 isolate 内存里没有会话时，优先接管这个沙箱（零存储依赖）
  try {
    const __hint = request && request.headers ? String(request.headers.get('x-zc-sbx-id') || '') : '';
    const __cur = ZC_E2B_SESS.get(ws);
    if (sub !== 'status' && __hint && /^[A-Za-z0-9_-]{8,64}$/.test(__hint) && !(__cur && __cur.id)) await zcE2bAdopt(env, ws, __hint);
  } catch (e) { zcE2bNote('adopt', e && e.message); }
  let body = {};
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (e) { return out({ error: '请求体必须是 JSON' }, 400); }
  }
  try {
    if (sub === 'status') {
      return out({ available: true, backend: 'e2b', template: zcE2bTemplate(env), timeout: zcE2bTtl(env), warm: ZC_E2B_SESS.has(ws), autoPause: zcE2bAutoPause(env), maxRunSec: Math.round(zcE2bMaxRunMs(env) / 1000) });
    }
    if (sub === 'ping') {
      const gone = function () { return out({ ok: false, warm: false, gone: true, reason: '沙箱已被平台回收（超过存活时间且没有暂停），下次执行会自动重建' }); };
      let mem = ZC_E2B_SESS.get(ws), resumed = false;
      if (!(mem && mem.id)) {
        // v2.21.3：请求可能落在另一个 isolate 上（内存里没有会话）—— 从 Cache API / KV 找回原沙箱，只查询、不新建
        let saved = await zcE2bCacheGet(ws);
        if (!(saved && saved.id)) {
          try { const raw = zcStoreReady(env) ? await zcKV(env).get(ZC_E2B_KV_PREFIX + ws) : null; if (raw) saved = JSON.parse(raw); } catch (e) { /* ignore */ }
        }
        if (saved && saved.id) {
          const ix0 = await zcE2bInfoEx(env, saved.id);   // v2.34：暂停态在这里被唤醒
          if (ix0.state === 'gone') return gone();
          if (ix0.state === 'unknown') return out({ ok: true, warm: false, unknown: true, backend: 'e2b', reason: '暂时无法确认沙箱状态（平台接口抖动），稍后自动重试' });
          const info0 = ix0.info; resumed = !!ix0.resumed;
          mem = { id: String(info0.sandboxID), token: String(info0.envdAccessToken || ''), root: saved.root || '', at: Date.now(), ws: ws, ttl: zcE2bTtl(env), mode: saved.mode || '', runStart: resumed ? Date.now() : (saved.runStart || Date.now()) };
          if (resumed) mem.resumedAt = Date.now();
          ZC_E2B_SESS.set(ws, mem);
        }
      }
      if (mem && mem.id) {
        const ix = resumed ? { state: 'alive', info: { envdAccessToken: mem.token, endAt: '' }, resumed: true } : await zcE2bInfoEx(env, mem.id);
        if (ix.state === 'gone') { ZC_E2B_SESS.delete(ws); return gone(); }
        if (ix.state === 'unknown') return out({ ok: true, warm: true, unknown: true, backend: 'e2b', reason: '暂时无法确认沙箱状态（平台接口抖动），稍后自动重试' });   // 不报「已过期」：状态不明 ≠ 丢了
        const info = ix.info;
        if (ix.resumed && !resumed) { mem.resumedAt = Date.now(); mem.runStart = Date.now(); resumed = true; await zcE2bRemember(env, mem); }
        if (info && info.envdAccessToken) mem.token = String(info.envdAccessToken);
        if (body && body.keepalive) {
          await zcE2bExtend(env, mem, 0);   // 心跳：续期（20 秒内重复调用会被节流）
          if (await zcE2bMaybeCycle(env, mem, false)) resumed = true;   // 连续运行快到上限：趁心跳（命令之间）做一次「暂停→恢复」
        }
        return out({ ok: true, warm: true, backend: 'e2b', endAt: (info && info.endAt) || '', resumed: resumed, autoPause: mem.mode !== 'kill', runAgeSec: Math.round((Date.now() - (mem.runStart || mem.at || Date.now())) / 1000) });
      }
      return out({ ok: true, warm: false, backend: 'e2b' });
    }
    if (sub === 'debug') {
      const mem = ZC_E2B_SESS.get(ws);
      const cache = await zcE2bCacheGet(ws);
      let kvRaw = null;
      try { kvRaw = zcStoreReady(env) ? await zcKV(env).get(ZC_E2B_KV_PREFIX + ws) : null; } catch (e) { kvRaw = 'ERR: ' + (e && e.message); }
      const probeId = (mem && mem.id) || (cache && cache.id);
      let probe = null;
      if (probeId) {
        const r = await zcE2bApi(env, '/sandboxes/' + encodeURIComponent(probeId), 'GET');
        probe = { id: probeId, ok: r.ok, status: r.status, state: (r.json && r.json.state) || '', endAt: (r.json && r.json.endAt) || '', hasToken: !!(r.json && r.json.envdAccessToken), err: r.ok ? '' : zcE2bApiMsg(r) };
      }
      return out({
        ok: true,
        cfg: { template: zcE2bTemplate(env), timeout: zcE2bTtl(env), internet: zcE2bNet(env), autoPause: zcE2bAutoPause(env), maxRunSec: Math.round(zcE2bMaxRunMs(env) / 1000), keyLen: zcE2bKey(env).length, api: ZC_E2B_API, envd: ZC_E2B_ENVD, ws: ws },
        memory: mem ? { id: mem.id, root: mem.root, at: mem.at, ttl: mem.ttl, mode: mem.mode || '', runStart: mem.runStart || 0 } : null,
        cache: cache ? Object.assign({}, cache, { token: cache.token ? '***' : '' }) : null,
        kv: kvRaw ? String(kvRaw).replace(/("token"\s*:\s*")[^"]*(")/g, '$1***$2') : null,
        probe: probe,
        stats: ZC_E2B_STAT,
        cachesApi: (typeof caches !== 'undefined' && !!caches.default)
      });
    }
    if (sub === 'exec') {
      const cmd = String(body.command == null ? '' : body.command);
      if (!cmd.trim()) return out({ error: '命令不能为空' }, 400);
      const rel = zcSbxRel(body.cwd || '');
      const to = Math.max(1000, Math.min(900000, parseInt(body.timeout, 10) || 120000));
      const sess = await zcE2bSessionGet(env, ws, false);
      ZC_E2B_STAT.execs++;
      const root = await zcE2bRoot(env, sess);
      const prefix = rel ? ('cd ' + zcShq(root + '/' + rel) + ' 2>/dev/null || cd ' + zcShq(root) + '; ') : '';
      const r = await zcE2bRun(env, ws, prefix + zcE2bCmd(sess, cmd), { cwd: root, timeoutMs: to + 15000 });
      return out({ ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, durationMs: r.durationMs, backend: 'e2b' });
    }
    if (sub === 'list') {
      const rel = zcSbxRel(body.path || '');
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const abs = rel ? (root + '/' + rel) : root;
      const script = 'cd ' + zcShq(abs) + ' 2>/dev/null || { echo __ZC_NODIR__; exit 0; }\n'
        + 'find . -mindepth 1 -maxdepth 1 -printf \'%y\\t%s\\t%f\\n\' 2>/dev/null | head -n ' + (ZC_E2B_LIST_MAX + 1);
      const r = await zcE2bRun(env, ws, script, { cwd: root, timeoutMs: 60000 });
      const text = String(r.stdout || '');
      if (text.indexOf('__ZC_NODIR__') >= 0) return out({ error: '目录不存在：/' + (rel || ''), available: true }, 404);
      const lines = text.split('\n').filter(function (x) { return x.trim() !== ''; });
      const entries = [];
      for (let i = 0; i < lines.length && entries.length < ZC_E2B_LIST_MAX; i++) {
        const parts = lines[i].split('\t');
        if (parts.length < 3) continue;
        const isDir = parts[0] === 'd';
        const name = parts.slice(2).join('\t');
        entries.push({ name: name, kind: isDir ? 'dir' : 'file', path: rel ? (rel + '/' + name) : name, size: isDir ? 0 : (parseInt(parts[1], 10) || 0) });
      }
      entries.sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
      });
      return out({ available: true, path: rel, entries: entries, truncated: lines.length > ZC_E2B_LIST_MAX });
    }
    if (sub === 'read') {
      const rel = zcSbxRel(body.path || '');
      if (!rel) return out({ error: '缺少文件路径' }, 400);
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const abs = root + '/' + rel;
      const script = 'f=' + zcShq(abs) + '\n'
        + 'if [ ! -e "$f" ]; then echo __ZC_NOENT__; exit 0; fi\n'
        + 'if [ ! -f "$f" ]; then echo __ZC_NOTFILE__; exit 0; fi\n'
        + 'sz=$(stat -c%s "$f" 2>/dev/null || echo 0)\n'
        + 'n=$(head -c 8192 "$f" | wc -c)\n'
        + 'n0=$(head -c 8192 "$f" | tr -d "\\000" | wc -c)\n'
        + 'if [ "$n" = "$n0" ]; then bin=0; else bin=1; fi\n'
        + 'echo "__ZC_SZ__$sz"\n'
        + 'echo "__ZC_BIN__$bin"\n'
        + 'echo "__ZC_SHA__$(head -c ' + ZC_E2B_MAX_READ + ' "$f" | sha1sum | cut -d" " -f1)"\n'
        + 'head -c ' + ZC_E2B_MAX_READ + ' "$f" | base64 -w 0 2>/dev/null || head -c ' + ZC_E2B_MAX_READ + ' "$f" | base64\n'
      // v2.21.3：sha1 并进同一次执行（原先要 2 次沙箱调用，拉回 N 个文件就是 2N 次请求）
      const r = await zcE2bRun(env, ws, script, { cwd: root, timeoutMs: 60000 });
      const text = String(r.stdout || '');
      const __mSha = text.match(/__ZC_SHA__([0-9a-f]+)/);
      const sha1 = __mSha ? __mSha[1] : '';
      if (text.indexOf('__ZC_NOENT__') >= 0) return out({ error: '文件不存在：' + rel }, 404);
      if (text.indexOf('__ZC_NOTFILE__') >= 0) return out({ error: '目标不是文件（可能是目录）：' + rel }, 400);
      const mSz = text.match(/__ZC_SZ__(\d+)/);
      const mBin = text.match(/__ZC_BIN__(\d)/);
      const size = mSz ? (parseInt(mSz[1], 10) || 0) : 0;
      const isBin = mBin ? mBin[1] === '1' : false;
      const cut = text.lastIndexOf('\n');
      const b64 = (cut >= 0 ? text.slice(cut + 1) : text).replace(/[^A-Za-z0-9+/=]/g, '');
      if (isBin) return out({ binary: true, size: size, text: '', path: rel, backend: 'e2b' });
      const bytes = zcE2bB64Dec(b64);
      return out({ text: zcBytesText(bytes), size: size, binary: false, truncated: size > bytes.length, sha1: sha1, b64len: b64.length, path: rel, backend: 'e2b' });
    }
    if (sub === 'readchunk') {
      // v2.22：分块读取（二进制安全）。旧的 read 受“单次执行输出上限 20 万字符”限制，base64 后最多只能读回约 150KB，
      // 更大的文件会被前端判成“读被截断”而无法拉回本地；这里一次只读一块（offset / length），由前端分多次拼接并校验。
      const rel = zcSbxRel(body.path || '');
      if (!rel) return out({ error: '缺少文件路径' }, 400);
      const off = Math.max(0, parseInt(body.offset, 10) || 0);
      const want = Math.max(1, Math.min(ZC_E2B_CHUNK, parseInt(body.length, 10) || ZC_E2B_CHUNK));
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const abs = root + '/' + rel;
      const script = 'f=' + zcShq(abs) + '\n'
        + 'if [ ! -e "$f" ]; then echo __ZC_NOENT__; exit 0; fi\n'
        + 'if [ ! -f "$f" ]; then echo __ZC_NOTFILE__; exit 0; fi\n'
        + 'echo "__ZC_SZ__$(stat -c%s "$f" 2>/dev/null || echo 0)"\n'
        + (off === 0 ? 'echo "__ZC_SHA__$(sha1sum "$f" 2>/dev/null | cut -d" " -f1)"\n' : '')
        + 'printf "__ZC_B64__"\n'
        + 'tail -c +' + (off + 1) + ' "$f" 2>/dev/null | head -c ' + want + ' | base64 -w 0 2>/dev/null\n';
      const r = await zcE2bRun(env, ws, script, { cwd: root, timeoutMs: 60000 });
      const text = String(r.stdout || '');
      if (text.indexOf('__ZC_NOENT__') >= 0) return out({ error: '文件不存在：' + rel }, 404);
      if (text.indexOf('__ZC_NOTFILE__') >= 0) return out({ error: '目标不是文件（可能是目录）：' + rel }, 400);
      const mSz = text.match(/__ZC_SZ__(\d+)/);
      const mSha = text.match(/__ZC_SHA__([0-9a-f]+)/);
      const mB = text.match(/__ZC_B64__([A-Za-z0-9+/=]*)/);
      const size = mSz ? (parseInt(mSz[1], 10) || 0) : 0;
      const b64 = mB ? mB[1] : '';
      const pad = b64.slice(-2) === '==' ? 2 : (b64.slice(-1) === '=' ? 1 : 0);
      const rawLen = (b64.length % 4 === 0) ? (b64.length / 4 * 3 - pad) : -1;
      const expect = Math.max(0, Math.min(want, size - off));
      if (rawLen !== expect) return out({ error: '分块读取不完整（沙箱输出被截断，或文件在读取期间被修改）：' + rel + ' @' + off }, 502);
      return out({ ok: true, path: rel, size: size, offset: off, len: rawLen, b64: b64, sha1: mSha ? mSha[1] : '', backend: 'e2b' });
    }
    if (sub === 'readmany') {
      // v2.30.4：批量读取多个小文件（一次沙箱执行读回一批，二进制安全，逐个文件带大小 + SHA-1）。
      // 旧的拉回逐文件调用 readchunk：200 个文件 = 200+ 次沙箱往返，既慢又容易撞 SEC_RATE 限流（429 重试 + 退避能拖到十几分钟，
      // 界面上却一个文件也看不到）。现在一批最多 60 个文件、原始字节合计 ≤ ZC_E2B_CHUNK，输出始终低于 ZC_E2B_MAX_OUT。
      const rawList = Array.isArray(body.paths) ? body.paths : [];
      if (!rawList.length) return out({ error: '缺少 paths' }, 400);
      if (rawList.length > 60) return out({ error: '一次最多读取 60 个文件，请分批' }, 400);
      const rels = [];
      for (let i = 0; i < rawList.length; i++) { const rr = zcSbxRel(rawList[i] || ''); if (!rr) return out({ error: '第 ' + (i + 1) + ' 个路径无效' }, 400); rels.push(rr); }
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const budget = ZC_E2B_CHUNK;
      const sh = ['tot=0'];
      rels.forEach(function (rr) {
        sh.push('f=' + zcShq(root + '/' + rr));
        sh.push('if [ ! -e "$f" ]; then echo "__ZC_X__"');
        sh.push('elif [ ! -f "$f" ]; then echo "__ZC_D__"');
        sh.push('else sz=$(stat -c%s "$f" 2>/dev/null || echo 0)');
        sh.push('  if [ "$sz" -gt ' + budget + ' ]; then echo "__ZC_BIG__$sz"');
        sh.push('  elif [ $((tot + sz)) -gt ' + budget + ' ]; then echo "__ZC_DEFER__$sz"');
        sh.push('  else tot=$((tot + sz)); printf "__ZC_F__%s\\t%s\\t" "$sz" "$(sha1sum "$f" 2>/dev/null | cut -d" " -f1)"; base64 -w 0 "$f" 2>/dev/null; printf "\\n"; fi');
        sh.push('fi');
      });
      const r = await zcE2bRun(env, ws, sh.join('\n'), { cwd: root, timeoutMs: 60000 });
      const lines = String(r.stdout || '').split('\n').filter(function (x) { return x.indexOf('__ZC_') === 0; });
      if (lines.length !== rels.length) return out({ error: '批量读取不完整（沙箱输出被截断或执行异常）：期望 ' + rels.length + ' 条，实际 ' + lines.length + ' 条' }, 502);
      const results = lines.map(function (ln, i) {
        const rr = rels[i];
        if (ln.indexOf('__ZC_X__') === 0) return { path: rr, st: 'missing' };
        if (ln.indexOf('__ZC_D__') === 0) return { path: rr, st: 'notfile' };
        let m = ln.match(/^__ZC_BIG__(\d+)/);
        if (m) return { path: rr, st: 'big', size: parseInt(m[1], 10) || 0 };
        m = ln.match(/^__ZC_DEFER__(\d+)/);
        if (m) return { path: rr, st: 'defer', size: parseInt(m[1], 10) || 0 };
        const parts = ln.slice(8).split('\t');
        const size = parseInt(parts[0], 10) || 0;
        const sha1 = parts[1] || '';
        const b64 = (parts[2] || '').replace(/[^A-Za-z0-9+/=]/g, '');
        const pad = b64.slice(-2) === '==' ? 2 : (b64.slice(-1) === '=' ? 1 : 0);
        const rawLen = (b64.length % 4 === 0) ? (b64.length / 4 * 3 - pad) : -1;
        if (rawLen !== size) return { path: rr, st: 'bad', size: size };
        return { path: rr, st: 'ok', size: size, sha1: sha1, b64: b64 };
      });
      return out({ ok: true, results: results, backend: 'e2b' });
    }
    if (sub === 'write') {
      const rel = zcSbxRel(body.path || '');
      if (!rel) return out({ error: '缺少文件路径' }, 400);
      const content = String(body.content == null ? '' : body.content);
      if (content.length > ZC_E2B_WRITE_MAX) return out({ error: '内容过大（上限 ' + ZC_E2B_WRITE_MAX + ' 字符）' }, 413);
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const abs = root + '/' + rel;
      const bytes = new TextEncoder().encode(content);
      const w = await zcE2bWriteB64(env, ws, root, abs, zcE2bB64Enc(bytes), bytes.length);
      if (!w.ok) return out({ error: w.error }, 500);
      return out({ ok: true, path: rel, size: w.size, chunks: w.chunks, backend: 'e2b' });
    }
    if (sub === 'writemany') {
      // v2.21.3：批量写入 —— 小文件合并成一条脚本（一次沙箱执行写多个文件），大文件走分段；逐个文件返回结果
      const list = Array.isArray(body.files) ? body.files : [];
      if (!list.length) return out({ error: '缺少 files' }, 400);
      if (list.length > 60) return out({ error: '一次最多写入 60 个文件，请分批' }, 400);
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const results = [];
      const small = [], big = [];
      for (let i = 0; i < list.length; i++) {
        const f = list[i] || {};
        let rel = '';
        try { rel = zcSbxRel(f.path || ''); } catch (e) { results[i] = { path: String(f.path || ''), ok: false, error: String((e && e.message) || e) }; continue; }
        if (!rel) { results[i] = { path: '', ok: false, error: '缺少文件路径' }; continue; }
        const content = String(f.content == null ? '' : f.content);
        if (content.length > ZC_E2B_WRITE_MAX) { results[i] = { path: rel, ok: false, error: '内容过大（上限 ' + ZC_E2B_WRITE_MAX + ' 字符）' }; continue; }
        const bytes = new TextEncoder().encode(content);
        const abs = root + '/' + rel;
        const item = { i: i, rel: rel, abs: abs, dir: abs.lastIndexOf('/') > 0 ? abs.slice(0, abs.lastIndexOf('/')) : root, tmp: abs + '.zc-tmp', b64: zcE2bB64Enc(bytes), bytes: bytes.length };
        results[i] = { path: rel, ok: false, error: '未执行' };
        (item.b64.length <= 40000 ? small : big).push(item);
      }
      let group = [], glen = 0;
      const flush = async function () {
        if (!group.length) return;
        let script = '';
        group.forEach(function (it) {
          script += '( mkdir -p ' + zcShq(it.dir) + ' && printf %s ' + zcShq(it.b64) + ' | base64 -d > ' + zcShq(it.tmp) + ' && mv -f ' + zcShq(it.tmp) + ' ' + zcShq(it.abs) + ' && [ "$(stat -c%s ' + zcShq(it.abs) + ')" = "' + it.bytes + '" ] && echo "__ZCW_OK_' + it.i + '_" ) 2>&1 || echo "__ZCW_ERR_' + it.i + '_"\n';
        });
        let r = null, err = '';
        try { r = await zcE2bRun(env, ws, script, { cwd: root, timeoutMs: 120000 }); } catch (e) { err = String((e && e.message) || e); }
        const text = r ? String(r.stdout || '') : '';
        group.forEach(function (it) {
          if (text.indexOf('__ZCW_OK_' + it.i + '_') >= 0) results[it.i] = { path: it.rel, ok: true, size: it.bytes };
          else results[it.i] = { path: it.rel, ok: false, error: err || ('写入失败：' + text.replace(/__ZCW_(OK|ERR)_\d+_/g, '').trim().slice(-160)) };
        });
        group = []; glen = 0;
      };
      for (let k = 0; k < small.length; k++) {
        if (group.length && glen + small[k].b64.length > 90000) await flush();
        group.push(small[k]); glen += small[k].b64.length;
      }
      await flush();
      for (let k = 0; k < big.length; k++) {
        const it = big[k];
        try {
          const w = await zcE2bWriteB64(env, ws, root, it.abs, it.b64, it.bytes);
          results[it.i] = w.ok ? { path: it.rel, ok: true, size: w.size } : { path: it.rel, ok: false, error: w.error };
        } catch (e) { results[it.i] = { path: it.rel, ok: false, error: String((e && e.message) || e) }; }
      }
      const okN = results.filter(function (x) { return x && x.ok; }).length;
      return out({ ok: okN === results.length, written: okN, total: results.length, results: results, backend: 'e2b' });
    }
    if (sub === 'mkdir') {
      const rel = zcSbxRel(body.path || '');
      if (!rel) return out({ error: '缺少目录路径' }, 400);
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const r = await zcE2bRun(env, ws, 'mkdir -p ' + zcShq(root + '/' + rel), { cwd: root, timeoutMs: 60000 });
      if (r.exitCode !== 0) return out({ error: '创建目录失败：' + String(r.stderr || '').slice(0, 200) }, 500);
      return out({ ok: true, path: rel, backend: 'e2b' });
    }
    if (sub === 'delete') {
      const rel = zcSbxRel(body.path || '');
      if (!rel) return out({ error: '缺少文件路径（不允许删除工作区根目录）' }, 400);
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const r = await zcE2bRun(env, ws, 'rm -rf -- ' + zcShq(root + '/' + rel), { cwd: root, timeoutMs: 60000 });
      if (r.exitCode !== 0) return out({ error: '删除失败：' + String(r.stderr || '').slice(0, 200) }, 500);
      return out({ ok: true, path: rel, backend: 'e2b' });
    }
    if (sub === 'search') {
      const q = String(body.query == null ? '' : body.query).trim();
      if (!q) return out({ error: '搜索内容不能为空' }, 400);
      const rel = zcSbxRel(body.path || '');
      const mode = body.mode === 'content' ? 'content' : 'name';
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const abs = rel ? (root + '/' + rel) : root;
      const head = 'cd ' + zcShq(abs) + ' 2>/dev/null || cd ' + zcShq(root) + '\n';
      const script = mode === 'name'
        ? head + 'find . -mindepth 1 -maxdepth 4 -print 2>/dev/null | LC_ALL=C grep -F -i -m 200 -- ' + zcShq(q) + ' | sed \'s|^\\./||\''
        : head + 'LC_ALL=C grep -R -n -I -F -m 1 --exclude-dir=.git -- ' + zcShq(q) + ' . 2>/dev/null | head -n 80';
      const r = await zcE2bRun(env, ws, script, { cwd: root, timeoutMs: 120000 });
      const lines = String(r.stdout || '').split('\n').filter(function (x) { return x.trim() !== ''; });
      const results = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (mode === 'name') { results.push({ path: line, size: 0 }); continue; }
        const m = line.match(/^\.\/(.*?):(\d+):([\s\S]*)$/);
        if (m) results.push({ path: m[1], line: parseInt(m[2], 10) || 0, snippet: String(m[3]).slice(0, 300) });
      }
      return out({ results: results, truncated: lines.length >= (mode === 'name' ? 200 : 80), mode: mode, query: q, backend: 'e2b' });
    }
    if (sub === 'download') {
      let target = null;
      try { target = new URL(String(body.url || '')); } catch (e) { return out({ error: '下载地址不是合法的 URL' }, 400); }
      let rel = zcSbxRel(body.path || '');
      if (!rel) {
        let base = target.pathname.split('/').filter(Boolean).pop() || 'download.bin';
        try { base = decodeURIComponent(base); } catch (e) { /* ignore */ }
        rel = String(base).replace(/[^A-Za-z0-9._-]+/g, '_') || 'download.bin';
      }
      const sess = await zcE2bSessionGet(env, ws, false);
      const root = await zcE2bRoot(env, sess);
      const abs = root + '/' + rel;
      const u = zcShq(target.toString());
      const script = 'd=' + zcShq(abs) + '\n'
        + 'mkdir -p "$(dirname "$d")"\n'
        + 'if command -v curl >/dev/null 2>&1; then curl -fL --max-time 150 -o "$d" ' + u + ';\n'
        + 'elif command -v wget >/dev/null 2>&1; then wget -q -T 150 -O "$d" ' + u + ';\n'
        + 'else python3 -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" ' + u + ' "$d"; fi 2>&1 | tail -n 5\n'
        + 'stat -c%s "$d" 2>/dev/null || echo 0';
      const r = await zcE2bRun(env, ws, script, { cwd: root, timeoutMs: 180000 });
      const lines2 = String(r.stdout || '').trim().split('\n');
      const sizeText = String(lines2[lines2.length - 1] || '0').trim();
      const size = parseInt(sizeText, 10) || 0;
      if (r.exitCode !== 0 || !size) {
        return out({ error: '下载失败：' + (String(r.stderr || '').trim() || String(r.stdout || '').trim() || '未知原因').slice(0, 300) }, 502);
      }
      return out({ ok: true, path: rel, size: size, url: target.toString(), backend: 'e2b' });
    }
    return out({ error: '未知的沙箱接口: ' + sub }, 404);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return out({ error: 'E2B 云端沙箱错误：' + msg.slice(0, 300) }, 502);
  }
}

async function zcHandleSandbox(request, env) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);

  const url = new URL(request.url);
  const sub = url.pathname.slice(ZC_SBX_PATH.length).replace(/^\//, '');
  const ns = env && env.SANDBOX;
  const __e2b = zcE2bReady(env);
  if (sub === 'status') {
    return zcJson({ available: !!(ns || __e2b), backend: __e2b ? 'e2b' : (ns ? 'containers' : 'none'), e2b: __e2b, containers: !!ns, files: __e2b, fileApi: __e2b ? 'envd-rest' : 'none', autoPause: __e2b ? zcE2bAutoPause(env) : false, maxRunSec: __e2b ? Math.round(zcE2bMaxRunMs(env) / 1000) : 0 });
  }
  if (!ns && !__e2b) {
    return zcJson({ error: '未配置云端沙箱：请在 Cloudflare 变量中添加 E2B_API_KEY（推荐：e2b.dev 云端 Linux 沙箱），或在 Workers 版绑定 SANDBOX 容器（Cloudflare Containers）。两者都未配置时云端工作区不可用', available: false }, 501);
  }

  const clientWs = request.headers.get('x-zc-workspace') || 'main';
  if (!zcValidWorkspace(clientWs)) return zcJson({ error: '非法的工作区名称' }, 400);
  // v2.24：工作区按登录身份派生（见 zcSbxResolveWs），不同用户的沙箱/KV/缓存彼此隔离
  const __own = await zcSbxResolveWs(request, env, clientWs);
  if (!__own.ok) return zcJson({ error: '云端沙箱需要登录后使用（已按账号隔离工作区）。请先登录 GitHub 或使用邀请码登录；如为单人自用且已关闭登录，可设置变量 ZC_SBX_ALLOW_ANON=1', code: 'AUTH_REQUIRED' }, 401, { 'x-zc-auth': 'required' });
  const ws = __own.ws;


  let bodyText = '';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    bodyText = await request.text();
    if (bodyText.length > ZC_SBX_MAX_BODY_BYTES) return zcJson({ error: '请求体过大' }, 413);
  }

  // download 的目标地址先在 Worker 侧做 SSRF 校验，再转发给容器执行
  if (sub === 'download') {
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
    let target = null;
    try { target = new URL(String((body && body.url) || '')); } catch (e) { return zcJson({ error: '下载地址不是合法的 URL' }, 400); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return zcJson({ error: '仅支持 http/https 下载地址' }, 400);
    if (zcIsBlockedHost(target.hostname)) return zcJson({ error: '不允许下载内网或本机地址的文件' }, 400);
    if (!zcHostAllowed(target.hostname, env)) return zcJson({ error: '该域名不在白名单内（ZC_RELAY_ALLOW）' }, 403);
    body.url = target.toString();
    bodyText = JSON.stringify(body);
  }

  if (__e2b) return await zcE2bHandle(sub, env, ws, bodyText, request);

  const h = new Headers();
  h.set('Content-Type', 'application/json');
  const ghToken = env && env.GITHUB_TOKEN ? String(env.GITHUB_TOKEN) : '';
  if (ghToken && (sub === 'exec' || sub === 'download')) h.set('x-zc-gh-token', ghToken);

  const stub = ns.get(ns.idFromName('zc-' + ws));
  const fwd = new Request('https://zc-sandbox.internal/__sbx__/' + sub, {
    method: request.method === 'GET' ? 'GET' : 'POST',
    headers: h,
    body: request.method === 'GET' ? undefined : bodyText
  });

  let resp;
  try { resp = await stub.fetch(fwd); }
  catch (e) { return zcJson({ error: '云端沙箱请求失败：' + (e && e.message ? e.message : String(e)) }, 502); }

  const h2 = new Headers(resp.headers);
  Object.keys(cors).forEach((k) => h2.set(k, cors[k]));
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ghToken && ct.indexOf('json') >= 0) {
    // JSON 响应整体脱敏后再返回（exec / download 可能回显凭证）
    const text = zcScrub(await resp.text(), ghToken);
    return new Response(text, { status: resp.status, statusText: resp.statusText, headers: h2 });
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h2 });
}

// （Pages 版：Durable Object / Containers 为 Workers 专属绑定，本构建不包含其实现）

// ---- Web 工具：web_fetch（SSRF 防护 + 正文提取） ----
function zcHtmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/ul|\/ol)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'");
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// v2.21.3：github.com 的网页 URL → 直读原文（blob → raw.githubusercontent.com；仓库首页 → README 原文），
// 避免把 GitHub 的 HTML 页面外壳当“代码”读给模型；raw 域名不占 GitHub API 额度
function zcWebCandidates(target) {
  const out = [];
  try {
    if (target.hostname === 'github.com') {
      const seg = target.pathname.split('/').filter(Boolean);
      if (seg.length >= 5 && seg[2] === 'blob') {
        out.push('https://raw.githubusercontent.com/' + seg[0] + '/' + seg[1] + '/' + seg.slice(3).join('/'));
      } else if (seg.length === 2 || (seg.length >= 4 && seg[2] === 'tree' && seg.length === 4)) {
        const ref = seg.length === 2 ? 'HEAD' : seg[3];
        ['README.md', 'readme.md', 'README.rst', 'README'].forEach(function (n) { out.push('https://raw.githubusercontent.com/' + seg[0] + '/' + seg[1] + '/' + ref + '/' + n); });
      }
    }
  } catch (e) { /* ignore */ }
  out.push(target.toString());
  return out;
}
/* v2.34.1：按响应头 / <meta charset> 选编码解码（旧版一律按 UTF-8，GBK / Big5 的老网站会变成乱码） */
function zcDecodeBody(ab, ct) {
  let cs = '';
  const m1 = /charset=["']?([\w-]+)/i.exec(ct || '');
  if (m1) cs = m1[1];
  if (!cs && /html|xml/i.test(ct || '')) {
    const head = new TextDecoder('latin1').decode(ab.slice(0, 4096));
    const m2 = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
    if (m2) cs = m2[1];
  }
  cs = String(cs || 'utf-8').toLowerCase();
  if (cs === 'utf8') cs = 'utf-8';
  try { return new TextDecoder(cs).decode(ab); } catch (e) { return new TextDecoder('utf-8').decode(ab); }
}
function zcHtmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || '').slice(0, 200000));
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, 200);
}
async function zcWebFetch(request, env) {
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
  let target;
  try { target = new URL(String((body && body.url) || '')); } catch (e) { return zcJson({ error: '目标地址不是合法的 URL' }, 400); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return zcJson({ error: '仅支持 http/https 地址' }, 400);
  if (zcIsBlockedHost(target.hostname)) return zcJson({ error: '不允许访问内网、本机或 Cloudflare 内部地址' }, 400);
  if (!zcHostAllowed(target.hostname, env)) return zcJson({ error: '该域名不在白名单内（ZC_RELAY_ALLOW）' }, 403);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let resp = null;
  const cands = zcWebCandidates(target);
  try {
    for (let ci = 0; ci < cands.length; ci++) {
      resp = await fetch(cands[ci], {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZC-GURA-Agent/2.1)', 'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*' },
        redirect: 'follow', signal: ctrl.signal
      });
      if (resp.ok || ci === cands.length - 1) { if (ci < cands.length - 1 || cands[ci] !== target.toString()) target = new URL(cands[ci]); break; }
      try { await resp.body.cancel(); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    clearTimeout(timer);
    return zcJson({ error: '网页读取失败：' + (e && e.name === 'AbortError' ? '请求超时' : (e && e.message ? e.message : String(e))) }, 502);
  }
  clearTimeout(timer);

  let finalUrl = target.toString();
  try { if (resp.url) finalUrl = resp.url; } catch (e) { /* ignore */ }
  try {
    const fu = new URL(finalUrl);
    if (zcIsBlockedHost(fu.hostname)) { try { await resp.body.cancel(); } catch (e) { /* ignore */ } return zcJson({ error: '重定向目标为内网地址，已拦截' }, 400); }
  } catch (e) { /* ignore */ }

  const ct = resp.headers.get('content-type') || '';
  const buf = await resp.arrayBuffer();
  let text = zcDecodeBody(buf.slice(0, ZC_WEB_MAX_BYTES), ct);
  let truncated = buf.byteLength > ZC_WEB_MAX_BYTES;
  const title = /html|xml/i.test(ct) ? zcHtmlTitle(text) : '';
  /* v2.34.1：聊天模式的「抓取信息」工具要在浏览器里解析 DOM（链接 / 表格 / 选择器），所以允许返回原始 HTML（上限 70 万字符；仍然只在浏览器的 DOMParser 里解析，不会执行脚本） */
  if (body && body.html === true && /html|xml/i.test(ct)) {
    if (text.length > 700000) { text = text.slice(0, 700000); truncated = true; }
    return zcJson({ status: resp.status, url: finalUrl, contentType: ct, title: title, html: text, truncated: truncated });
  }
  if (/html|xml/i.test(ct)) text = zcHtmlToText(text);
  if (text.length > 120000) { text = text.slice(0, 120000); truncated = true; }
  return zcJson({ status: resp.status, url: finalUrl, contentType: ct, title: title, text: text, truncated: truncated });
}

// ---- Web 工具：web_search（可配置供应商，无 Key 时走免费兜底） ----
function zcParseDuckLite(html) {
  const out = [];
  const re = /<a[^>]+href="([^"]*uddg=[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const mm = /[?&]uddg=([^&]+)/.exec(m[1]);
    if (!mm) continue;
    let u = '';
    try { u = decodeURIComponent(mm[1]); } catch (e) { continue; }
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!u || !title || /^https?:\/\/duckduckgo\.com/.test(u)) continue;
    out.push({ title: title, url: u, snippet: '' });
  }
  const snips = [];
  const re2 = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = re2.exec(html)) && snips.length < 20) snips.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300));
  out.forEach((r, i) => { r.snippet = snips[i] || ''; });
  return out;
}

/* v2.34.1：Bing 网页结果解析（免费兜底的第二道；Bing 会把结果链接包成 bing.com/ck/a?...&u=a1<base64url>，这里还原成真实地址） */
function zcBingRealUrl(href) {
  let h = String(href || '').replace(/&amp;/g, '&');
  try {
    const u = new URL(h, 'https://www.bing.com');
    if (/(^|\.)bing\.com$/i.test(u.hostname) && /^\/ck\/a/.test(u.pathname)) {
      const enc = u.searchParams.get('u') || '';
      if (/^a1/.test(enc)) {
        const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const real = new TextDecoder('utf-8').decode(bytes);
        if (/^https?:\/\//i.test(real)) return real;
      }
      return '';
    }
    return /^https?:/i.test(u.protocol) ? u.toString() : '';
  } catch (e) { return ''; }
}
function zcParseBing(html) {
  const out = [];
  const re = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const blk = m[1];
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(blk);
    if (!a) continue;
    const url = zcBingRealUrl(a[1]);
    const title = a[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;
    const sp = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(blk);
    const snippet = sp ? sp[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    out.push({ title: title, url: url, snippet: snippet });
  }
  return out;
}

async function zcWebSearch(request, env) {
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
  const q = String((body && body.query) || '').trim();
  if (!q) return zcJson({ error: '缺少 query 参数' }, 400);
  const count = Math.max(1, Math.min(15, parseInt((body && body.count) || 8, 10) || 8));

  if (env && env.TAVILY_API_KEY) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: q, max_results: count })
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && Array.isArray(j.results)) {
        return zcJson({ provider: 'tavily', results: j.results.map((it) => ({ title: it.title || '', url: it.url || '', snippet: String(it.content || '').slice(0, 300) })) });
      }
    } catch (e) { /* 继续尝试下一个供应商 */ }
  }
  if (env && env.BRAVE_SEARCH_KEY) {
    try {
      const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + count, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': env.BRAVE_SEARCH_KEY }
      });
      const j = await r.json().catch(() => null);
      const arr = j && j.web && j.web.results;
      if (r.ok && Array.isArray(arr)) {
        return zcJson({ provider: 'brave', results: arr.map((it) => ({ title: it.title || '', url: it.url || '', snippet: String(it.description || '').slice(0, 300) })) });
      }
    } catch (e) { /* 继续 */ }
  }
  if (env && env.SEARCH_API_URL) {
    try {
      const u = String(env.SEARCH_API_URL).replace('{q}', encodeURIComponent(q));
      const uh = new URL(u);
      if (!zcIsBlockedHost(uh.hostname)) {
        const h = { 'Accept': 'application/json' };
        if (env.SEARCH_API_KEY) h['Authorization'] = 'Bearer ' + env.SEARCH_API_KEY;
        const r = await fetch(u, { headers: h });
        const j = await r.json().catch(() => null);
        const arr = Array.isArray(j) ? j : (j && (j.results || j.data || j.items));
        if (r.ok && Array.isArray(arr)) {
          return zcJson({ provider: 'custom', results: arr.slice(0, count).map((it) => ({ title: it.title || it.name || '', url: it.url || it.link || '', snippet: String(it.snippet || it.content || it.description || '').slice(0, 300) })) });
        }
      }
    } catch (e) { /* 继续 */ }
  }
  // 免费兜底（无 Key，稳定性一般）：先 DuckDuckGo Lite；没拿到结果（被验证码拦下 / 空页）再试 Bing 网页（v2.34.1）
  let ddgNote = '';
  try {
    const r = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZC-GURA-Agent/2.1)', 'Accept': 'text/html' }
    });
    if (r.ok) {
      const results = zcParseDuckLite(await r.text()).slice(0, count);
      if (results.length) return zcJson({ provider: 'duckduckgo-lite', results: results, note: '' });
      ddgNote = 'DuckDuckGo 免费搜索未返回结果';
    } else ddgNote = 'DuckDuckGo HTTP ' + r.status;
  } catch (e) { ddgNote = 'DuckDuckGo 不可用'; }
  try {
    const r = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-Hans&count=' + count, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    if (r.ok) {
      const results = zcParseBing(await r.text()).slice(0, count);
      if (results.length) return zcJson({ provider: 'bing-web', results: results, note: '' });
    }
  } catch (e) { /* ignore */ }
  if (ddgNote) return zcJson({ provider: 'none', results: [], note: ddgNote + '，Bing 也没有返回结果；建议在 Worker Secret 中配置 TAVILY_API_KEY 或 BRAVE_SEARCH_KEY 获得稳定的搜索' });
  return zcJson({ provider: 'none', results: [], note: '搜索暂不可用：可在 Worker Secret 中配置 TAVILY_API_KEY / BRAVE_SEARCH_KEY / SEARCH_API_URL' });
}

// ---- Web 工具：开源平台检索（v2.21.3；GitHub / GitLab / Codeberg / npm，只查公开项目） ----
async function zcOssGet(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, { headers: Object.assign({ 'User-Agent': 'ZC-GURA-Agent/2.21', 'Accept': 'application/json' }, headers || {}), signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { ok: r.ok, status: r.status, json: json, text: text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: '', error: (e && e.name === 'AbortError') ? '请求超时' : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}
async function zcWebOss(request, env) {
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体必须是 JSON' }, 400); }
  const q = String((body && body.query) || '').trim();
  if (!q) return zcJson({ error: '缺少 query 参数' }, 400);
  const count = Math.max(1, Math.min(15, parseInt((body && body.count) || 8, 10) || 8));
  let plat = String((body && body.platform) || 'all').toLowerCase();
  const all = ['github', 'gitlab', 'codeberg', 'npm'];
  const want = plat === 'all' ? all : all.filter(function (x) { return x === plat; });
  if (!want.length) return zcJson({ error: '未知平台：' + plat + '（可选 all / github / gitlab / codeberg / npm）' }, 400);
  const enc = encodeURIComponent(q);
  const jobs = want.map(async function (name) {
    const host = name === 'github' ? 'api.github.com' : (name === 'gitlab' ? 'gitlab.com' : (name === 'codeberg' ? 'codeberg.org' : 'registry.npmjs.org'));
    if (!zcHostAllowed(host, env)) return { name: name, items: [], note: host + ' 不在白名单内（ZC_RELAY_ALLOW）' };
    if (name === 'github') {
      const hdr = zcGhHeaders(env);
      const hasTok = !!hdr['Authorization'];
      // 带 Token 时加 is:public，保证只返回公开仓库，不会把令牌所有者的私有仓库带给模型
      const r = await zcOssGet('https://api.github.com/search/repositories?q=' + encodeURIComponent(q + (hasTok ? ' is:public' : '')) + '&sort=stars&order=desc&per_page=' + count, hdr);
      if (!r.ok) return { name: name, items: [], note: 'GitHub 搜索失败：HTTP ' + (r.status || 0) + ' ' + (r.error || String((r.json && r.json.message) || '').slice(0, 120)) + (hasTok ? '' : '（未配置 GITHUB_TOKEN 时匿名额度很低，配置后更稳定）') };
      return { name: name, items: ((r.json && r.json.items) || []).slice(0, count).map(function (x) { return { platform: 'github', name: x.full_name, url: x.html_url, description: String(x.description || '').slice(0, 200), stars: x.stargazers_count || 0, updated: x.pushed_at || x.updated_at || '', extra: (x.language || '') + (x.license && x.license.spdx_id ? ' · ' + x.license.spdx_id : '') }; }) };
    }
    if (name === 'gitlab') {
      const hdr = env && env.GITLAB_TOKEN ? { 'PRIVATE-TOKEN': String(env.GITLAB_TOKEN) } : {};
      const r = await zcOssGet('https://gitlab.com/api/v4/projects?search=' + enc + '&order_by=star_count&sort=desc&visibility=public&per_page=' + count, hdr);
      if (!r.ok || !Array.isArray(r.json)) return { name: name, items: [], note: 'GitLab 搜索失败：HTTP ' + (r.status || 0) + ' ' + (r.error || '') };
      return { name: name, items: r.json.slice(0, count).map(function (x) { return { platform: 'gitlab', name: x.path_with_namespace, url: x.web_url, description: String(x.description || '').slice(0, 200), stars: x.star_count || 0, updated: x.last_activity_at || '', extra: '' }; }) };
    }
    if (name === 'codeberg') {
      const r = await zcOssGet('https://codeberg.org/api/v1/repos/search?q=' + enc + '&sort=stars&order=desc&limit=' + count, {});
      if (!r.ok || !r.json) return { name: name, items: [], note: 'Codeberg 搜索失败：HTTP ' + (r.status || 0) + ' ' + (r.error || '') };
      return { name: name, items: ((r.json && r.json.data) || []).slice(0, count).map(function (x) { return { platform: 'codeberg', name: x.full_name, url: x.html_url, description: String(x.description || '').slice(0, 200), stars: x.stars_count || 0, updated: x.updated_at || '', extra: x.language || '' }; }) };
    }
    const r = await zcOssGet('https://registry.npmjs.org/-/v1/search?text=' + enc + '&size=' + count, {});
    if (!r.ok || !r.json) return { name: name, items: [], note: 'npm 搜索失败：HTTP ' + (r.status || 0) + ' ' + (r.error || '') };
    return { name: name, items: ((r.json && r.json.objects) || []).slice(0, count).map(function (o) { const x = o.package || {}; return { platform: 'npm', name: x.name + '@' + (x.version || ''), url: (x.links && (x.links.repository || x.links.npm)) || '', description: String(x.description || '').slice(0, 200), stars: 0, updated: x.date || '', extra: 'npm 包；可经 https://cdn.jsdelivr.net/npm/' + x.name + '/ 读取文件' }; }) };
  });
  const done = await Promise.all(jobs.map(function (j) { return j.catch(function (e) { return { name: '?', items: [], note: String((e && e.message) || e) }; }); }));
  const results = [];
  const notes = [];
  done.forEach(function (d) { (d.items || []).forEach(function (it) { results.push(it); }); if (d.note) notes.push(d.note); });
  return zcJson({ provider: 'oss:' + want.join('+'), results: results, notes: notes });
}

// v2.30.4：GitHub 仓库源码包透传（Agent 工具 github_to_local 用）。
// 只做「流式转发 codeload.github.com 的 tar.gz」：Worker 不解压、不 base64，几乎不耗 CPU，一次请求拿到整个仓库；
// 解压 / 筛选 / 写入本地目录都在浏览器里完成。只支持公开仓库，且不附带部署者的 GITHUB_TOKEN（避免经由本站读到私有仓库）。
const ZC_GH_TAR_MAX = 80 * 1024 * 1024;
async function zcWebGhTar(request, env) {
  if (request.method !== 'POST') return zcJson({ error: 'Method Not Allowed' }, 405);
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体不是合法 JSON' }, 400); }
  const repo = String(body.repo || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const m = repo.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:\/|$)/);
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return zcJson({ error: 'repo 必须是 owner/name（或 GitHub 仓库链接）' }, 400);
  const ref = String(body.ref || 'HEAD').trim() || 'HEAD';
  if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(ref) || ref.indexOf('..') >= 0) return zcJson({ error: 'ref（分支 / 标签 / 提交）格式不合法' }, 400);
  const url = 'https://codeload.github.com/' + m[1] + '/' + m[2] + '/tar.gz/' + ref.split('/').map(encodeURIComponent).join('/');
  let r = null;
  try { r = await fetch(url, { headers: { 'User-Agent': 'zc-gura-gh/1.0', 'Accept': '*/*' }, redirect: 'follow' }); }
  catch (e) { return zcJson({ error: '连接 GitHub 失败：' + (e && e.message ? e.message : String(e)) }, 502); }
  if (!r.ok) return zcJson({ error: r.status === 404 ? ('找不到仓库或分支：' + m[1] + '/' + m[2] + '@' + ref + '（仓库不存在、分支名不对，或是私有仓库——本工具只支持公开仓库）') : ('GitHub 返回 HTTP ' + r.status) }, r.status === 404 ? 404 : 502);
  const len = parseInt(r.headers.get('content-length') || '0', 10);
  if (len > ZC_GH_TAR_MAX) return zcJson({ error: '仓库源码包 ' + Math.round(len / 1048576) + 'MB，超过 ' + Math.round(ZC_GH_TAR_MAX / 1048576) + 'MB 上限，请换小一点的仓库' }, 413);
  let seen = 0;
  const cap = new TransformStream({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > ZC_GH_TAR_MAX) { ctl.error(new Error('源码包超过上限')); return; }
      ctl.enqueue(chunk);
    }
  });
  return new Response(r.body.pipeThrough(cap), { status: 200, headers: Object.assign({ 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store', 'X-ZC-Gh-Repo': m[1] + '/' + m[2], 'X-ZC-Gh-Ref': ref }, zcCorsHeaders()) });
}

async function zcHandleWeb(request, env) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const url = new URL(request.url);
  const sub = url.pathname.slice(ZC_WEB_PATH.length).replace(/^\//, '');
  if (sub === 'fetch') return zcWebFetch(request, env);
  if (sub === 'search') return zcWebSearch(request, env);
  if (sub === 'oss') return zcWebOss(request, env);
  if (sub === 'ghtar') return zcWebGhTar(request, env);
  return zcJson({ error: '未知的 Web 接口: ' + sub }, 404);
}

// ---------------------------------------------------------------------------
// 2c) 脚本远程执行（/__zc_run__）：转发到 Piston 公共执行沙箱
//     真实容器执行（非模拟），单文件部署即可用；可用 PISTON_URL 换自建实例。
// ---------------------------------------------------------------------------
const ZC_RUN_LANGS = {
  python:     { piston: 'python',     file: 'main.py',   judge0: 109, wandbox: 'cpython-3.13.8',   ver: '3.13' },
  javascript: { piston: 'javascript', file: 'main.js',   judge0: 102, wandbox: 'nodejs-20.17.0',   ver: 'Node 20' },
  typescript: { piston: 'typescript', file: 'main.ts',   judge0: 101, wandbox: 'typescript-5.6.2', ver: '5.6' },
  bash:       { piston: 'bash',       file: 'main.sh',   judge0: 46,  wandbox: null,               ver: '5.0' },
  go:         { piston: 'go',         file: 'main.go',   judge0: 107, wandbox: 'go-1.23.2',        ver: '1.23' },
  rust:       { piston: 'rust',       file: 'main.rs',   judge0: 108, wandbox: 'rust-1.82.0',      ver: '1.82' },
  java:       { piston: 'java',       file: 'Main.java', judge0: 91,  wandbox: 'openjdk-jdk-22+36', ver: 'JDK 22' },
  c:          { piston: 'c',          file: 'main.c',    judge0: 103, wandbox: 'gcc-13.2.0-c',     ver: 'GCC 13' },
  cpp:        { piston: 'c++',        file: 'main.cpp',  judge0: 105, wandbox: 'gcc-13.2.0',       ver: 'GCC 13' },
  csharp:     { piston: 'csharp',     file: 'Main.cs',   judge0: 51,  wandbox: 'mono-6.12.0.199',  ver: 'Mono 6' },
  php:        { piston: 'php',        file: 'main.php',  judge0: 98,  wandbox: 'php-8.3.12',       ver: '8.3' },
  ruby:       { piston: 'ruby',       file: 'main.rb',   judge0: 72,  wandbox: 'ruby-3.4.9',       ver: '3.4' },
  lua:        { piston: 'lua',        file: 'main.lua',  judge0: 64,  wandbox: 'lua-5.4.7',        ver: '5.4' },
  perl:       { piston: 'perl',       file: 'main.pl',   judge0: 85,  wandbox: 'perl-5.44.0',      ver: '5.44' },
  r:          { piston: 'r',          file: 'main.r',    judge0: 99,  wandbox: 'r-4.4.1',          ver: '4.4' },
  kotlin:     { piston: 'kotlin',     file: 'Main.kt',   judge0: 111, wandbox: null,               ver: '2.1' },
  swift:      { piston: 'swift',      file: 'main.swift', judge0: 83, wandbox: 'swift-6.0.1',      ver: '6.0' },
  dart:       { piston: 'dart',       file: 'main.dart', judge0: 90,  wandbox: null,               ver: '2.19' },
  haskell:    { piston: 'haskell',    file: 'main.hs',   judge0: 61,  wandbox: 'ghc-9.10.1',       ver: 'GHC 9' },
  scala:      { piston: 'scala',      file: 'Main.scala', judge0: 112, wandbox: 'scala-3.5.1',     ver: '3.5' }
};
const ZC_RUN_BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
function zcRunCap(s) { s = String(s == null ? '' : s); return s.length > 60000 ? s.slice(0, 60000) + '\n[输出过长已截断]' : s; }
async function zcRunFetch(url, payload, ua, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 40000);
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua || ZC_RUN_BROWSER_UA }, body: JSON.stringify(payload), signal: ctrl.signal });
    const j = await resp.json().catch(() => null);
    return { status: resp.status, json: j };
  } finally { clearTimeout(timer); }
}
async function zcRunPiston(base, key, def, code, stdin) {
  const payload = { language: def.piston, version: '*', files: [{ name: def.file, content: code }], stdin: stdin, args: [], run_timeout: 10000, compile_timeout: 15000 };
  const r = await zcRunFetch(base + '/execute', payload, 'zc-gura/2.1', 40000);
  if (!r.json || !r.json.run) throw new Error('Piston HTTP ' + r.status + (r.json && r.json.message ? '：' + r.json.message : ''));
  const j = r.json;
  const out = { exitCode: typeof j.run.code === 'number' ? j.run.code : (j.run.code === null ? 0 : 1), stdout: zcRunCap(j.run.stdout), stderr: zcRunCap(j.run.stderr), language: j.language || key, version: j.version || '', provider: new URL(base).hostname };
  if (j.compile && j.compile.code) out.compile = { exitCode: j.compile.code, stdout: zcRunCap(j.compile.stdout), stderr: zcRunCap(j.compile.stderr) };
  return out;
}
async function zcRunJudge0(key, def, code, stdin) {
  if (!def.judge0) throw new Error('judge0 不支持该语言');
  const payload = { source_code: code, language_id: def.judge0, stdin: stdin };
  const r = await zcRunFetch('https://ce.judge0.com/submissions?base64_encoded=false&wait=true', payload, ZC_RUN_BROWSER_UA, 60000);
  if (!r.json || !r.json.status) throw new Error('Judge0 HTTP ' + r.status + (typeof r.json === 'object' && r.json && r.json.error ? '：' + r.json.error : ''));
  const j = r.json, sid = j.status.id;
  const out = { exitCode: sid === 3 ? 0 : (sid === 5 ? 124 : 1), stdout: zcRunCap(j.stdout), stderr: zcRunCap(j.stderr || j.message), language: key, version: def.ver, provider: 'ce.judge0.com' };
  if (sid === 5) out.stderr = (out.stderr ? out.stderr + '\n' : '') + '[执行超时，已被沙箱终止]';
  if (sid === 6 || j.compile_output) out.compile = { exitCode: 1, stdout: '', stderr: zcRunCap(j.compile_output) };
  return out;
}
async function zcRunWandbox(key, def, code, stdin) {
  if (!def.wandbox) throw new Error('wandbox 不支持该语言');
  const payload = { code: code, compiler: def.wandbox, stdin: stdin, save: false };
  const r = await zcRunFetch('https://wandbox.org/api/compile.json', payload, ZC_RUN_BROWSER_UA, 60000);
  if (!r.json || r.json.status === undefined) throw new Error('Wandbox HTTP ' + r.status);
  const j = r.json;
  const exitCode = parseInt(j.status, 10);
  const out = { exitCode: isNaN(exitCode) ? 1 : exitCode, stdout: zcRunCap(j.program_output), stderr: zcRunCap(j.program_error), language: key, version: def.ver, provider: 'wandbox.org' };
  const cerr = String(j.compiler_error || '') + String(j.compiler_message || '');
  if (cerr.trim()) out.compile = { exitCode: 1, stdout: zcRunCap(j.compiler_output), stderr: zcRunCap(cerr) };
  return out;
}
async function zcHandleRun(request, env) {
  const cors = zcCorsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return zcJson({ error: 'Method Not Allowed' }, 405);
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  let body = null;
  try { body = await request.json(); } catch (e) { return zcJson({ error: '请求体不是合法 JSON' }, 400); }
  const key = String(body.language || '').toLowerCase();
  const def = ZC_RUN_LANGS[key];
  if (!def) return zcJson({ error: '不支持的语言：' + key, languages: Object.keys(ZC_RUN_LANGS) }, 400);
  const code = String(body.code || '');
  if (!code.trim()) return zcJson({ error: '缺少 code 参数' }, 400);
  if (code.length > 200000) return zcJson({ error: '代码过长（>200KB）' }, 413);
  const stdin = String(body.stdin || '').slice(0, 64000);

  const errors = [];
  const pistonBase = String((env && env.PISTON_URL) || '').replace(/\/+$/, '');
  if (pistonBase) {
    try {
      const u = new URL(pistonBase);
      if (u.protocol !== 'https:' || zcIsBlockedHost(u.hostname)) throw new Error('PISTON_URL 必须是公网 https 地址');
      return zcJson(await zcRunPiston(pistonBase, key, def, code, stdin));
    } catch (e) { errors.push('Piston：' + (e && e.message ? e.message : String(e))); }
  }
  try { return zcJson(await zcRunJudge0(key, def, code, stdin)); }
  catch (e) { errors.push('Judge0：' + (e && e.message ? e.message : String(e))); }
  if (def.wandbox) {
    try { return zcJson(await zcRunWandbox(key, def, code, stdin)); }
    catch (e) { errors.push('Wandbox：' + (e && e.message ? e.message : String(e))); }
  }
  return zcJson({ error: '所有脚本执行服务都暂时不可用（' + errors.join('；') + '）。可稍后再试，或配置 PISTON_URL 使用自建 Piston 实例。' }, 502);
}

// ---------------------------------------------------------------------------
// 3) Worker 入口
// ---------------------------------------------------------------------------

// ===========================================================================
// 安全防护层 · v2.15.0（敏感操作全部只在后端执行）
// ---------------------------------------------------------------------------
// 1) 密钥永不落地浏览器：环境变量只存在于 Worker 运行时；/__zc_sec__/selfcheck
//    会主动拉取页面响应体扫描，一旦发现密钥值出现在返回内容里立刻报警。
// 2) 防扫描挖洞：路径/参数特征库（目录穿越、SQLi/XSS 载荷、常见漏洞路径、
//    诱饵路径）、机器人 UA 库、方法白名单；命中即拒绝并记分，累计到阈值自动封禁。
// 3) 防爬虫：X-Robots-Tag 全站 noindex + robots.txt 全站 Disallow + 缺少浏览器
//    特征的自动化请求一律拒绝。
// 4) 防滥用：分级频率限制（页面/接口/敏感接口）+ CSRF 同源校验 + 统一错误响应。
// 5) 不泄露内部信息：错误信息密钥脱敏、统一 500、隐藏堆栈与版本细节。
//
// 全部开关走 Cloudflare 变量（都可选，默认即开启；不配也能用）：
//   ZC_SEC_MODE=on|monitor|off   总开关（monitor=只记录不拦，off=完全关闭）
//   ZC_SEC_KEY=<随机串>           自用脚本/自动化通行证（请求头 x-zc-key），
//                                不填时自动回退到 ZC_ADMIN_TOKEN
//   ZC_SEC_BAN_SECONDS=86400     封禁时长（秒）
//   ZC_SEC_STRIKE_LIMIT=3        记分累计到多少自动封禁
//   ZC_SEC_RATE_PAGE=120         页面：每 IP 每分钟上限
//   ZC_SEC_RATE_API=90           普通接口：每 IP 每分钟上限
//   ZC_SEC_RATE_SENS=30          敏感接口（auth/run/relay/sandbox/ghterm/kv）：每 IP 每分钟上限
//   ZC_SEC_ALLOW_UAS=            额外放行的 UA 正则（可选，谨慎使用）
// ===========================================================================
const ZC_SEC_PATH = '/__zc_sec__';
const ZC_SEC_STAT = { total: 0, blocked: 0, banned: 0, strikes: 0, rateLimited: 0, note: [] };
const ZC_SEC_RATE_MEM = new Map();
const ZC_SEC_BAN_MEM = new Map();
const ZC_SEC_STRIKE_AT = new Map();
const ZC_SEC_SECRET_KEYS = [
  'E2B_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OAUTH_CLIENT_SECRET', 'ZC_ADMIN_TOKEN', 'ZC_SEC_KEY',
  'ZC_AUTH_INVITE_CODES', 'SMTP_PASS', 'SMTP_PASSWORD', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY',
  'SILICONFLOW_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY', 'TTS_API_KEY', 'STT_API_KEY',
  // v2.29 新增的密钥类变量：同样要在回显 / 自检里被抹掉
  'VOICE_API_KEY', 'VOICE_TTS_API_KEY', 'VOICE_STT_API_KEY', 'RAG_EMBED_API_KEY',
  'GOOGLE_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SIEM_TOKEN', 'SIEM_HMAC_KEY',
  'VAPID_PRIVATE_KEY', 'ZC_DATA_KEY', 'ZC_SMTP_PASS', 'MCP_SERVERS', 'OTEL_EXPORTER_OTLP_HEADERS'
];

// 扫描器 / 采集器 / 爬虫 UA（真实浏览器绝不会带这些）
const ZC_SEC_BAD_UA = /(curl|wget|python|pycurl|httpx|aiohttp|requests|urllib|go-http-client|golang|okhttp|java\/|libwww|apache-httpclient|scrapy|mechanize|nmap|nikto|sqlmap|masscan|zgrab|nuclei|gobuster|dirbuster|dirb\/|wfuzz|ffuf|hydra|acunetix|nessus|openvas|wpscan|whatweb|joomscan|droopescan|xray|fuzzer|fuzz|bruteforce|metasploit|exploit-db|semrush|ahrefs|majestic|mj12bot|dotbot|bytespider|petalbot|yandex|baiduspider|sogou|360spider|googlebot|bingbot|duckduckbot|applebot|amazonbot|gptbot|ccbot|claudebot|perplexitybot|anthropic|facebookexternalhit|telegrambot|discordbot|twitterbot|whatsapp|slackbot|linkedinbot|puppeteer|playwright|headless|phantomjs|selenium|node-fetch|undici|axios|postman|insomnia|httpie|zabbix|nagios|uptimerobot|pingdom|statuscake|masscanner)/i;

// 漏洞探测 / 目录穿越 / 后门路径（诱饵：正常用户永远不会访问）
const ZC_SEC_BAD_PATH = /(\.\.\/|%2e%2e|\/\.\.|\.\.%2f|%252e|\/\.env|\.env(\.|$|\/)|\.git($|\/)|\.svn|\.hg\/|\/wp-(admin|login|content|includes|json|config)|xmlrpc\.php|phpmyadmin|pma\/|adminer|\/admin\.php|\/adminer|\/phpinfo|\/server-status|\/server-info|\/actuator|\/solr\/|\/owa\/|\/cgi-bin\/|\/shell|\/webshell|\/backup|\/dump|\/\.ssh|\/id_rsa|\/etc\/(passwd|shadow|hosts)|\/proc\/self|\/dev\/tcp|\/vendor\/|\/composer\.(json|lock)|\/package-lock\.json|\/yarn\.lock|\.sql($|\?)|\.bak($|\?)|\.old($|\?)|\.swp$|\.php($|\?)|\.asp(x)?($|\?)|\.jsp($|\?)|\.cgi($|\?)|debug\.log|\/telescope|\/horizon|\/graphql|\/console|\.DS_Store|\/config\.(php|json|ya?ml|ini|bak)|\/\.aws|\/\.docker|\/\.npmrc|\/\.htaccess|\/web\.config|\/crossdomain\.xml|\/elmah\.axd|\/trace\.axd|\/jenkins|\/manager\/html|\/HNAP1|\/\.well-known\/security|\/\.idea|\/\.vscode)/i;

// 参数级攻击载荷（SQLi / XSS / 命令注入 / SSRF 内网探测 / SSTI）
const ZC_SEC_BAD_QUERY = /(union[\s+%20]+select|select[\s+%20]+[^&]{0,40}from[\s+%20]|insert[\s+%20]+into|drop[\s+%20]+table|update[\s+%20]+[^&]{0,30}set[\s+%20]|information_schema|extractvalue\(|updatexml\(|sleep\(\d+\)|benchmark\(|load_file\(|<script|%3cscript|onerror[\s%20]*=|onload[\s%20]*=|javascript:|vbscript:|%00|\x00|\.\.\/|%2e%2e|\/etc\/passwd|\/bin\/bash|jndi:|ldap:\/\/|\{\{7\*7\}\})/i;

function zcSecVar(env, k) {
  return env && env[k] != null && String(env[k]).length ? String(env[k]).trim() : '';
}
function zcSecMode(env) {
  const m = zcSecVar(env, 'ZC_SEC_MODE').toLowerCase();
  if (m === 'off') return 'off';
  if (m === 'monitor') return 'monitor';
  return 'on';
}
function zcSecNum(env, k, d) {
  const n = parseInt(zcSecVar(env, k), 10);
  return (isFinite(n) && n > 0) ? n : d;
}
function zcSecKey(env) { return zcSecVar(env, 'ZC_SEC_KEY') || zcSecVar(env, 'ZC_ADMIN_TOKEN'); }
function zcSecNote(type, msg) {
  try {
    ZC_SEC_STAT.note.push({ t: Date.now(), type: String(type || ''), msg: String(msg == null ? '' : msg).slice(0, 200) });
    if (ZC_SEC_STAT.note.length > 12) ZC_SEC_STAT.note.shift();
  } catch (e) { /* ignore */ }
}
function zcSecIp(request) {
  const h = request.headers;
  let ip = String(h.get('cf-connecting-ip') || h.get('x-forwarded-for') || h.get('x-real-ip') || '');
  ip = ip.split(',')[0].trim();
  return ip || 'unknown';
}
function zcSecEq(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function zcSecDecode(s) {
  const t = String(s == null ? '' : s);
  if (t.indexOf('%') < 0) return t;
  try { return decodeURIComponent(t); } catch (e) { return t; }
}
function zcSecBucket(path) {
  // 只有真正危险的操作（跑脚本 / 沙箱 / 终端 / 管理口 / 登录）才按敏感接口限流，
  // 轮询类接口（kv/task/audit/approval）走普通额度，避免正常页面被误伤。
  // v2.21.3：沙箱 / GitHub 终端是 Agent 的高频通道（同步 35 个文件 = 35+ 次请求），单独分桶、宽额度，避免被误判成攻击
  if (/^\/__zc_(sandbox|ghterm|mcp)__/.test(path)) return 'agent';
  if (/^\/__zc_(run|admin|auth)__/.test(path)) return 'sens';
  if (/^\/__zc_/.test(path)) return 'api';
  return 'page';
}
function zcSecRate(env, bucket) {
  if (bucket === 'page') return zcSecNum(env, 'ZC_SEC_RATE_PAGE', 120);
  if (bucket === 'agent') return zcSecNum(env, 'ZC_SEC_RATE_AGENT', 600);
  if (bucket === 'sens') return zcSecNum(env, 'ZC_SEC_RATE_SENS', 30);
  return zcSecNum(env, 'ZC_SEC_RATE_API', 90);
}
function zcSecRateHit(env, ip, bucket) {
  const limit = zcSecRate(env, bucket);
  const key = ip + '|' + bucket;
  const now = Date.now();
  if (ZC_SEC_RATE_MEM.size > 4000) ZC_SEC_RATE_MEM.clear();
  const rec = ZC_SEC_RATE_MEM.get(key);
  if (!rec || now - rec.w > 60000) {
    ZC_SEC_RATE_MEM.set(key, { n: 1, w: now });
    return { ok: true, n: 1, limit: limit };
  }
  rec.n++;
  return { ok: rec.n <= limit, n: rec.n, limit: limit };
}
// 记分：同一原因 20 秒内只写一次 KV，避免被刷爆每日写配额
async function zcSecStrike(env, ctx, ip, reason, weight) {
  if (ip === 'unknown' || ip === '0.0.0.0') return false; // 拿不到真实 IP（如内部子请求）不记分
  const now = Date.now();
  const lk = ip + '|' + reason;
  ZC_SEC_STAT.strikes++;
  if (now - (ZC_SEC_STRIKE_AT.get(lk) || 0) < 20000) return false;
  ZC_SEC_STRIKE_AT.set(lk, now);
  if (ZC_SEC_STRIKE_AT.size > 4000) ZC_SEC_STRIKE_AT.clear();
  let n = weight;
  try {
    if (zcStoreReady(env)) {
      const stv = zcKV(env);
      const raw = await stv.get('zc_sec_strike_' + ip);
      n = (parseInt(raw, 10) || 0) + weight;
      await stv.put('zc_sec_strike_' + ip, String(n), { expirationTtl: 900 });
    }
  } catch (e) { /* KV 失败不影响判定 */ }
  if (n >= zcSecNum(env, 'ZC_SEC_STRIKE_LIMIT', 3)) {
    await zcSecBan(env, ctx, ip, reason + '（累计 ' + n + ' 分）');
    return true;
  }
  return false;
}
async function zcSecBan(env, ctx, ip, reason) {
  ZC_SEC_BAN_MEM.set(ip, { banned: true, at: Date.now() });
  ZC_SEC_STAT.banned++;
  zcSecNote('ban', ip + ' ← ' + reason);
  try {
    if (env && env.ZC_KV) {
      await env.ZC_KV.put('zc_sec_ban_' + ip, reason + ' @ ' + new Date().toISOString(), { expirationTtl: zcSecNum(env, 'ZC_SEC_BAN_SECONDS', 86400) });
    }
  } catch (e) { /* 内存封禁仍然生效 */ }
  try {
    if (ctx && typeof zcAuditAppend === 'function') {
      Promise.resolve(zcAuditAppend(env, { actor: 'security', type: 'security', reason: '自动封禁：' + String(reason).slice(0, 120), target: ip, status: 'blocked' }, ctx)).catch(function () { /* 审计失败不影响封禁 */ });
    }
  } catch (e) { /* ignore */ }
  return true;
}
async function zcSecIsBanned(env, ip) {
  if (ip === 'unknown' || ip === '0.0.0.0') return false;
  const mem = ZC_SEC_BAN_MEM.get(ip);
  if (mem && Date.now() - mem.at < 60000) return !!mem.banned;
  let banned = false;
  try {
    if (env && env.ZC_KV) {
      const bv = await env.ZC_KV.get('zc_sec_ban_' + ip);
      // v2.21.3：旧版因“请求超频”写下的封禁（原因以 rate: 开头）视为无效，直接放行
      banned = !!bv && String(bv).indexOf('rate:') !== 0;
    }
  } catch (e) { /* ignore */ }
  ZC_SEC_BAN_MEM.set(ip, { banned: banned, at: Date.now() });
  return banned;
}
async function zcSecUnban(env, ip) {
  ZC_SEC_BAN_MEM.set(ip, { banned: false, at: Date.now() });
  ZC_SEC_STRIKE_AT.clear();
  try {
    if (env && env.ZC_KV) {
      await env.ZC_KV.delete('zc_sec_ban_' + ip);
      await env.ZC_KV.delete('zc_sec_strike_' + ip);
    }
  } catch (e) { /* ignore */ }
  return true;
}
// 错误信息脱敏：把任何环境变量里的密钥值替换掉，保证异常也不会把密钥打出去
function zcSecRedact(text, env) {
  let t = String(text == null ? '' : text);
  for (let i = 0; i < ZC_SEC_SECRET_KEYS.length; i++) {
    const v = env && env[ZC_SEC_SECRET_KEYS[i]] ? String(env[ZC_SEC_SECRET_KEYS[i]]) : '';
    if (v && v.length >= 6 && t.indexOf(v) >= 0) t = t.split(v).join('***');
  }
  return t;
}
function zcSecSecretFlags(env) {
  const out = {};
  for (let i = 0; i < ZC_SEC_SECRET_KEYS.length; i++) {
    const k = ZC_SEC_SECRET_KEYS[i];
    if (env && env[k]) out[k] = String(env[k]).length;
  }
  return out;
}
function zcSecHeaders(headers) {
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!headers.has('Permissions-Policy')) headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  return headers;
}
// 出口统一加固：所有响应（页面/接口/错误）都盖上安全头
async function zcSecHarden(resp, env) {
  try {
    if (!resp || resp.webSocket || resp.status === 101) return resp;
    const headers = zcSecHeaders(new Headers(resp.headers));
    headers.delete('content-length');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: headers });
  } catch (e) { return resp; }
}
function zcSecDeny(request, status, code) {
  let path = '/';
  try { path = new URL(request.url).pathname; } catch (e) { path = '/'; }
  if (path.indexOf('/__zc_') === 0) {
    if (status === 429) return zcJson({ error: '请求过于频繁（SEC_RATE），请稍后重试', code: code || 'SEC_RATE' }, 429, { 'Retry-After': '5' });
    if (code === 'SEC_BANNED') return zcJson({ error: '访问被安全网关拦截（SEC_BANNED：当前网络出口 IP 处于临时封禁期，到期自动解除；也可用管理密钥调用 /__zc_sec__/unban 立即解除）', code: code }, status);
    return zcJson({ error: '拒绝访问（' + (code || 'SEC_DENIED') + '）', code: code || 'SEC_DENIED' }, status);
  }
  if (status === 429) return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } });
  return new Response('Access Denied', { status: status || 403 });
}
function zcSecBlocked(request, mode, status, code, why) {
  ZC_SEC_STAT.blocked++;
  if (mode === 'monitor') { zcSecNote('monitor', code + ' ' + String(why || '')); return null; }
  zcSecNote('block', code + ' ' + String(why || ''));
  return zcSecDeny(request, status, code);
}
// 安全自检：主动拉自己的页面/接口，检查密钥是否泄漏、防护是否生效
async function zcSecSelfCheck(request, env, key) {
  const origin = new URL(request.url).origin;
  const out = { ok: true, time: Date.now(), checks: [] };
  function add(name, okv, detail) {
    out.checks.push({ name: name, ok: !!okv, detail: String(detail == null ? '' : detail).slice(0, 220) });
    if (!okv) out.ok = false;
  }
  let pageText = '', ph = null;
  try {
    const r = await fetch(origin + '/', { headers: { 'x-zc-key': key, 'user-agent': 'ZC-SelfCheck' } });
    ph = r.headers;
    pageText = await r.text();
  } catch (e) { add('首页可拉取', false, e && e.message); }
  if (ph) {
    add('响应头 X-Robots-Tag（防收录）', !!ph.get('x-robots-tag'), ph.get('x-robots-tag') || '缺失');
    add('响应头 HSTS', !!ph.get('strict-transport-security'), ph.get('strict-transport-security') || '缺失');
    add('响应头 X-Content-Type-Options', ph.get('x-content-type-options') === 'nosniff', ph.get('x-content-type-options') || '缺失');
  }
  const leaked = [];
  for (let i = 0; i < ZC_SEC_SECRET_KEYS.length; i++) {
    const k = ZC_SEC_SECRET_KEYS[i];
    const v = env && env[k] ? String(env[k]) : '';
    if (v && v.length >= 6 && pageText.indexOf(v) >= 0) leaked.push(k);
  }
  add('密钥未泄漏到前端页面', leaked.length === 0, leaked.length ? '泄漏：' + leaked.join(',') : '未发现泄漏');
  try {
    const r2 = await fetch(origin + '/robots.txt', { headers: { 'x-zc-key': key } });
    const t2 = await r2.text();
    add('robots.txt 全站禁止收录', t2.indexOf('Disallow: /') >= 0, String(t2).replace(/\n/g, ' | ').slice(0, 80));
  } catch (e) { add('robots.txt 可访问', false, e && e.message); }
  try {
    const r3 = await fetch(origin + '/__zc_sandbox__/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    add('匿名调用敏感接口被拒', r3.status === 401 || r3.status === 403, 'HTTP ' + r3.status);
  } catch (e) { add('匿名调用敏感接口被拒', false, e && e.message); }
  try {
    const r4 = await fetch(origin + '/__zc_sec__/status', { headers: { 'user-agent': 'sqlmap/1.7#stable' } });
    add('扫描器 UA 被拦（且不暴露管理口）', r4.status === 403 || r4.status === 404, 'HTTP ' + r4.status);
  } catch (e) { add('扫描器 UA 被拦', false, e && e.message); }
  try {
    const r5 = await fetch(origin + '/.env', { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'zh-CN' } });
    add('诱饵路径 /.env 被拒', r5.status === 403, 'HTTP ' + r5.status);
  } catch (e) { add('诱饵路径被拒', false, e && e.message); }
  out.secrets = zcSecSecretFlags(env);
  out.stats = ZC_SEC_STAT;
  return out;
}

// ---------------- 安全网关：所有请求的第一道门 ----------------
async function zcSecGate(request, env, ctx) {
  const mode = zcSecMode(env);
  if (mode === 'off') return null;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = String(request.method || 'GET').toUpperCase();
  const h = request.headers;
  let ip = zcSecIp(request);
  if (ip === 'unknown' || ip === '0.0.0.0') ip = 'unknown';
  const key = zcSecKey(env);
  const trusted = !!(key && zcSecEq(String(h.get('x-zc-key') || ''), key));
  ZC_SEC_STAT.total++;

  // 1) 安全管理口：没有通行证一律 404（不暴露存在性）
  if (path === ZC_SEC_PATH || path.indexOf(ZC_SEC_PATH + '/') === 0) {
    if (!trusted) return new Response('Not Found', { status: 404 });
    const sub = path.slice(ZC_SEC_PATH.length).replace(/^\/+/, '');
    if (method === 'GET' && (sub === '' || sub === 'status')) {
      return zcJson({
        ok: true,
        mode: mode,
        cfg: {
          banSeconds: zcSecNum(env, 'ZC_SEC_BAN_SECONDS', 86400),
          strikeLimit: zcSecNum(env, 'ZC_SEC_STRIKE_LIMIT', 3),
          rate: { page: zcSecRate(env, 'page'), api: zcSecRate(env, 'api'), sens: zcSecRate(env, 'sens') },
          allowUas: zcSecVar(env, 'ZC_SEC_ALLOW_UAS') ? true : false
        },
        stats: ZC_SEC_STAT,
        memCache: { rate: ZC_SEC_RATE_MEM.size, ban: ZC_SEC_BAN_MEM.size },
        secrets: zcSecSecretFlags(env)
      });
    }
    if (method === 'POST' && sub === 'unban') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); } catch (e) { body = {}; }
      const target = String(body.ip || url.searchParams.get('ip') || '').trim();
      if (!target) return zcJson({ error: '需要 ip 参数' }, 400);
      await zcSecUnban(env, target);
      return zcJson({ ok: true, ip: target, unbanned: true });
    }
    if (method === 'POST' && sub === 'selfcheck') return zcJson(await zcSecSelfCheck(request, env, key));
    return zcJson({ error: '未知的安全接口' }, 404);
  }

  // 2) robots.txt：全站禁止收录（爬虫守规矩就自己走）
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }

  if (trusted) return null; // 自用脚本/自动化：跳过拦截（响应仍会被加固）

  // 3) 已封禁 IP：直接拒
  if (await zcSecIsBanned(env, ip)) {
    ZC_SEC_STAT.blocked++;
    zcSecNote('banned-hit', ip + ' → ' + path.slice(0, 80));
    return zcSecDeny(request, 403, 'SEC_BANNED');
  }

  // 4) 方法白名单
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST' && method !== 'OPTIONS') {
    await zcSecStrike(env, ctx, ip, 'method:' + method, 2);
    return zcSecBlocked(request, mode, 405, 'SEC_METHOD', 'method ' + method);
  }

  // 5) 路径 / 查询串特征库（扫描器、漏洞探测器）
  const decPath = zcSecDecode(path);
  const decQuery = zcSecDecode(url.search || '');
  if (ZC_SEC_BAD_PATH.test(path) || ZC_SEC_BAD_PATH.test(decPath)) {
    await zcSecStrike(env, ctx, ip, 'path-fuzz', 3);
    return zcSecBlocked(request, mode, 403, 'SEC_PATH', 'path ' + decPath.slice(0, 60));
  }
  if (ZC_SEC_BAD_QUERY.test(decQuery)) {
    await zcSecStrike(env, ctx, ip, 'param-fuzz', 3);
    return zcSecBlocked(request, mode, 403, 'SEC_QUERY', 'query ' + decQuery.slice(0, 60));
  }

  // 6) UA：空 UA / 机器人 / 采集器 / 扫描器
  const ua = String(h.get('user-agent') || '');
  const allowUaRe = zcSecVar(env, 'ZC_SEC_ALLOW_UAS');
  let uaAllowed = false;
  if (allowUaRe) {
    try { uaAllowed = new RegExp(allowUaRe, 'i').test(ua); } catch (e) { uaAllowed = false; }
  }
  if (!ua) {
    await zcSecStrike(env, ctx, ip, 'no-ua', 1);
    return zcSecBlocked(request, mode, 403, 'SEC_UA', 'empty ua');
  }
  if (!uaAllowed && ZC_SEC_BAD_UA.test(ua)) {
    await zcSecStrike(env, ctx, ip, 'bot-ua', 2);
    return zcSecBlocked(request, mode, 403, 'SEC_UA', 'bot ua ' + ua.slice(0, 60));
  }

  // 7) 分级频率限制
  const bucket = zcSecBucket(path);
  const rl = zcSecRateHit(env, ip, bucket);
  if (!rl.ok) {
    ZC_SEC_STAT.rateLimited++;
    // v2.21.3：普通超频只回 429（前端会按 Retry-After 退避重试），不再记分封禁；只有超额 8 倍以上的洪泛才记分
    if (rl.n > rl.limit * 8) await zcSecStrike(env, ctx, ip, 'flood:' + bucket, 1);
    return zcSecBlocked(request, mode, 429, 'SEC_RATE', bucket + ' ' + rl.n + '/' + rl.limit);
  }

  // 8) 浏览器特征：真实浏览器一定带 Accept-Language / Sec-Fetch-* / Sec-CH-UA
  const browserish = !!(h.get('accept-language') || h.get('sec-fetch-mode') || h.get('sec-fetch-site') || h.get('sec-ch-ua'));
  if (!browserish && !uaAllowed) {
    await zcSecStrike(env, ctx, ip, 'not-browser', 1);
    return zcSecBlocked(request, mode, 403, 'SEC_NOT_BROWSER', 'no browser headers');
  }

  // 9) CSRF：状态变更请求必须同源（跨站表单/脚本一律拒绝）
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const site = String(h.get('sec-fetch-site') || '').toLowerCase();
    const origin = String(h.get('origin') || '');
    if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
      await zcSecStrike(env, ctx, ip, 'csrf-site:' + site, 3);
      return zcSecBlocked(request, mode, 403, 'SEC_CSRF', 'site ' + site);
    }
    if (!site && origin && origin !== url.origin) {
      await zcSecStrike(env, ctx, ip, 'csrf-origin', 3);
      return zcSecBlocked(request, mode, 403, 'SEC_CSRF', 'origin ' + origin.slice(0, 60));
    }
  }
  return null;
}

// ---------------- 原路由分发（安全网关通过后才会走到这里） ----------------
async function zcSecDispatch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === ZC_AUTH_PATH || path.indexOf(ZC_AUTH_PATH + '/') === 0) return zcHandleAuth(request, env);
    if (path === ZC_ARTIFACT_PATH) return zcArtifactPage(request);
    if (path === ZC_ADMIN_PATH) return await zcAdminPage(request, env, request.method === 'HEAD');
    if (zcAuthGuardedPath(path)) {
      const deny = await zcAuthGuard(request, env);
      if (deny) return deny;
    }
    // v2.29：RBAC / 配额熔断 / 语音 / MCP / 推送 / 团队 / RAG / 计费 / 运维（返回 null 表示不是新路由，继续走旧分发）
    const __v29 = await zcV29Route(request, env, ctx, path, ZC_REQ_META.get(request) || null);
    if (__v29) return __v29;
    if (path === ZC_RELAY_PATH) return zcHandleRelay(request, env);
    if (path === ZC_RUN_PATH) return zcHandleRun(request, env);
    if (path === ZC_AUDIT_PATH || path.indexOf(ZC_AUDIT_PATH + '/') === 0) return zcHandleAudit(request, env, ctx);
    if (path === ZC_TASK_PATH || path.indexOf(ZC_TASK_PATH + '/') === 0) return zcHandleTask(request, env, ctx);
    if (path === ZC_APPROVAL_PATH || path.indexOf(ZC_APPROVAL_PATH + '/') === 0) return zcHandleApproval(request, env, ctx);
    if (path === ZC_GHT_PATH || path.indexOf(ZC_GHT_PATH + '/') === 0) return zcHandleGhTerm(request, env, ctx);
    if (path === ZC_KV_PATH || path.indexOf(ZC_KV_PATH + '/') === 0) return zcHandleKV(request, env);
    if (path === ZC_SBX_PATH || path.indexOf(ZC_SBX_PATH + '/') === 0) {
      const gate = await zcGateSandbox(request, env);
      if (gate) return gate;
      return zcHandleSandbox(request, env);
    }
    if (path === ZC_WEB_PATH || path.indexOf(ZC_WEB_PATH + '/') === 0) return zcHandleWeb(request, env);
    if (path === ZC_HEALTH_PATH) {
      return zcJson({ ok: true, version: ZC_VERSION, kv: !!(env && env.ZC_KV), store: zcStoreMode(env), db: zcDbReady(env), sandbox: !!(env && env.SANDBOX) || zcE2bReady(env), pages: true, sandboxBackend: zcE2bReady(env) ? 'e2b' : (env && env.SANDBOX ? 'containers' : 'none'), run: true, audit: true, tasks: true, approvals: true, auth: zcAuthEnabled(env), authKv: !!(env && env.ZC_KV), mail: zcMailReady(env), sec: zcSecMode(env), secKey: !!zcSecKey(env), ghterm: !!(env && env.GITHUB_TOKEN), approvalGate: String((env && env.ZC_REQUIRE_APPROVALS) || '') === '1', github: zcGhOAuthReady(env), invite: zcAuthInviteCodes(env).length > 0, google: zcOidcReady(env, 'google'), microsoft: zcOidcReady(env, 'microsoft'), csp: zcCspMode(env), time: Date.now() });
    }
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const __zcDocPath = new URL(request.url).pathname;
    if (__zcDocPath === '/sw.js') { const __sw = await zcServeSw(request, env); if (__sw) return __sw; }
    const __zcIsDoc = __zcDocPath === '/' || /\.html?$/i.test(__zcDocPath) || !/\.[a-z0-9]{1,8}$/i.test(__zcDocPath);
    if (__zcIsDoc) return await zcServePage(request, env, request.method === 'HEAD');
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      try {
        const r = await env.ASSETS.fetch(request);
        if (r && r.status !== 404) return r;
      } catch (e) { /* 静态资源不可用 */ }
    }
    return new Response('Not Found', { status: 404 });
}

// ---------------------------------------------------------------------------
// v2.23：前后端分离 —— 主页面由静态资源 public/index.html 提供（绑定 ASSETS）
//   取不到静态资源时，回退到一份极简兜底页，保证站点始终能打开。
// ---------------------------------------------------------------------------
const ZC_PAGE_FALLBACK = String.raw`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>SIGNAL</title></head>
<body style="font:15px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:28px;color:#18181b">
<h1 style="font-size:19px;margin:0 0 10px">SIGNAL 已部署（后端在线）</h1>
<p style="color:#55555e;margin:0 0 14px">前端页面 <code>public/index.html</code> 暂未取到，可能尚未随本次部署上传。</p>
<p style="color:#55555e;margin:0">请确认仓库包含 <code>public/index.html</code>，且 <code>wrangler.jsonc</code> 中有 <code>assets.directory = "./public"</code>，然后重新部署。</p>
</body></html>`;
const ZC_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
};
async function zcServePage(request, env, isHead) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    try {
      const u = new URL(request.url);
      if (u.pathname === '/' || u.pathname === '') u.pathname = '/index.html';
      const r = await env.ASSETS.fetch(new Request(u.toString(), { method: 'GET', headers: request.headers }));
      if (r && r.status !== 404) {
        const h = zcSecHeaders(new Headers(r.headers));
        Object.keys(ZC_PAGE_HEADERS).forEach((k) => h.set(k, ZC_PAGE_HEADERS[k]));
        if (zcCspMode(env) !== 'off' && /text\/html/i.test(String(r.headers.get('content-type') || ''))) {
          // v2.29：按页面里真实的内联脚本逐个算哈希，生成完整 CSP（默认强制；ZC_CSP_MODE=report 只上报不拦截）
          const html = await r.text();
          const csp = await zcCspForHtml(html, env);
          if (zcCspMode(env) === 'report') h.set('Content-Security-Policy-Report-Only', csp); else h.set('Content-Security-Policy', csp);
          h.delete('content-length');
          return new Response(isHead ? null : html, { status: r.status, headers: h });
        }
        return new Response(isHead ? null : r.body, { status: r.status, headers: h });
      }
    } catch (e) { /* 静态资源不可用 → 用兜底页 */ }
  }
  return new Response(isHead ? null : ZC_PAGE_FALLBACK, { headers: ZC_PAGE_HEADERS });
}
// 兼容常量：旧引用若仍存在也不会报错
const ZC_HTML = ZC_PAGE_FALLBACK;

/* ==========================================================================
 * v2.32 · Artifacts 预览沙箱页  /__zc_artifact__
 *   聊天里的 HTML / SVG / Mermaid 代码块在右侧面板里预览，运行在这个独立路由的 iframe 里：
 *   · 自带一套 CSP（见 ZC_ARTIFACT_CSP）：允许内联脚本与常见 CDN，但整页带 sandbox 指令（不透明源，没有 allow-same-origin）；
 *   · 父页用 <iframe sandbox="allow-scripts …"> 嵌入，CSP 的 frame-src 放行 'self'；
 *   · 原因：父页 CSP 的 script-src 是「内联脚本逐个算哈希」的严格策略，srcdoc / blob 的 iframe 会继承它，
 *     模型写的内联 <script> 全被拦；而这个路由返回的是独立文档，用的是自己的 CSP。
 *   页面里是静态内容（不含任何用户数据）；内容由父页 postMessage 送入。
 * ========================================================================== */
const ZC_ARTIFACT_PATH = '/__zc_artifact__';
const ZC_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com https://esm.sh https://code.jquery.com https://ajax.googleapis.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  "connect-src https: wss: data: blob:",
  "worker-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
].join('; ');
/* zc-artifact-runner:begin */
const ZC_ARTIFACT_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>预览</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#fff;color:#1f1e1d;font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#f{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:none}
#d{position:absolute;inset:0;overflow:auto;display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:#fff}
#d img{width:100%;height:100%;object-fit:contain}
#d>svg{max-width:100%;height:auto}
#e{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center;color:#8a3b22;white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body>
<iframe id="f" referrerpolicy="no-referrer" title="artifact"></iframe>
<div id="d"></div>
<div id="e" role="alert"></div>
<script>
(function () {
  'use strict';
  /* ZC-GURA · Artifact 沙箱运行页
   * 由 Worker 在 /__zc_artifact__ 提供，响应头自带独立 CSP（含 sandbox 指令），父页用 <iframe sandbox="allow-scripts …"> 嵌入。
   * 没有 allow-same-origin：这里和里面的 HTML 都是「不透明源」，读不到站点的 localStorage / Cookie / 任何接口登录态。
   * 父页通过 postMessage 把内容送进来：{zc:'artifact', kind:'html'|'svg'|'mermaid', code, theme, seq}；
   * 这里只信 window.parent 发来的消息，渲染完成 / 出错 / 脚本日志再回报给父页。 */
  var P = window.parent;
  var F = document.getElementById('f'), D = document.getElementById('d'), E = document.getElementById('e');
  var seq = 0, mermaidP = null;
  var SB = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';
  var MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';

  function post(m) { try { P.postMessage(m, '*'); } catch (x) { /* ignore */ } }
  function show(w) { F.style.display = w === 'f' ? 'block' : 'none'; D.style.display = w === 'd' ? 'flex' : 'none'; E.style.display = w === 'e' ? 'flex' : 'none'; }
  function done(s, ok, msg) { post({ zc: 'artifact-done', seq: s, ok: !!ok, msg: msg || '' }); }
  function fail(s, msg) { E.textContent = msg; show('e'); done(s, false, msg); }
  function newFrame() {
    var n = document.createElement('iframe');
    n.id = 'f'; n.setAttribute('sandbox', SB); n.setAttribute('referrerpolicy', 'no-referrer'); n.setAttribute('title', 'artifact');
    n.style.display = 'none';
    F.parentNode.replaceChild(n, F); F = n; return n;
  }

  /* 注入到用户 HTML 里的小脚本：把脚本报错 / console.error / console.warn 回报给父页；外链在新窗口打开（沙箱里不允许直接跳转） */
  var SNIP = '<script>(function(){var P=window.parent;function s(t,m){try{P.postMessage({zcInner:t,msg:String(m).slice(0,500)},"*")}catch(e){}}'
    + 'window.addEventListener("error",function(e){s("error",(e.message||"脚本错误")+(e.lineno?"（第 "+e.lineno+" 行）":""))});'
    + 'window.addEventListener("unhandledrejection",function(e){var r=e.reason;s("error",(r&&r.message)||r||"未处理的 Promise 拒绝")});'
    + 'var c=window.console;["error","warn"].forEach(function(k){var o=c[k];c[k]=function(){try{s(k,[].slice.call(arguments).map(function(a){try{return typeof a==="string"?a:JSON.stringify(a)}catch(x){return String(a)}}).join(" "))}catch(x){}return o.apply(c,arguments)}});'
    + 'document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();if(/^(https?:|mailto:)/i.test(a.href)){try{window.open(a.href,"_blank","noopener")}catch(x){}}},true);'
    + '})();<\/script>';

  function wrapHtml(code) {
    var c = String(code || '');
    var hasDoc = /<html[\s>]/i.test(c) || /<!doctype/i.test(c);
    if (!hasDoc) c = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + c + '</body></html>';
    if (/<head[^>]*>/i.test(c)) return c.replace(/<head[^>]*>/i, function (m) { return m + SNIP; });
    if (/<html[^>]*>/i.test(c)) return c.replace(/<html[^>]*>/i, function (m) { return m + '<head>' + SNIP + '</head>'; });
    if (/^\s*<!doctype[^>]*>/i.test(c)) return c.replace(/^\s*<!doctype[^>]*>/i, function (m) { return m + '<html><head>' + SNIP + '</head>'; });
    return SNIP + c;
  }

  function renderHtml(code, s) {
    var f = newFrame();
    f.onload = function () { if (s !== seq) return; done(s, true); };
    show('f');
    f.srcdoc = wrapHtml(code);
  }

  function renderSvg(code, s) {
    var t = String(code || '').trim();
    if (!/<svg[\s>]/i.test(t)) return fail(s, '这不是有效的 SVG：没有找到 <svg> 标签');
    if (!/<svg[^>]*\sxmlns\s*=/i.test(t)) t = t.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    newFrame();
    var img = new Image(); img.alt = 'SVG';
    img.onload = function () { if (s !== seq) return; D.textContent = ''; D.appendChild(img); show('d'); done(s, true); };
    img.onerror = function () { if (s !== seq) return; fail(s, 'SVG 无法解析：请检查标签是否闭合、属性引号是否成对。'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t);
  }

  function loadMermaid() {
    if (mermaidP) return mermaidP;
    mermaidP = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = MERMAID; sc.async = true;
      sc.onload = function () { if (window.mermaid) res(window.mermaid); else { mermaidP = null; rej(new Error('Mermaid 库加载后不可用')); } };
      sc.onerror = function () { mermaidP = null; rej(new Error('无法加载 Mermaid 渲染库（需要能访问 cdn.jsdelivr.net）')); };
      document.head.appendChild(sc);
    });
    return mermaidP;
  }
  function renderMermaid(code, s) {
    newFrame();
    loadMermaid().then(function (mm) {
      mm.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif' });
      return mm.render('zcm' + s, String(code || ''));
    }).then(function (r) {
      if (s !== seq) return;
      D.innerHTML = r.svg; show('d'); done(s, true);
    }).catch(function (err) {
      if (s !== seq) return;
      var m = String((err && err.message) || err || '渲染失败');
      fail(s, 'Mermaid 渲染失败：' + m.split('\n')[0].slice(0, 300));
    });
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.zcInner && e.source === F.contentWindow) { post({ zc: 'artifact-log', level: String(m.zcInner), msg: String(m.msg || '') }); return; }
    if (e.source !== P || !m || m.zc !== 'artifact') return;
    var s = m.seq | 0; seq = s;
    var kind = String(m.kind || ''), code = String(m.code == null ? '' : m.code);
    try {
      if (kind === 'html') renderHtml(code, s);
      else if (kind === 'svg') renderSvg(code, s);
      else if (kind === 'mermaid') renderMermaid(code, s);
      else fail(s, '不支持预览这种类型：' + kind);
    } catch (x) { fail(s, String((x && x.message) || x)); }
  });

  post({ zc: 'artifact-ready' });
})();
</script>
</body>
</html>`;
/* zc-artifact-runner:end */
function zcArtifactPage(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  return new Response(request.method === 'HEAD' ? null : ZC_ARTIFACT_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy': ZC_ARTIFACT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()'
    }
  });
}
/* sw.js：把缓存名里的版本号替换成 ZC_VERSION —— 以后发版只需要改 ZC_VERSION 一处，缓存会自动换代 */
async function zcServeSw(request, env) {
  if (!(env && env.ASSETS && typeof env.ASSETS.fetch === 'function')) return null;
  try {
    const r = await env.ASSETS.fetch(request);
    if (!r || r.status === 404) return null;
    const src = await r.text();
    const out = src.replace(/const VER = '[^']*';/, "const VER = 'zc-gura-v" + ZC_VERSION + "';");
    return new Response(request.method === 'HEAD' ? null : out, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
  } catch (e) { return null; }
}


// ---------------- 统一出口：安全网关 + 异常兜底 + 响应加固 ----------------

// ============================================================================
// v2.29 · 企业化扩展（P0–P3）—— 以下全部为新增代码，不改动上面任何既有行为
//   A) 请求 ID + 结构化日志 + OpenTelemetry   B) CSP 补全   C) RBAC 角色
//   D) 配额与成本熔断   E) 语音 TTS/STT   F) MCP   G) Web Push   H) 团队工作区
//   I) Google / Microsoft OAuth（PKCE）  J) TOTP 2FA   K) 向量知识库 RAG
//   L) 支付计费（Stripe）  M) SIEM 审计归档（哈希链）  N) 管理接口 /__zc_ops__
// 所有新能力默认「未配置即关闭、不影响旧行为」；密钥只在服务端环境变量里。
// ============================================================================
const ZC_CSP_REPORT_PATH = '/__zc_csp__';
const ZC_MCP_PATH = '/__zc_mcp__';
const ZC_TEAM_PATH = '/__zc_team__';
const ZC_RAG_PATH = '/__zc_rag__';
const ZC_OPS_PATH = '/__zc_ops__';
const ZC_REQ_META = new WeakMap();   // request → { rid, trace, owner… }，供下游日志 / 指标取用

function zcV(env, k) { return env && env[k] != null ? String(env[k]).trim() : ''; }
function zcVNum(env, k, d) { const n = parseFloat(zcV(env, k)); return isFinite(n) && n >= 0 ? n : d; }
function zcVBool(env, k) { return /^(1|true|yes|on)$/i.test(zcV(env, k)); }
function zcB64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function zcB64uToBytes(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function zcBytesCat() {
  let n = 0; for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
  const out = new Uint8Array(n); let o = 0;
  for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
  return out;
}
async function zcHmacSha256(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}
const zcTE = new TextEncoder();
function zcDayKey(ts) { return new Date(ts || Date.now()).toISOString().slice(0, 10).replace(/-/g, ''); }
function zcSecsToNextDay() { const n = new Date(); return Math.max(60, Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000)); }
async function zcOwnerKey(owner) { return (await zcSha256Hex('zc-owner:' + owner)).slice(0, 24); }

/* ---------- 静态加密（可选）：设置 ZC_DATA_KEY 后，服务端存的令牌 / 2FA 密钥 / MCP 请求头均以 AES-GCM 加密 ---------- */
async function zcSealKey(env) {
  const raw = zcV(env, 'ZC_DATA_KEY') || zcV(env, 'ZC_ADMIN_TOKEN');
  if (!raw) return null;
  const base = await crypto.subtle.importKey('raw', zcTE.encode(raw), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: zcTE.encode('zc-gura-seal-v1'), info: zcTE.encode('data') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function zcSeal(env, obj) {
  const json = JSON.stringify(obj == null ? null : obj);
  const key = await zcSealKey(env);
  if (!key) return { p: 1, d: json };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zcTE.encode(json)));
  return { e: 1, d: zcB64u(zcBytesCat(iv, ct)) };
}
async function zcUnseal(env, box) {
  if (!box || typeof box !== 'object') return null;
  try {
    if (box.p) return JSON.parse(box.d);
    const key = await zcSealKey(env);
    if (!key) return null;
    const raw = zcB64uToBytes(box.d);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) { return null; }
}

/* ==========================================================================
 * A) 请求 ID + 结构化日志 + OpenTelemetry
 * ========================================================================== */
const ZC_REQ_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const ZC_METRICS = { since: Date.now(), req: 0, c2: 0, c3: 0, c4: 0, c5: 0, msSum: 0, msMax: 0 };
function zcReqId(request) {
  const h = String(request.headers.get('x-request-id') || '').trim();
  if (ZC_REQ_ID_RE.test(h)) return h;
  try { return crypto.randomUUID(); } catch (e) { return zcRandHex(16); }
}
const ZC_LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };
function zcLog(env, level, msg, fields) {
  try {
    const min = ZC_LOG_LEVELS[(zcV(env, 'ZC_LOG_LEVEL') || 'info').toLowerCase()] || 20;
    if ((ZC_LOG_LEVELS[level] || 20) < min) return;
    const line = Object.assign({ ts: new Date().toISOString(), level: level, msg: msg, svc: 'zc-gura', ver: ZC_VERSION }, fields || {});
    console.log(JSON.stringify(line));
  } catch (e) { /* 日志失败不影响请求 */ }
}
const zcIpHashCache = new Map();
async function zcIpTag(ip) {
  if (!ip || ip === 'unknown') return '';
  let t = zcIpHashCache.get(ip);
  if (!t) { t = (await zcSha256Hex('zc-ip:' + ip)).slice(0, 12); if (zcIpHashCache.size > 500) zcIpHashCache.clear(); zcIpHashCache.set(ip, t); }
  return t;
}
function zcRouteOf(path) { return String(path || '/').replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:id').slice(0, 120); }
function zcTraceparent(request) {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(request.headers.get('traceparent') || '').trim());
  if (m && !/^0+$/.test(m[1])) return { traceId: m[1], parent: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 };
  return { traceId: zcRandHex(16), parent: '', sampled: true };
}
function zcOtelAttr(k, v) {
  if (typeof v === 'number' && isFinite(v)) return { key: k, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
  if (typeof v === 'boolean') return { key: k, value: { boolValue: v } };
  return { key: k, value: { stringValue: String(v == null ? '' : v).slice(0, 300) } };
}
function zcOtelHeaders(env) {
  const h = { 'Content-Type': 'application/json' };
  zcV(env, 'OTEL_EXPORTER_OTLP_HEADERS').split(',').forEach((p) => { const i = p.indexOf('='); if (i > 0) h[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return h;
}
function zcOtelBuild(env, tp, spanId, info) {
  const endNs = BigInt(info.endMs) * 1000000n, startNs = BigInt(info.startMs) * 1000000n;
  const attrs = [['http.request.method', info.method], ['url.path', info.route], ['http.response.status_code', info.status], ['zc.request_id', info.rid], ['zc.owner', info.owner || ''], ['zc.bucket', info.bucket || '']].map((x) => zcOtelAttr(x[0], x[1]));
  return { resourceSpans: [{ resource: { attributes: [zcOtelAttr('service.name', zcV(env, 'OTEL_SERVICE_NAME') || 'zc-gura'), zcOtelAttr('service.version', ZC_VERSION)] },
    scopeSpans: [{ scope: { name: 'zc-gura-worker', version: ZC_VERSION }, spans: [{ traceId: tp.traceId, spanId: spanId, parentSpanId: tp.parent || undefined, name: info.method + ' ' + info.route, kind: 2,
      startTimeUnixNano: String(startNs), endTimeUnixNano: String(endNs), attributes: attrs, status: { code: info.status >= 500 ? 2 : 1 } }] }] }] };
}
function zcOtelExport(env, ctx, tp, spanId, info) {
  const ep = zcV(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!ep) return;
  const rate = zcVNum(env, 'OTEL_SAMPLE', 1);
  if (rate < 1 && Math.random() >= rate) return;
  try {
    const url = ep.replace(/\/+$/, '') + (/\/v1\/traces$/.test(ep) ? '' : '/v1/traces');
    if (!/^https?:\/\//i.test(url)) return;
    const p = fetch(url, { method: 'POST', headers: zcOtelHeaders(env), body: JSON.stringify(zcOtelBuild(env, tp, spanId, info)) }).catch(function () { });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  } catch (e) { /* 观测失败不影响请求 */ }
}
async function zcObserve(request, env, ctx, resp, meta) {
  try {
    const url = new URL(request.url);
    const status = resp ? resp.status : 500;
    const ms = Date.now() - meta.startMs;
    ZC_METRICS.req++; ZC_METRICS['c' + Math.floor(status / 100)] = (ZC_METRICS['c' + Math.floor(status / 100)] || 0) + 1;
    ZC_METRICS.msSum += ms; if (ms > ZC_METRICS.msMax) ZC_METRICS.msMax = ms;
    const route = zcRouteOf(url.pathname);
    const quiet = route === '/__zc_health__' || route === '/favicon.ico';
    const ip = await zcIpTag(zcSecIp(request));
    zcLog(env, quiet ? 'debug' : (status >= 500 ? 'error' : (status >= 400 ? 'warn' : 'info')), 'request', {
      rid: meta.rid, trace: meta.tp.traceId, method: request.method, route: route, status: status, ms: ms, ip: ip,
      bucket: zcSecBucket(url.pathname), owner: meta.owner || undefined, err: meta.err || undefined
    });
    zcOtelExport(env, ctx, meta.tp, meta.spanId, { startMs: meta.startMs, endMs: Date.now(), method: request.method, route: route, status: status, rid: meta.rid, owner: meta.owner || '', bucket: zcSecBucket(url.pathname) });
    zcSiemPushMaybe(env, ctx, { kind: 'http', rid: meta.rid, method: request.method, route: route, status: status, ip: ip }, status >= 400 && /^\/__zc_(auth|admin|ops|sec)__/.test(route));
  } catch (e) { /* ignore */ }
}

/* ==========================================================================
 * B) CSP 补全（按页面里真实的内联脚本逐个算 SHA-256，不再依赖 'unsafe-inline' 放行脚本）
 *    ZC_CSP_MODE=enforce（默认）| report（只上报不拦截，灰度用）| off（回到旧的最小策略）
 *    保留 'unsafe-eval' 与 blob:：Agent 的「语法检查」要用 new Function 与 blob 脚本定位行号。
 *    connect-src 必须放开 https:/http:：用户自配的模型 API（含本机 Ollama）由浏览器直连。
 * ========================================================================== */
function zcCspMode(env) { const m = zcV(env, 'ZC_CSP_MODE').toLowerCase(); return m === 'report' || m === 'off' ? m : 'enforce'; }
async function zcCspHashes(html) {
  const out = []; const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2]) continue;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', zcTE.encode(m[2])));
    out.push("'sha256-" + btoa(String.fromCharCode.apply(null, d)) + "'");
  }
  return out;
}
async function zcCspForHtml(html, env, opt) {
  const hashes = await zcCspHashes(html);
  if (opt && opt.admin) {
    return ["default-src 'none'", "script-src " + hashes.join(' '), "style-src 'unsafe-inline'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "report-uri " + ZC_CSP_REPORT_PATH].join('; ');
  }
  const dirs = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' blob: https://challenges.cloudflare.com " + hashes.join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self' https: http: ws: wss: blob: data:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "report-uri " + ZC_CSP_REPORT_PATH
  ];
  return dirs.join('; ');
}
function zcCspHeaderName(env) { return zcCspMode(env) === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'; }
async function zcHandleCspReport(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let body = '';
  try { body = (await request.text()).slice(0, 4000); } catch (e) { /* ignore */ }
  let rep = null; try { rep = JSON.parse(body); } catch (e) { rep = null; }
  const r = (rep && (rep['csp-report'] || (Array.isArray(rep) ? (rep[0] && rep[0].body) : rep))) || {};
  zcLog(env, 'warn', 'csp-violation', { directive: String(r['violated-directive'] || r.effectiveDirective || '').slice(0, 80), blocked: String(r['blocked-uri'] || r.blockedURL || '').slice(0, 160), doc: String(r['document-uri'] || r.documentURL || '').slice(0, 160) });
  return new Response(null, { status: 204 });
}

/* ==========================================================================
 * C) 身份：zcWho 解析当前请求的账号；仅区分「管理员 / 普通成员」，管理员只用于 /__zc_ops__ 运维接口。
 *    管理员 = 单人自用模式（未启用账号体系），或邮箱在 ZC_ROLE_ADMINS（逗号分隔）里。
 * ========================================================================== */
function zcAdminList(env) { return zcV(env, 'ZC_ROLE_ADMINS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean); }
async function zcWho(request, env) {
  if (!zcStoreReady(env) || !zcAuthEnabled(env)) return { owner: ZC_OWNER_ANON, email: '', role: 'admin', anon: true };
  const sess = await zcAuthSession(request, env);
  if (!sess || !sess.email) return { owner: ZC_OWNER_ANON, email: '', role: 'none', anon: true, noSession: true };
  const email = String(sess.email).toLowerCase();
  let user = null;
  try { user = JSON.parse((await zcKV(env).get(ZC_USER_PREFIX + email)) || 'null'); } catch (e) { user = null; }
  const admins = zcAdminList(env);
  const isAdmin = admins.indexOf(email) >= 0 || !!(user && user.emailVerified && user.contact && admins.indexOf(String(user.contact).toLowerCase()) >= 0);
  return { owner: 'u:' + email, email: email, role: isAdmin ? 'admin' : 'member', anon: false, user: user };
}

/* ===== 以下为多个功能共用的请求体读取小工具（原位于语音段） ===== */
function zcRagBaseOk(base) { try { const u = new URL(base); return u.protocol === 'https:' && !zcIsBlockedHost(u.hostname); } catch (e) { return false; } }
async function zcAuthBodyBig(request, max) {
  try { const t = await request.text(); if (t.length > max) return { __tooLarge: true }; const o = JSON.parse(t || '{}'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}

/* ==========================================================================
 * F) MCP（Model Context Protocol）客户端 —— Streamable HTTP（JSON-RPC 2.0）
 *    管理员全局服务器：MCP_SERVERS = [{"id":"docs","name":"文档","url":"https://…/mcp","headers":{"Authorization":"Bearer …"}}]
 *    用户私有服务器：设置里添加（请求头里的令牌只存服务端，设置 ZC_DATA_KEY 后加密存储，接口永不回显）。
 *    安全：只允许 https 公网地址（SSRF 防护）；可用 ZC_MCP_ALLOW 再限定域名后缀；结果截断到 60KB。
 *    说明：仅支持 Streamable HTTP（含 SSE 流式响应）；不支持 stdio 与旧版纯 SSE 传输。
 * ========================================================================== */
const ZC_MCP_SESS = new Map();
const ZC_MCP_MAX_USER = 10;
const ZC_MCP_MAX_OUT = 60000;
function zcMcpUrlOk(env, url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && zcVBool(env, 'ZC_MCP_ALLOW_HTTP'))) return '只允许 https 地址';
    if (zcIsBlockedHost(u.hostname)) return '不允许内网 / 本机地址';
    if (u.username || u.password) return '地址里不要带账号密码，请用请求头';
    const allow = zcV(env, 'ZC_MCP_ALLOW').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.some((s) => u.hostname === s || u.hostname.endsWith('.' + s.replace(/^\*?\./, '')))) return '域名不在 ZC_MCP_ALLOW 允许范围内';
    return '';
  } catch (e) { return '地址格式不正确'; }
}
function zcMcpCleanHeaders(h) {
  const out = {};
  if (h && typeof h === 'object') Object.keys(h).slice(0, 8).forEach((k) => {
    if (/^[A-Za-z0-9-]{1,40}$/.test(k) && !/^(host|content-length|content-type|accept|mcp-session-id|connection|cookie)$/i.test(k)) out[k] = String(h[k]).replace(/[\r\n]/g, '').slice(0, 2000);
  });
  return out;
}
function zcMcpGlobal(env) {
  try {
    const a = JSON.parse(zcV(env, 'MCP_SERVERS') || '[]');
    return (Array.isArray(a) ? a : []).filter((s) => s && s.url && s.id).map((s) => ({ id: 'g:' + String(s.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), name: String(s.name || s.id).slice(0, 60), url: String(s.url), headers: zcMcpCleanHeaders(s.headers), scope: 'global', enabled: true }));
  } catch (e) { return []; }
}
async function zcMcpUserLoad(env, who) {
  const box = await zcKvGetJson(env, 'zc_mcp:' + await zcOwnerKey(who.owner));
  const out = [];
  for (const s of ((box && box.list) || [])) out.push({ id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false, scope: 'user', headers: (await zcUnseal(env, s.hdr)) || {} });
  return out;
}
async function zcMcpUserSave(env, who, list) {
  const rows = [];
  for (const s of list) rows.push({ id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false, hdr: await zcSeal(env, s.headers || {}) });
  await zcKvPutJson(env, 'zc_mcp:' + await zcOwnerKey(who.owner), { list: rows });
}
function zcMcpPublic(s) { return { id: s.id, name: s.name, url: s.url, scope: s.scope, enabled: s.enabled !== false, headerKeys: Object.keys(s.headers || {}) }; }
async function zcMcpFind(env, who, id) {
  id = String(id || '');
  const all = zcMcpGlobal(env).concat(zcStoreReady(env) ? await zcMcpUserLoad(env, who) : []);
  return all.filter((s) => s.id === id && s.enabled !== false)[0] || null;
}
function zcMcpParse(text, ctype, id) {
  const msgs = [];
  if (/text\/event-stream/i.test(ctype)) {
    String(text).split(/\r?\n\r?\n/).forEach((ev) => {
      const data = ev.split(/\r?\n/).filter((l) => l.indexOf('data:') === 0).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) { try { msgs.push(JSON.parse(data)); } catch (e) { /* 忽略非 JSON 事件 */ } }
    });
  } else { try { const j = JSON.parse(text); if (Array.isArray(j)) j.forEach((x) => msgs.push(x)); else msgs.push(j); } catch (e) { /* ignore */ } }
  return msgs.filter((m) => m && m.id === id)[0] || null;
}
async function zcMcpPost(srv, msg, sid, timeoutMs) {
  const headers = Object.assign({}, srv.headers || {}, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' });
  if (sid) headers['Mcp-Session-Id'] = sid;
  const r = await fetch(srv.url, { method: 'POST', headers: headers, body: JSON.stringify(msg), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs || 30000) });
  if (r.status >= 300 && r.status < 400) throw new Error('MCP 服务器返回了重定向（出于安全不跟随）');
  return r;
}
async function zcMcpInit(srv, force) {
  const key = srv.id + '|' + srv.url;
  const c = ZC_MCP_SESS.get(key);
  if (!force && c && Date.now() - c.at < 4 * 60 * 1000) return c.sid;
  const r = await zcMcpPost(srv, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'zc-gura', version: ZC_VERSION } } }, '', 20000);
  const text = await r.text();
  if (!r.ok) throw new Error('MCP 初始化失败（HTTP ' + r.status + '）：' + text.slice(0, 160));
  const m = zcMcpParse(text, r.headers.get('content-type') || '', 1);
  if (!m || m.error) throw new Error('MCP 初始化失败：' + ((m && m.error && m.error.message) || '响应无法解析'));
  const sid = r.headers.get('mcp-session-id') || '';
  try { await (await zcMcpPost(srv, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 10000)).text(); } catch (e) { /* 通知失败不致命 */ }
  if (ZC_MCP_SESS.size > 100) ZC_MCP_SESS.clear();
  ZC_MCP_SESS.set(key, { sid: sid, at: Date.now() });
  return sid;
}
async function zcMcpRpc(srv, method, params, timeoutMs) {
  const id = 2 + Math.floor(Math.random() * 1e6);
  for (let attempt = 0; attempt < 2; attempt++) {
    const sid = await zcMcpInit(srv, attempt > 0);
    const r = await zcMcpPost(srv, { jsonrpc: '2.0', id: id, method: method, params: params || {} }, sid, timeoutMs);
    const text = await r.text();
    if (r.status === 404 && attempt === 0) { ZC_MCP_SESS.delete(srv.id + '|' + srv.url); continue; }
    if (!r.ok) throw new Error('MCP 请求失败（HTTP ' + r.status + '）：' + text.slice(0, 160));
    const m = zcMcpParse(text, r.headers.get('content-type') || '', id);
    if (!m) throw new Error('MCP 响应无法解析');
    if (m.error) throw new Error('MCP 错误：' + (m.error.message || JSON.stringify(m.error)).slice(0, 300));
    return m.result;
  }
  throw new Error('MCP 会话重建后仍失败');
}
async function zcMcpTools(srv) {
  const out = []; let cursor;
  for (let i = 0; i < 5; i++) {
    const res = await zcMcpRpc(srv, 'tools/list', cursor ? { cursor: cursor } : {}, 20000);
    (res.tools || []).forEach((t) => out.push({ name: String(t.name || '').slice(0, 80), description: String(t.description || '').slice(0, 600), inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
    if (!res.nextCursor) break; cursor = res.nextCursor;
  }
  return out.slice(0, 200);
}
function zcMcpFlatten(res) {
  const parts = [];
  ((res && res.content) || []).forEach((c) => {
    if (!c) return;
    if (c.type === 'text') parts.push(String(c.text || ''));
    else if (c.type === 'resource' && c.resource) parts.push(String(c.resource.text || '[资源 ' + (c.resource.uri || '') + ']'));
    else if (c.type === 'image') parts.push('[图片 ' + (c.mimeType || '') + ']');
    else parts.push('[' + c.type + ']');
  });
  if (res && res.structuredContent && !parts.length) parts.push(JSON.stringify(res.structuredContent));
  let s = parts.join('\n');
  if (s.length > ZC_MCP_MAX_OUT) s = s.slice(0, ZC_MCP_MAX_OUT) + '\n[输出过长已截断]';
  return s;
}
async function zcHandleMcp(request, env, ctx, who, sub, rid) {
  if (sub === 'servers' && request.method === 'GET') {
    const user = zcStoreReady(env) ? await zcMcpUserLoad(env, who) : [];
    return zcJson({ ok: true, servers: zcMcpGlobal(env).concat(user).map(zcMcpPublic) });
  }
  if (request.method !== 'POST') return zcJson({ error: '方法不允许' }, 405);
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const body = await zcAuthBodyBig(request, 256 * 1024);
  if (body && body.__tooLarge) return zcJson({ error: '请求内容过大', code: 'TOO_LARGE' }, 413);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  if (sub === 'servers') {
    if (!zcStoreReady(env)) return zcJson({ error: '需要绑定 KV / D1 才能保存 MCP 服务器', code: 'STORE_REQUIRED' }, 501);
    const list = await zcMcpUserLoad(env, who);
    if (body.action === 'add') {
      if (list.length >= ZC_MCP_MAX_USER) return zcJson({ error: '最多添加 ' + ZC_MCP_MAX_USER + ' 个私有 MCP 服务器' }, 400);
      const bad = zcMcpUrlOk(env, body.url); if (bad) return zcJson({ error: bad }, 400);
      const name = String(body.name || '').trim().slice(0, 60) || new URL(body.url).hostname;
      const s = { id: 'u:' + zcRandHex(5), name: name, url: String(body.url), enabled: true, headers: zcMcpCleanHeaders(body.headers) };
      list.push(s); await zcMcpUserSave(env, who, list);
      return zcJson({ ok: true, server: zcMcpPublic(Object.assign({ scope: 'user' }, s)) });
    }
    if (body.action === 'remove' || body.action === 'toggle') {
      const i = list.findIndex((s) => s.id === body.id); if (i < 0) return zcJson({ error: '找不到该服务器' }, 404);
      if (body.action === 'remove') list.splice(i, 1); else list[i].enabled = body.enabled !== false;
      await zcMcpUserSave(env, who, list); return zcJson({ ok: true });
    }
    return zcJson({ error: '未知操作' }, 400);
  }
  if (sub === 'tools' || sub === 'call') {
    const srv = await zcMcpFind(env, who, body.serverId);
    if (!srv) return zcJson({ error: '找不到或已停用该 MCP 服务器', code: 'MCP_NOT_FOUND' }, 404);
    const bad = zcMcpUrlOk(env, srv.url); if (bad && srv.scope !== 'global') return zcJson({ error: bad }, 400);
    const t0 = Date.now();
    try {
      if (sub === 'tools') return zcJson({ ok: true, serverId: srv.id, tools: await zcMcpTools(srv) });
      const tool = String(body.tool || '').slice(0, 120);
      if (!tool) return zcJson({ error: '缺少 tool' }, 400);
      const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
      const res = await zcMcpRpc(srv, 'tools/call', { name: tool, arguments: args }, 60000);
      zcAuditAppend(env, { owner: who.owner, actor: 'mcp', type: 'mcp_call', target: srv.name + ' / ' + tool, status: res && res.isError ? 'error' : 'ok', ms: Date.now() - t0, reason: 'rid=' + rid }, ctx);
      return zcJson({ ok: true, isError: !!(res && res.isError), text: zcMcpFlatten(res), ms: Date.now() - t0 });
    } catch (e) {
      zcAuditAppend(env, { owner: who.owner, actor: 'mcp', type: 'mcp_call', target: srv.name + ' / ' + String(body.tool || ''), status: 'error', result: String(e && e.message || e), reason: 'rid=' + rid }, ctx);
      return zcJson({ error: zcMaskSecrets(String(e && e.message || e), env), code: 'MCP_FAILED', requestId: rid }, 502);
    }
  }
  return zcJson({ error: '未知的 MCP 接口' }, 404);
}

/* ==========================================================================
 * 用户记录 / 会话的公共小工具（与既有 KV / D1 门面兼容，元数据结构与既有写入一致）
 * ========================================================================== */
async function zcUserLoad(env, email) {
  try { return JSON.parse((await zcKV(env).get(ZC_USER_PREFIX + email)) || 'null'); } catch (e) { return null; }
}
async function zcUserSave(env, user) {
  const v = JSON.stringify(user);
  const o = { metadata: { c: user.createdAt || Date.now(), l: user.lastLoginAt || 0, a: user.lastActiveAt || 0, h: user.hash || '', gh: user.ghLogin || '', iv: user.provider === 'invite' ? 1 : 0 } };
  await zcKV(env).put(ZC_USER_PREFIX + user.email, v, o);
  await zcKvMirror(env, ZC_USER_PREFIX + user.email, v, o);
}
async function zcIssueSession(env, user, provider, extra) {
  const now = Date.now(); const token = zcRandHex(32);
  const key = ZC_SESS_PREFIX + (await zcSha256Hex(token));
  const val = JSON.stringify(Object.assign({ email: user.email, createdAt: now, seenAt: now, provider: provider }, extra || {}));
  const o = { expirationTtl: ZC_SESS_TTL_SEC, metadata: { e: user.email, p: provider } };
  await zcKV(env).put(key, val, o); await zcKvMirror(env, key, val, o);
  return token;
}

/* ==========================================================================
 * I) Google / Microsoft 登录（OpenID Connect · 授权码 + PKCE）
 *    GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET            回调：https://<域名>/__zc_auth__/google/callback
 *    MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET       回调：https://<域名>/__zc_auth__/microsoft/callback
 *    MICROSOFT_OAUTH_TENANT（默认 common；公司内部用请填租户 ID，避免任意微软账号都能登录）
 *    ZC_AUTH_OAUTH_DOMAINS 可选：仅允许这些邮箱域名（只对 Google 已验证邮箱生效）
 *    账号标识用「提供方 sub 的哈希」而不是邮箱，避免邮箱未验证 / 改名造成的账号冒用（nOAuth 类问题）。
 * ========================================================================== */
function zcOidcCfg(env, p) {
  if (p === 'google') return { p: p, name: 'Google', id: zcV(env, 'GOOGLE_OAUTH_CLIENT_ID'), secret: zcV(env, 'GOOGLE_OAUTH_CLIENT_SECRET'), auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile', extra: { prompt: 'select_account' } };
  if (p === 'microsoft') { const t = (zcV(env, 'MICROSOFT_OAUTH_TENANT') || 'common').replace(/[^A-Za-z0-9.-]/g, ''); return { p: p, name: 'Microsoft', id: zcV(env, 'MICROSOFT_OAUTH_CLIENT_ID'), secret: zcV(env, 'MICROSOFT_OAUTH_CLIENT_SECRET'), auth: 'https://login.microsoftonline.com/' + t + '/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/' + t + '/oauth2/v2.0/token', userinfo: 'https://graph.microsoft.com/oidc/userinfo', scope: 'openid email profile', extra: { response_mode: 'query', prompt: 'select_account' } }; }
  return null;
}
function zcOidcReady(env, p) { const c = zcOidcCfg(env, p); return !!(c && c.id && c.secret); }
function zcOidcRedirect(request, env, p) { return new URL(request.url).origin + ZC_AUTH_PATH + '/' + p + '/callback'; }
async function zcOidcStart(request, env, p) {
  const c = zcOidcCfg(env, p);
  if (!zcOidcReady(env, p)) return zcJson({ error: '服务端未配置 ' + (c ? c.name : p) + ' 登录', code: 'OIDC_NOT_CONFIGURED' }, 501);
  const url = new URL(request.url);
  if (zcTsEnabled(env)) {
    const tsr = await zcTsVerify(env, url.searchParams.get('ts'), request.headers.get('cf-connecting-ip') || '');
    if (!tsr.ok) return zcAuthGithubBack(request, tsr.net ? '人机验证服务暂时不可用，请稍后重试' : '请先完成人机验证后再登录');
  }
  const state = zcRandHex(16), verifier = zcRandHex(32);
  const challenge = zcB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', zcTE.encode(verifier))));
  await zcKV(env).put('zc_oidc:' + state, JSON.stringify({ p: p, at: Date.now(), verifier: verifier }), { expirationTtl: 600 });
  const u = new URL(c.auth);
  u.searchParams.set('client_id', c.id); u.searchParams.set('redirect_uri', zcOidcRedirect(request, env, p)); u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', c.scope); u.searchParams.set('state', state); u.searchParams.set('code_challenge', challenge); u.searchParams.set('code_challenge_method', 'S256');
  Object.keys(c.extra).forEach((k) => u.searchParams.set(k, c.extra[k]));
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}
async function zcOidcCallback(request, env, p) {
  const c = zcOidcCfg(env, p); const url = new URL(request.url);
  if (!zcOidcReady(env, p)) return zcAuthGithubBack(request, (c ? c.name : p) + ' 登录未配置');
  const state = String(url.searchParams.get('state') || ''), code = String(url.searchParams.get('code') || '');
  if (!/^[a-f0-9]{32}$/.test(state)) return zcAuthGithubBack(request, '登录状态校验失败（state 不合法），请重新登录');
  const kv = zcKV(env); const raw = await kv.get('zc_oidc:' + state);
  try { await kv.delete('zc_oidc:' + state); } catch (e) { /* ignore */ }
  let st = null; try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
  if (!st || st.p !== p) return zcAuthGithubBack(request, '登录已超时或已使用过，请重新点击登录');
  if (url.searchParams.get('error') || !code) return zcAuthGithubBack(request, c.name + ' 授权未完成：' + (url.searchParams.get('error_description') || url.searchParams.get('error') || '未完成授权').slice(0, 200));
  let tok = null;
  try {
    const f = new URLSearchParams({ client_id: c.id, client_secret: c.secret, code: code, redirect_uri: zcOidcRedirect(request, env, p), grant_type: 'authorization_code', code_verifier: st.verifier });
    const tr = await fetch(c.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: f.toString() });
    tok = await tr.json();
  } catch (e) { return zcAuthGithubBack(request, '与 ' + c.name + ' 通信失败'); }
  if (!tok || !tok.access_token) return zcAuthGithubBack(request, '换取令牌失败：' + String((tok && (tok.error_description || tok.error)) || '未知错误').slice(0, 160));
  let info = null;
  try { const ur = await fetch(c.userinfo, { headers: { Authorization: 'Bearer ' + tok.access_token, Accept: 'application/json' } }); if (!ur.ok) return zcAuthGithubBack(request, '读取用户信息失败（HTTP ' + ur.status + '）'); info = await ur.json(); }
  catch (e) { return zcAuthGithubBack(request, '读取用户信息失败'); }
  const sub = String(info && info.sub || ''); if (!sub) return zcAuthGithubBack(request, '未能取得账号标识');
  const mail = String(info.email || info.preferred_username || '').toLowerCase();
  const verified = p === 'google' ? info.email_verified === true : false;
  const doms = zcV(env, 'ZC_AUTH_OAUTH_DOMAINS').toLowerCase().split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
  if (doms.length) {
    const dom = mail.split('@')[1] || '';
    if (p !== 'google' || !verified || doms.indexOf(dom) < 0) return zcAuthGithubBack(request, '该账号不在允许登录的范围内');
  }
  const email = (await zcSha256Hex(p + ':' + sub)).slice(0, 24) + '@' + p;
  const now = Date.now();
  let user = await zcUserLoad(env, email);
  if (!user) user = { email: email, salt: '', hash: '', iter: 0, createdAt: now, lastLoginAt: now };
  user.provider = p; user.oidcSub = sub; user.name = String(info.name || '').slice(0, 80); user.contact = mail; user.emailVerified = verified; user.avatar = String(info.picture || '').slice(0, 300);
  user.lastLoginAt = now; user.lastActiveAt = now;
  await zcUserSave(env, user);
  const label = user.name || mail || email;
  const token = await zcIssueSession(env, user, p, {});
  const ho = zcRandHex(32);
  await kv.put(ZC_GH_HANDOFF_PREFIX + ho, JSON.stringify({ token: token, email: email, provider: p, ghLogin: '', label: label }), { expirationTtl: ZC_GH_HANDOFF_TTL_SEC });
  return new Response(null, { status: 302, headers: { Location: new URL(request.url).origin + '/?zc_handoff=' + ho, 'Cache-Control': 'no-store' } });
}
/* 供既有 zcHandleAuth 调用：返回 Response 表示已处理，null 表示不是我们的路由 */
async function zcV29Auth(sub, method, request, env) {
  const m = /^(google|microsoft)\/(start|callback)$/.exec(sub);
  if (m) {
    if (!zcAuthEnabled(env)) return zcJson({ error: '登录验证已被关闭（ZC_AUTH_DISABLED）' }, 404);
    if (method !== 'GET') return zcJson({ error: '方法不允许' }, 405);
    return m[2] === 'start' ? zcOidcStart(request, env, m[1]) : zcOidcCallback(request, env, m[1]);
  }
  return null;
}

/* ==========================================================================
 * H) 团队共享工作区 —— 把会话「分享到团队」，成员可查看 / 复制成自己的本地会话
 *    角色：owner（管理成员、删任何内容）/ editor（可分享、删自己的）/ viewer（只读）
 *    邀请码：7 天有效，一次性，存哈希。需要登录账号（单人自用 / 未登录模式没有团队概念）。
 * ========================================================================== */
const ZC_TEAM_MAX_TEAMS = 10, ZC_TEAM_MAX_ITEMS = 200, ZC_TEAM_MAX_ITEM_BYTES = 600 * 1024;
async function zcTeamGet(env, id) { return zcKvGetJson(env, 'zc_team:t:' + id); }
async function zcTeamPut(env, t) { return zcKvPutJson(env, 'zc_team:t:' + t.id, t); }
async function zcTeamMine(env, who) { const b = await zcKvGetJson(env, 'zc_team:u:' + await zcOwnerKey(who.owner)); return b && Array.isArray(b.ids) ? b.ids : []; }
async function zcTeamMineSave(env, who, ids) { await zcKvPutJson(env, 'zc_team:u:' + await zcOwnerKey(who.owner), { ids: ids.slice(0, ZC_TEAM_MAX_TEAMS) }); }
function zcTeamPub(t, me) { return { id: t.id, name: t.name, role: t.members[me] || '', members: Object.keys(t.members).map((e) => ({ email: e, role: t.members[e], name: (t.names && t.names[e]) || '' })) }; }
async function zcHandleTeam(request, env, ctx, who, sub, rid) {
  if (who.anon) return zcJson({ error: '团队功能需要登录账号', code: 'AUTH_REQUIRED' }, 401);
  if (!zcStoreReady(env)) return zcJson({ error: '需要绑定 KV / D1', code: 'STORE_REQUIRED' }, 501);
  const me = who.email;
  if (request.method === 'POST' && !zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const url = new URL(request.url);
  const need = async (id, minRole) => {
    const t = await zcTeamGet(env, String(id || '')); if (!t || !t.members[me]) return { err: zcJson({ error: '团队不存在或你不是成员' }, 404) };
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (rank[t.members[me]] < rank[minRole]) return { err: zcJson({ error: '权限不足（需要 ' + minRole + '）', code: 'TEAM_FORBIDDEN' }, 403) };
    return { t: t };
  };
  if (sub === 'list' && request.method === 'GET') {
    const out = []; for (const id of await zcTeamMine(env, who)) { const t = await zcTeamGet(env, id); if (t && t.members[me]) out.push(zcTeamPub(t, me)); }
    return zcJson({ ok: true, teams: out });
  }
  const body = request.method === 'POST' ? (await zcAuthBodyBig(request, ZC_TEAM_MAX_ITEM_BYTES + 4096) || {}) : {};
  if (body.__tooLarge) return zcJson({ error: '内容过大（上限 ' + Math.round(ZC_TEAM_MAX_ITEM_BYTES / 1024) + 'KB）', code: 'TOO_LARGE' }, 413);
  if (sub === 'create') {
    const ids = await zcTeamMine(env, who); if (ids.length >= ZC_TEAM_MAX_TEAMS) return zcJson({ error: '最多加入 ' + ZC_TEAM_MAX_TEAMS + ' 个团队' }, 400);
    const name = String(body.name || '').trim().slice(0, 40); if (!name) return zcJson({ error: '请填写团队名称' }, 400);
    const t = { id: 'tm_' + zcRandHex(8), name: name, createdAt: Date.now(), members: {}, names: {}, invites: [] };
    t.members[me] = 'owner'; t.names[me] = String(who.user && (who.user.name || who.user.contact) || '').slice(0, 40);
    await zcTeamPut(env, t); ids.push(t.id); await zcTeamMineSave(env, who, ids);
    return zcJson({ ok: true, team: zcTeamPub(t, me) });
  }
  if (sub === 'invite') {
    const r = await need(body.teamId, 'owner'); if (r.err) return r.err;
    const code = zcRandHex(6).toUpperCase(); const role = body.role === 'viewer' ? 'viewer' : 'editor';
    r.t.invites = (r.t.invites || []).filter((x) => x.exp > Date.now()).slice(-9);
    r.t.invites.push({ h: await zcSha256Hex('zc-team-inv:' + code), role: role, exp: Date.now() + 7 * 86400000 });
    await zcTeamPut(env, r.t); return zcJson({ ok: true, code: r.t.id + '.' + code, role: role, expiresInDays: 7 });
  }
  if (sub === 'join') {
    const m = /^(tm_[a-f0-9]{16})\.([A-Fa-f0-9]{12})$/.exec(String(body.code || '').trim());
    if (!m) return zcJson({ error: '邀请码格式不正确' }, 400);
    m[2] = m[2].toUpperCase();
    const t = await zcTeamGet(env, m[1]); if (!t) return zcJson({ error: '邀请码无效或已过期' }, 400);
    const h = await zcSha256Hex('zc-team-inv:' + m[2]); const i = (t.invites || []).findIndex((x) => x.h === h && x.exp > Date.now());
    if (i < 0) return zcJson({ error: '邀请码无效或已过期' }, 400);
    const ids = await zcTeamMine(env, who); if (ids.length >= ZC_TEAM_MAX_TEAMS && ids.indexOf(t.id) < 0) return zcJson({ error: '你加入的团队已达上限' }, 400);
    if (!t.members[me]) t.members[me] = t.invites[i].role;
    t.names = t.names || {}; t.names[me] = String(who.user && (who.user.name || who.user.contact) || '').slice(0, 40);
    t.invites.splice(i, 1); await zcTeamPut(env, t);
    if (ids.indexOf(t.id) < 0) { ids.push(t.id); await zcTeamMineSave(env, who, ids); }
    return zcJson({ ok: true, team: zcTeamPub(t, me) });
  }
  if (sub === 'member') {
    const r = await need(body.teamId, 'owner'); if (r.err) return r.err;
    const target = String(body.email || '').toLowerCase(); if (!r.t.members[target]) return zcJson({ error: '成员不存在' }, 404);
    if (target === me) return zcJson({ error: '不能修改自己（owner）' }, 400);
    if (body.action === 'remove') { delete r.t.members[target]; } else if (body.role === 'viewer' || body.role === 'editor') r.t.members[target] = body.role; else return zcJson({ error: '未知操作' }, 400);
    await zcTeamPut(env, r.t);
    if (body.action === 'remove') { const k = 'zc_team:u:' + await zcOwnerKey('u:' + target); const b = await zcKvGetJson(env, k); if (b && b.ids) await zcKvPutJson(env, k, { ids: b.ids.filter((x) => x !== r.t.id) }); }
    return zcJson({ ok: true, team: zcTeamPub(r.t, me) });
  }
  if (sub === 'leave') {
    const r = await need(body.teamId, 'viewer'); if (r.err) return r.err;
    if (r.t.members[me] === 'owner') return zcJson({ error: 'owner 不能直接退出，请先删除团队' }, 400);
    delete r.t.members[me]; await zcTeamPut(env, r.t); await zcTeamMineSave(env, who, (await zcTeamMine(env, who)).filter((x) => x !== r.t.id)); return zcJson({ ok: true });
  }
  /* 删除团队（仅 owner）：先清分享内容与索引，再把团队从每个成员的「我的团队」里摘掉，最后删团队本体——
   * 中途失败时团队记录还在，owner 重试即可；全部成功后邀请码、成员访问、分享内容一并失效。 */
  if (sub === 'disband' && request.method === 'POST') {
    const r = await need(body.teamId, 'owner'); if (r.err) return r.err;
    const t = r.t, xk = 'zc_team:x:' + t.id, kv = zcKV(env);
    const idx = (await zcKvGetJson(env, xk)) || { items: [] };
    for (const it of (Array.isArray(idx.items) ? idx.items : [])) { if (it && it.id) await kv.delete('zc_team:i:' + t.id + ':' + it.id); }
    await kv.delete(xk);
    for (const email of Object.keys(t.members)) {
      const k = 'zc_team:u:' + await zcOwnerKey(email === me ? who.owner : 'u:' + email), b = await zcKvGetJson(env, k);
      if (b && Array.isArray(b.ids) && b.ids.indexOf(t.id) >= 0) await zcKvPutJson(env, k, { ids: b.ids.filter((x) => x !== t.id) });
    }
    await kv.delete('zc_team:t:' + t.id);
    zcAuditAppend(env, { owner: who.owner, actor: 'team', type: 'team_disband', target: t.name, status: 'ok', reason: 'rid=' + rid }, ctx);
    return zcJson({ ok: true });
  }
  if (sub === 'items' && request.method === 'GET') {
    const r = await need(url.searchParams.get('teamId'), 'viewer'); if (r.err) return r.err;
    const idx = await zcKvGetJson(env, 'zc_team:x:' + r.t.id); return zcJson({ ok: true, items: (idx && idx.items) || [] });
  }
  if (sub === 'item' && request.method === 'GET') {
    const r = await need(url.searchParams.get('teamId'), 'viewer'); if (r.err) return r.err;
    const it = await zcKvGetJson(env, 'zc_team:i:' + r.t.id + ':' + String(url.searchParams.get('id') || '').replace(/[^A-Za-z0-9_-]/g, ''));
    return it ? zcJson({ ok: true, item: it }) : zcJson({ error: '内容不存在' }, 404);
  }
  if (sub === 'share') {
    const r = await need(body.teamId, 'editor'); if (r.err) return r.err;
    const data = JSON.stringify(body.data == null ? null : body.data);
    if (!body.data || data.length > ZC_TEAM_MAX_ITEM_BYTES) return zcJson({ error: '内容为空或过大（上限 ' + Math.round(ZC_TEAM_MAX_ITEM_BYTES / 1024) + 'KB）' }, 413);
    const id = 'it_' + zcRandHex(8); const meta = { id: id, title: String(body.title || '未命名对话').slice(0, 80), by: me, byName: r.t.names && r.t.names[me] || '', at: Date.now(), size: data.length };
    await zcKvPutJson(env, 'zc_team:i:' + r.t.id + ':' + id, Object.assign({ data: body.data }, meta));
    const xk = 'zc_team:x:' + r.t.id; const idx = (await zcKvGetJson(env, xk)) || { items: [] }; idx.items.unshift(meta);
    const dropped = idx.items.splice(ZC_TEAM_MAX_ITEMS);
    for (const d of dropped) { try { await zcKV(env).delete('zc_team:i:' + r.t.id + ':' + d.id); } catch (e) { /* ignore */ } }
    await zcKvPutJson(env, xk, idx);
    zcAuditAppend(env, { owner: who.owner, actor: 'team', type: 'team_share', target: r.t.name + ' / ' + meta.title, status: 'ok', reason: 'rid=' + rid }, ctx);
    return zcJson({ ok: true, item: meta });
  }
  if (sub === 'delete') {
    const r = await need(body.teamId, 'editor'); if (r.err) return r.err;
    const xk = 'zc_team:x:' + r.t.id; const idx = (await zcKvGetJson(env, xk)) || { items: [] };
    const it = idx.items.filter((x) => x.id === body.id)[0]; if (!it) return zcJson({ error: '内容不存在' }, 404);
    if (it.by !== me && r.t.members[me] !== 'owner') return zcJson({ error: '只能删除自己分享的内容', code: 'TEAM_FORBIDDEN' }, 403);
    idx.items = idx.items.filter((x) => x.id !== body.id); await zcKvPutJson(env, xk, idx); try { await zcKV(env).delete('zc_team:i:' + r.t.id + ':' + body.id); } catch (e) { /* ignore */ }
    return zcJson({ ok: true });
  }
  return zcJson({ error: '未知的团队接口' }, 404);
}

/* ==========================================================================
 * K) 向量知识库 RAG —— 嵌入走 OpenAI 兼容 /embeddings（RAG_EMBED_API_KEY / RAG_EMBED_BASE / RAG_EMBED_MODEL，
 *    缺省回退到 OPENAI_API_KEY），向量按人隔离、int8 量化存储，检索用余弦相似度（暴力扫描，适合个人 / 小团队规模）。
 *    限制：每人最多 40 篇文档、单篇 ≤ 10 万字符；检索时需读取全部文档分片（KV/D1 子请求数受限，所以设了篇数上限）。
 * ========================================================================== */
const ZC_RAG_MAX_DOCS = 40, ZC_RAG_MAX_CHARS = 100000;
function zcRagCfg(env) {
  return { key: zcV(env, 'RAG_EMBED_API_KEY') || zcV(env, 'OPENAI_API_KEY'), base: (zcV(env, 'RAG_EMBED_BASE') || 'https://api.openai.com/v1').replace(/\/+$/, ''), model: zcV(env, 'RAG_EMBED_MODEL') || 'text-embedding-3-small' };
}
function zcRagChunks(text) {
  const paras = String(text).replace(/\r/g, '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean); const out = []; let cur = '';
  const push = (s) => { if (s.trim()) out.push(s.trim()); };
  paras.forEach((p) => {
    if (p.length > 900) { push(cur); cur = ''; for (let i = 0; i < p.length; i += 800) push(p.slice(Math.max(0, i - (i ? 100 : 0)), i + 800)); }
    else if ((cur + '\n\n' + p).length > 900) { push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
  });
  push(cur); return out;
}
async function zcRagEmbed(env, texts) {
  const cfg = zcRagCfg(env); const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const r = await fetch(cfg.base + '/embeddings', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.model, input: texts.slice(i, i + 64) }) });
    const t = await r.text(); if (!r.ok) throw new Error('嵌入服务返回 HTTP ' + r.status + '：' + zcMaskSecrets(t.slice(0, 160), env));
    const j = JSON.parse(t); (j.data || []).sort((a, b) => a.index - b.index).forEach((d) => out.push(d.embedding));
  }
  if (out.length !== texts.length) throw new Error('嵌入结果数量不匹配');
  return out;
}
function zcVecQuant(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const q = new Int8Array(v.length); for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] / n * 127))); return zcBufB64(q.buffer); }
function zcVecDecode(b64) { const bin = atob(b64); const q = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) q[i] = (bin.charCodeAt(i) << 24) >> 24; return q; }
function zcCosine(a, b) { let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) || 1); }
async function zcHandleRag(request, env, ctx, who, sub, rid) {
  const cfg = zcRagCfg(env); const on = !!(cfg.key && zcRagBaseOk(cfg.base));
  if (!zcStoreReady(env)) return zcJson({ error: '需要绑定 KV / D1', code: 'STORE_REQUIRED' }, 501);
  const ok = await zcOwnerKey(who.owner); const ixKey = 'zc_rag:i:' + ok;
  const idx = (await zcKvGetJson(env, ixKey)) || { docs: [] };
  if (sub === 'status' && request.method === 'GET') return zcJson({ ok: true, configured: on, model: cfg.model, docs: idx.docs, maxDocs: ZC_RAG_MAX_DOCS, maxChars: ZC_RAG_MAX_CHARS });
  const pidOf = (v) => { const t = String(v == null ? '' : v).trim(); return /^[A-Za-z0-9_-]{1,40}$/.test(t) ? t : ''; };
  if (request.method !== 'POST') return zcJson({ error: '方法不允许' }, 405);
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);
  const body = await zcAuthBodyBig(request, 400 * 1024) || {};
  if (body.__tooLarge) return zcJson({ error: '请求内容过大', code: 'TOO_LARGE' }, 413);
  if (sub === 'delete') {
    const i = idx.docs.findIndex((d) => d.id === body.id); if (i < 0) return zcJson({ error: '文档不存在' }, 404);
    idx.docs.splice(i, 1); await zcKvPutJson(env, ixKey, idx); try { await zcKV(env).delete('zc_rag:d:' + ok + ':' + body.id); } catch (e) { /* ignore */ } return zcJson({ ok: true });
  }
  if (!on) return zcJson({ error: '服务端未配置嵌入服务（请添加 RAG_EMBED_API_KEY 或 OPENAI_API_KEY）', code: 'RAG_NOT_CONFIGURED' }, 501);
  try {
    if (sub === 'add') {
      if (idx.docs.length >= ZC_RAG_MAX_DOCS) return zcJson({ error: '知识库最多 ' + ZC_RAG_MAX_DOCS + ' 篇文档，请先删除一些' }, 400);
      const text = String(body.text || '').slice(0, ZC_RAG_MAX_CHARS); if (text.trim().length < 10) return zcJson({ error: '内容太短' }, 400);
      const chunks = zcRagChunks(text).slice(0, 140); const vecs = await zcRagEmbed(env, chunks);
      const id = 'd_' + zcRandHex(6);
      await zcKvPutJson(env, 'zc_rag:d:' + ok + ':' + id, { chunks: chunks.map((t, i) => ({ t: t, v: zcVecQuant(vecs[i]) })) });
      const meta = { id: id, title: String(body.title || '未命名文档').slice(0, 80), chars: text.length, chunks: chunks.length, at: Date.now() };
      const pid = pidOf(body.projectId); if (pid) meta.projectId = pid;   // v2.32：项目知识库文件 = 带 projectId 标签的文档（不带标签的是全局知识库）
      idx.docs.push(meta); await zcKvPutJson(env, ixKey, idx);
      return zcJson({ ok: true, id: id, chunks: chunks.length });
    }
    if (sub === 'search') {
      const query = String(body.query || '').trim().slice(0, 2000); if (!query) return zcJson({ error: '缺少 query' }, 400);
      const k = Math.max(1, Math.min(8, parseInt(body.k, 10) || 4));
      const qv = zcVecDecode(zcVecQuant((await zcRagEmbed(env, [query]))[0])); const hits = [];
      /* v2.32：范围过滤。传 projectId = 只检索该项目的文档（includeGlobal 为真时再加上全局文档）；不传 = 只检索全局文档（不带项目标签的），
       * 这样项目里的文件不会漏进普通对话，旧版本上传的文档（都没有标签）行为完全不变。 */
      const qpid = pidOf(body.projectId); const incGlobal = !!body.includeGlobal;
      const scoped = idx.docs.filter((d) => qpid ? (d.projectId === qpid || (incGlobal && !d.projectId)) : !d.projectId);
      for (const d of scoped) { const doc = await zcKvGetJson(env, 'zc_rag:d:' + ok + ':' + d.id); ((doc && doc.chunks) || []).forEach((c) => hits.push({ doc: d.id, title: d.title, text: c.t, score: zcCosine(qv, zcVecDecode(c.v)) })); }
      hits.sort((a, b) => b.score - a.score);
      return zcJson({ ok: true, hits: hits.slice(0, k).map((h) => ({ doc: h.doc, title: h.title, text: h.text, score: +h.score.toFixed(4) })) });
    }
  } catch (e) { return zcJson({ error: zcMaskSecrets(String(e && e.message || e), env), code: 'RAG_FAILED', requestId: rid }, 502); }
  return zcJson({ error: '未知的知识库接口' }, 404);
}

/* ==========================================================================
 * M) SIEM 审计归档（实时转发；「导出审计」已移除）
 *    实时转发：SIEM_URL（HTTPS）+ SIEM_TOKEN；SIEM_FORMAT=splunk 时用 Splunk HEC 格式（Authorization: Splunk <token>），
 *       否则为 JSON + Bearer；设置 SIEM_HMAC_KEY 后请求头带 X-ZC-Signature: sha256=<hex>（接收端可验签）。
 *       转发内容：所有审计条目；以及登录 / 管理 / 运维接口的 4xx、5xx 请求（SIEM_HTTP_ALL=1 则转发全部请求）。失败只记日志，不阻塞业务。
 * ========================================================================== */
function zcSiemPushMaybe(env, ctx, ev, force) {
  try {
    const url = zcV(env, 'SIEM_URL'); if (!url || !/^https:\/\//i.test(url)) return;
    if (!force && !zcVBool(env, 'SIEM_HTTP_ALL') && ev.kind === 'http') return;
    const p = zcSiemSend(env, Object.assign({ ts: new Date().toISOString(), svc: 'zc-gura', ver: ZC_VERSION }, ev)).catch(function () { });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  } catch (e) { /* ignore */ }
}
async function zcSiemSend(env, ev) {
  const splunk = zcV(env, 'SIEM_FORMAT').toLowerCase() === 'splunk';
  const body = JSON.stringify(splunk ? { time: Date.now() / 1000, sourcetype: 'zc-gura', event: ev } : ev);
  const h = { 'Content-Type': 'application/json' };
  const tok = zcV(env, 'SIEM_TOKEN'); if (tok) h.Authorization = (splunk ? 'Splunk ' : 'Bearer ') + tok;
  const hk = zcV(env, 'SIEM_HMAC_KEY'); if (hk) h['X-ZC-Signature'] = 'sha256=' + zcHexOf(await zcHmacSha256(zcTE.encode(hk), zcTE.encode(body)));
  const r = await fetch(zcV(env, 'SIEM_URL'), { method: 'POST', headers: h, body: body, signal: AbortSignal.timeout(8000) });
  if (!r.ok) zcLog(env, 'warn', 'siem-forward-failed', { status: r.status });
}
/* ==========================================================================
 * N) 管理接口 /__zc_ops__（仅 admin 角色）
 * ========================================================================== */
async function zcHandleOps(request, env, ctx, who, sub) {
  if (sub === 'status' && request.method === 'GET') {
    return zcJson({ ok: true, version: ZC_VERSION, store: zcStoreMode(env), uptimeSec: Math.floor((Date.now() - ZC_METRICS.since) / 1000), metrics: ZC_METRICS,
      features: { mcp: zcMcpGlobal(env).length, google: zcOidcReady(env, 'google'), microsoft: zcOidcReady(env, 'microsoft'), rag: !!zcRagCfg(env).key, siem: !!zcV(env, 'SIEM_URL'), otel: !!zcV(env, 'OTEL_EXPORTER_OTLP_ENDPOINT'), csp: zcCspMode(env), sealed: !!zcV(env, 'ZC_DATA_KEY') } });
  }
  return zcJson({ error: '未知的运维接口' }, 404);
}

/* ==========================================================================
 * 路由：被 zcSecDispatch 在「登录守卫之后」调用。返回 Response = 已处理；null = 继续走旧路由。
 * ========================================================================== */
const ZC_V29_PREFIXES = [ZC_MCP_PATH, ZC_TEAM_PATH, ZC_RAG_PATH, ZC_OPS_PATH];
async function zcV29Route(request, env, ctx, path, meta) {
  const rid = meta && meta.rid || '';
  if (path === ZC_CSP_REPORT_PATH) return zcHandleCspReport(request, env);
  const pre = ZC_V29_PREFIXES.filter((p) => path === p || path.indexOf(p + '/') === 0)[0] || '';
  if (!pre) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: zcCorsHeaders() });
  { const deny = await zcAuthGuard(request, env); if (deny) return deny; }
  const who = await zcWho(request, env);
  if (meta) meta.owner = who.anon ? '' : (await zcOwnerKey(who.owner));
  if (pre === ZC_OPS_PATH && who.role !== 'admin') return zcJson({ error: '需要管理员权限', code: 'ADMIN_ONLY', requestId: rid || undefined }, 403);
  const sub = path.slice(pre.length).replace(/^\/+/, '');
  if (pre === ZC_MCP_PATH) return zcHandleMcp(request, env, ctx, who, sub, rid);
  if (pre === ZC_TEAM_PATH) return zcHandleTeam(request, env, ctx, who, sub, rid);
  if (pre === ZC_RAG_PATH) return zcHandleRag(request, env, ctx, who, sub, rid);
  if (pre === ZC_OPS_PATH) return zcHandleOps(request, env, ctx, who, sub);
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const meta = { startMs: Date.now(), rid: zcReqId(request), tp: zcTraceparent(request), spanId: zcRandHex(8), owner: '', err: '' };
    ZC_REQ_META.set(request, meta);
    let resp = null;
    try {
      const gate = await zcSecGate(request, env, ctx);
      resp = gate ? gate : await zcSecDispatch(request, env, ctx);
    } catch (e) {
      const msg = zcSecRedact(String((e && e.message) || e), env);
      zcSecNote('error', msg);
      meta.err = msg.slice(0, 160);
      try {
        // v2.25：错误审计归属到当前请求的账号（拿不到身份时落到匿名空间）
        const errOwner = await zcRequestOwner(request, env).catch(() => ZC_OWNER_ANON);
        Promise.resolve(zcAuditAppend(env, { owner: errOwner, actor: 'server', type: 'error', reason: msg.slice(0, 240) + ' rid=' + meta.rid, status: 'error' }, ctx)).catch(function () { });
      } catch (e2) { /* 审计失败不影响响应 */ }
      resp = zcJson({ error: '服务器内部错误', code: 'INTERNAL', detail: msg.slice(0, 180), requestId: meta.rid }, 500);
    }
    resp = await zcSecHarden(resp, env);
    try {
      // v2.29：每个响应都带请求 ID（排障时让用户报这个 ID 即可在日志里一条定位）与服务端耗时
      if (resp && !resp.webSocket && resp.status !== 101) {
        const h = new Headers(resp.headers);
        h.set('X-Request-Id', meta.rid);
        h.set('Server-Timing', 'app;dur=' + (Date.now() - meta.startMs));
        resp = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
      }
    } catch (e3) { /* ignore */ }
    const obs = zcObserve(request, env, ctx, resp, meta);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(obs); else await obs;
    return resp;
  }
};

// ---------------------------------------------------------------------------
// 前端页面（由 Worker 原样返回）
// ---------------------------------------------------------------------------
