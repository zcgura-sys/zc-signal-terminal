// ============================================================================
// ZC-GURA · 企业级 AI 对话工作台（Cloudflare Worker 单文件版）
// ----------------------------------------------------------------------------
// 部署：Cloudflare Workers → 新建 Worker → 粘贴本文件 → 部署，即可使用。
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
// 与旧版数据兼容：沿用 localStorage 键前缀 zc_gura_ 及数据结构，同一域名下
// 旧版保存的 API 配置、会话记录、系统提示词会被自动读取。
// ============================================================================

// 账号体系（QQ 邮箱验证码注册 / 登录）使用 TCP Socket 连接 QQ 邮箱 SMTP；所需环境变量见下方「账号体系」一节。
import { connect } from 'cloudflare:sockets';

const ZC_VERSION = '2.0.0';
const ZC_RELAY_PATH = '/__zc_relay__';
const ZC_KV_PATH = '/__zc_kv__';
const ZC_HEALTH_PATH = '/__zc_health__';
const ZC_KV_KEY_PREFIX = 'zc_sync:';
const ZC_KV_MAX_BYTES = 8 * 1024 * 1024;          // 单个同步空间上限（KV 单值上限 25MB）
const ZC_RELAY_DEFAULT_TIMEOUT_MS = 240000;       // 等待上游响应头（非流式+深度思考可能很久）
const ZC_RELAY_MAX_TIMEOUT_MS = 600000;
const ZC_RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024; // 请求体上限（含 base64 图片）

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
// 账号体系：QQ 邮箱验证码注册 / 登录 / 管理员查看用户
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

// ---- 登录会话 ----
const zcSessCache = new Map(); // isolate 内短时缓存，减少 KV 读取（退出登录后最多延迟 30 秒在其他 isolate 失效）

async function zcAuthSession(request, env) {
  const token = String(request.headers.get('x-zc-session') || '');
  if (!/^[a-f0-9]{64}$/.test(token) || !env || !env.ZC_KV) return null;
  const key = ZC_SESS_PREFIX + (await zcSha256Hex(token));
  const now = Date.now();
  const c = zcSessCache.get(key);
  if (c && c.exp > now) return c.val;
  const raw = await env.ZC_KV.get(key);
  if (!raw) { zcSessCache.delete(key); return null; }
  let val = null;
  try { val = JSON.parse(raw); } catch (e) { return null; }
  if (zcSessCache.size > 500) zcSessCache.clear();
  zcSessCache.set(key, { val, exp: now + 30000 });
  return val;
}

// 保护 /__zc_relay__ 与 /__zc_kv__：未登录一律拒绝（返回 Response 表示拦截，null 表示放行）
async function zcAuthGuard(request, env) {
  if (!zcAuthEnabled(env) || request.method === 'OPTIONS') return null;
  const extra = { 'x-zc-auth': 'required' };
  if (new URL(request.url).pathname === ZC_RELAY_PATH) extra['x-zc-relay-error'] = '1';
  if (!env || !env.ZC_KV) {
    return zcJson({ error: '已启用登录验证，但 Worker 未绑定 KV（变量名 ZC_KV）', code: 'AUTH_NOT_CONFIGURED' }, 503, extra);
  }
  if (await zcAuthSession(request, env)) return null;
  return zcJson({ error: '未登录或登录已过期，请重新登录', code: 'AUTH_REQUIRED' }, 401, extra);
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

  const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
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
  const kv = env.ZC_KV;
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
  const kv = env.ZC_KV;
  const body = await zcAuthBody(request);
  if (!body) return zcJson({ error: '请求格式错误' }, 400);
  const email = zcAuthNormEmail(body.email);
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
  await kv.put(ZC_SESS_PREFIX + (await zcSha256Hex(token)), JSON.stringify({ email, createdAt: now }), { expirationTtl: ZC_SESS_TTL_SEC });
  user.lastLoginAt = now;
  await kv.put(ZC_USER_PREFIX + email, JSON.stringify(user), { metadata: { c: user.createdAt, l: now, h: user.hash } });
  return zcJson({ ok: true, token, email });
}

async function zcAuthAdminUsers(request, env) {
  const kv = env.ZC_KV;
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
      users.push({ email: k.name.slice(ZC_USER_PREFIX.length), passwordHash: m.h || '', createdAt: m.c || 0, lastLoginAt: m.l || 0 });
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  users.sort((a, b) => b.createdAt - a.createdAt);
  return zcJson({ total: users.length, users });
}

async function zcHandleAuth(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: zcCorsHeaders() });
  if (!zcIsSameOriginRequest(request)) return zcJson({ error: '禁止跨站调用该接口' }, 403);

  const sub = new URL(request.url).pathname.slice(ZC_AUTH_PATH.length).replace(/^\//, '');
  const method = request.method;
  const kv = env && env.ZC_KV;

  try {
    if (sub === 'status' && method === 'GET') {
      return zcJson({ enabled: zcAuthEnabled(env), kv: !!kv, mail: zcMailReady(env), domains: zcAuthDomains(env), passMin: ZC_PASS_MIN });
    }
    if (!kv) return zcJson({ error: '未绑定 KV 命名空间（变量名 ZC_KV），登录注册不可用', code: 'AUTH_NOT_CONFIGURED' }, 501);
    if (sub === 'admin/users' && method === 'GET') return await zcAuthAdminUsers(request, env);
    if (!zcAuthEnabled(env)) return zcJson({ error: '登录验证已被关闭（ZC_AUTH_DISABLED）' }, 404);

    if (sub === 'send-code' && method === 'POST') return await zcAuthSendCode(request, env);
    if (sub === 'register' && method === 'POST') return await zcAuthRegister(request, env);
    if (sub === 'login' && method === 'POST') return await zcAuthLogin(request, env);
    if (sub === 'me' && method === 'GET') {
      const s = await zcAuthSession(request, env);
      if (!s) return zcJson({ error: '未登录或登录已过期', code: 'AUTH_REQUIRED' }, 401, { 'x-zc-auth': 'required' });
      return zcJson({ ok: true, email: s.email });
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
const ZC_ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ZC-GURA · 用户管理</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f7f7f8;color:#18181b}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 16px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.bar input{height:36px;border:1px solid #d3d3da;border-radius:9px;padding:0 12px;background:#fff;min-width:0;flex:1 1 220px}
.bar button{height:36px;border:0;border-radius:9px;padding:0 18px;background:#18181b;color:#fff;cursor:pointer}
#msg{margin:0 0 12px;color:#55555e}
.scroll{overflow-x:auto;background:#fff;border:1px solid #e6e6ea;border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #efeff2;vertical-align:top}
th{font-weight:600;color:#55555e;background:#fafafb;white-space:nowrap}
tr:last-child td{border-bottom:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:#55555e}
.note{margin-top:12px;font-size:12px;color:#8b8b95}
</style>
</head>
<body>
<div class="wrap">
<h1>ZC-GURA · 用户管理</h1>
<div class="bar">
<input id="tk" type="password" placeholder="管理员口令（ZC_ADMIN_TOKEN）" autocomplete="off">
<button id="go" type="button">查看用户</button>
<input id="q" type="search" placeholder="按邮箱搜索">
</div>
<p id="msg">请输入管理员口令后点击“查看用户”。</p>
<div class="scroll"><table id="tb" hidden><thead><tr><th>#</th><th>邮箱</th><th>密码（PBKDF2-SHA256 哈希）</th><th>注册时间</th><th>最近登录</th></tr></thead><tbody></tbody></table></div>
<p class="note">出于安全考虑，系统只保存密码的加盐哈希，管理员也无法看到明文密码。</p>
</div>
<script>
(function () {
  var tk = document.getElementById('tk'), go = document.getElementById('go'), q = document.getElementById('q');
  var msg = document.getElementById('msg'), tb = document.getElementById('tb'), body = tb.querySelector('tbody');
  var all = [];
  function fmt(t) { return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-'; }
  function render() {
    var kw = q.value.trim().toLowerCase(), n = 0;
    body.textContent = '';
    all.forEach(function (u) {
      if (kw && u.email.indexOf(kw) < 0) return;
      n++;
      var tr = document.createElement('tr');
      [String(n), u.email, u.passwordHash, fmt(u.createdAt), fmt(u.lastLoginAt)].forEach(function (v, j) {
        var td = document.createElement('td');
        td.textContent = v;
        if (j === 2) td.className = 'mono';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    msg.textContent = '共 ' + all.length + ' 个用户' + (kw ? '，匹配 ' + n + ' 个' : '');
  }
  function load() {
    msg.textContent = '加载中…';
    fetch('/__zc_auth__/admin/users', { headers: { 'x-zc-admin-token': tk.value }, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok) { msg.textContent = (x.d && x.d.error) || '请求失败'; tb.hidden = true; return; }
        all = x.d.users || [];
        tb.hidden = false;
        render();
      })
      .catch(function () { msg.textContent = '网络错误，请稍后重试'; tb.hidden = true; });
  }
  go.addEventListener('click', load);
  tk.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
  q.addEventListener('input', render);
})();
</script>
</body>
</html>
`;

function zcAdminPage() {
  return new Response(ZC_ADMIN_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

// ---------------------------------------------------------------------------
// 3) Worker 入口
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === ZC_AUTH_PATH || path.indexOf(ZC_AUTH_PATH + '/') === 0) return zcHandleAuth(request, env);
    if (path === ZC_ADMIN_PATH) return zcAdminPage();
    if (path === ZC_RELAY_PATH || path === ZC_KV_PATH || path.indexOf(ZC_KV_PATH + '/') === 0) {
      const deny = await zcAuthGuard(request, env); // 启用登录验证后，代理与云同步接口必须携带有效会话
      if (deny) return deny;
    }
    if (path === ZC_RELAY_PATH) return zcHandleRelay(request, env);
    if (path === ZC_KV_PATH || path.indexOf(ZC_KV_PATH + '/') === 0) return zcHandleKV(request, env);
    if (path === ZC_HEALTH_PATH) {
      return zcJson({ ok: true, version: ZC_VERSION, kv: !!(env && env.ZC_KV), time: Date.now() });
    }
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    return new Response(request.method === 'HEAD' ? null : ZC_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'SAMEORIGIN',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
      }
    });
  }
};

// ---------------------------------------------------------------------------
// 前端页面（由 Worker 原样返回）
// ---------------------------------------------------------------------------
const ZC_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>ZC-GURA</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='1.5' y='1.5' width='21' height='21' rx='6.5' fill='%2318181b'/%3E%3Cpath d='M8 8.4h8L8 15.6h8' fill='none' stroke='white' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<script>(function(){try{var s=JSON.parse(localStorage.getItem('zc_gura_settings')||'null');var t=s&&s.theme;if(!t){t=localStorage.getItem('zc_gura_dark_mode')==='true'?'dark':'auto'}if(t==='auto'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t);var f=s&&s.fontSize;if(f==='small'||f==='large')document.documentElement.classList.add('fs-'+f)}catch(e){}})();</script>
<style>
:root{
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --bg:#ffffff;--bg-2:#f7f7f8;--bg-3:#efeff2;--surface:#ffffff;
  --border:#e6e6ea;--border-2:#d3d3da;
  --text:#18181b;--text-2:#55555e;--text-3:#8b8b95;
  --accent:#2b5cd9;--accent-soft:#e9effc;--on-accent:#ffffff;
  --primary:#18181b;--on-primary:#ffffff;
  --danger:#cf3a30;--danger-soft:#fdeceb;--ok:#1b8a4d;--ok-soft:#e6f5ec;--warn:#a86a12;--warn-soft:#fbf1df;
  --code-bg:#f6f6f8;--code-head:#efeff2;
  --shadow:0 1px 2px rgba(20,20,30,.04),0 10px 32px rgba(20,20,30,.08);
  --shadow-sm:0 1px 2px rgba(20,20,30,.06);
  --r:12px;--r-sm:8px;--r-lg:20px;--fs:15px;--side-w:268px;
}
html[data-theme="dark"]{
  --bg:#151517;--bg-2:#1a1a1d;--bg-3:#262629;--surface:#1e1e21;
  --border:#2b2b30;--border-2:#3b3b42;
  --text:#ececef;--text-2:#b3b3bb;--text-3:#7d7d88;
  --accent:#7fa2ff;--accent-soft:#232a45;--on-accent:#0c1020;
  --primary:#ececef;--on-primary:#151517;
  --danger:#f07068;--danger-soft:#3a201f;--ok:#4cc38a;--ok-soft:#173226;--warn:#e2ab4d;--warn-soft:#3a2f18;
  --code-bg:#1a1a1d;--code-head:#232327;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 36px rgba(0,0,0,.45);
  --shadow-sm:0 1px 2px rgba(0,0,0,.4);
}
html.fs-small{--fs:14px}html.fs-large{--fs:17px}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:var(--font);font-size:var(--fs);line-height:1.6;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow:hidden}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;background:none;border:0;padding:0}
button:disabled{cursor:not-allowed}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
::selection{background:var(--accent-soft)}
.ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.ic.sm{width:14px;height:14px}.ic.lg{width:22px;height:22px}
.spacer{flex:1}
*{scrollbar-width:thin;scrollbar-color:var(--border-2) transparent}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:8px;border:3px solid transparent;background-clip:content-box}

/* ---------- layout ---------- */
.app{display:flex;height:100%;height:100dvh}
.sidebar{width:var(--side-w);flex:none;background:var(--bg-2);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:12px 10px;gap:8px;transition:margin .22s ease,transform .22s ease}
.app.collapsed .sidebar{margin-left:calc(var(--side-w) * -1)}
.side-top{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 4px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:.2px}
.brand .ic{width:24px;height:24px}
.icon-btn{width:34px;height:34px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:var(--text-2);transition:background .15s,color .15s}
.icon-btn:hover{background:var(--bg-3);color:var(--text)}
.new-chat{display:flex;align-items:center;gap:8px;height:38px;padding:0 12px;border-radius:10px;border:1px solid var(--border-2);background:var(--surface);font-weight:500;transition:background .15s}
.new-chat:hover{background:var(--bg-3)}
.search{position:relative;display:flex;align-items:center}
.search .ic{position:absolute;left:11px;color:var(--text-3);width:16px;height:16px;pointer-events:none}
.search input{width:100%;height:36px;border-radius:10px;border:1px solid transparent;background:var(--bg-3);padding:0 12px 0 34px;outline:none;font-size:.92em}
.search input:focus{border-color:var(--border-2);background:var(--surface)}
.session-list{flex:1;overflow-y:auto;margin:0 -4px;padding:0 4px}
.grp{font-size:.78em;color:var(--text-3);padding:12px 10px 4px}
.sess{position:relative;display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:8px 10px;border-radius:9px;color:var(--text-2);font-size:.93em}
.sess:hover{background:var(--bg-3);color:var(--text)}
.sess.active{background:var(--bg-3);color:var(--text);font-weight:500}
.sess .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .acts{display:none;gap:2px}
.sess:hover .acts,.sess.active .acts{display:flex}
.sess .acts button{width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--text-3)}
.sess .acts button:hover{background:var(--border);color:var(--text)}
.sess .acts .ic{width:14px;height:14px}
.empty-list{color:var(--text-3);font-size:.88em;padding:16px 10px;text-align:center}
.side-bottom{border-top:1px solid var(--border);padding-top:8px;display:flex;flex-direction:column;gap:2px}
.side-link{display:flex;align-items:center;gap:10px;height:38px;padding:0 10px;border-radius:9px;color:var(--text-2);text-align:left}
.side-link:hover{background:var(--bg-3);color:var(--text)}
.side-status{font-size:.78em;color:var(--text-3);padding:2px 10px 0;min-height:18px}
.scrim{display:none}
.main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg)}
.topbar{height:54px;flex:none;display:flex;align-items:center;gap:6px;padding:0 12px}
#btnMenu{display:none}
.app.collapsed #btnMenu{display:inline-flex}
.pill{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 10px 0 12px;border-radius:9px;color:var(--text);font-weight:500;max-width:min(60vw,420px)}
.pill:hover{background:var(--bg-3)}
.pill #modelLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--text-3);flex:none}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.err{background:var(--danger)}
.stage{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.chat{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:auto}
.thread{max-width:820px;margin:0 auto;padding:12px 20px 24px;display:flex;flex-direction:column;gap:22px}
.hero{display:none;text-align:center;padding:0 20px 26px}
.stage.empty{justify-content:center;padding-bottom:6vh}
.stage.empty .hero{display:block}
.stage.empty .chat{display:none;flex:0}
.hero h1{margin:0 0 10px;font-size:1.9em;font-weight:600;letter-spacing:-.01em;line-height:1.25}
.hero p{margin:0 auto;max-width:520px;color:var(--text-2)}
.hero .status{display:inline-flex;align-items:center;gap:8px;margin-top:16px;padding:5px 12px;border-radius:99px;border:1px solid var(--border);font-size:.86em;color:var(--text-2);background:var(--surface)}
.hero .status:hover{border-color:var(--border-2);color:var(--text)}
.hero .logo-big{width:46px;height:46px;margin:0 auto 18px;display:block}
.to-bottom{position:absolute;right:50%;transform:translateX(50%);bottom:132px;width:34px;height:34px;border-radius:50%;background:var(--surface);border:1px solid var(--border-2);box-shadow:var(--shadow-sm);display:flex;align-items:center;justify-content:center;color:var(--text-2);z-index:5}
.to-bottom:hover{color:var(--text)}

/* ---------- composer ---------- */
.composer-wrap{flex:none;width:100%;max-width:820px;margin:0 auto;padding:0 20px 14px}
.composer{background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:10px 12px 8px;transition:border-color .15s,box-shadow .15s}
.composer:focus-within{border-color:var(--text-3)}
.composer.drag{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.chips{display:flex;flex-wrap:wrap;gap:8px;padding:2px 2px 8px}
.chips:empty{display:none}
.chip-att{position:relative;display:flex;align-items:center;gap:8px;max-width:240px;height:44px;padding:0 30px 0 8px;border:1px solid var(--border);border-radius:10px;background:var(--bg-2);font-size:.85em}
.chip-att img{width:32px;height:32px;border-radius:6px;object-fit:cover}
.chip-att .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip-att .sz{color:var(--text-3);font-size:.9em}
.chip-att .rm{position:absolute;top:50%;right:4px;transform:translateY(-50%);width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--text-3)}
.chip-att .rm:hover{background:var(--bg-3);color:var(--text)}
#input{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;padding:4px 4px 6px;max-height:220px;min-height:28px;line-height:1.55}
#input::placeholder{color:var(--text-3)}
.c-tools{display:flex;align-items:center;gap:4px}
.tool{height:32px;min-width:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;gap:6px;color:var(--text-2);padding:0 8px;font-size:.88em;transition:background .15s,color .15s}
.tool:hover{background:var(--bg-3);color:var(--text)}
.tool.on{background:var(--accent-soft);color:var(--accent)}
.tool-scroll{display:flex;align-items:center;gap:4px;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;scroll-behavior:smooth}
.tool-scroll::-webkit-scrollbar{display:none}
.tool-scroll .tool{flex:none}
.send{width:34px;height:34px;border-radius:50%;background:var(--primary);color:var(--on-primary);display:flex;align-items:center;justify-content:center;transition:opacity .15s,transform .1s}
.send:disabled{opacity:.28}
.send:not(:disabled):active{transform:scale(.94)}
.foot{margin:8px 0 0;text-align:center;font-size:.76em;color:var(--text-3)}

/* ---------- messages ---------- */
.msg{display:flex;flex-direction:column;gap:6px;min-width:0}
.msg.user{align-items:flex-end}
.msg.user .bubble{max-width:86%;background:var(--bg-3);padding:9px 14px;border-radius:18px 18px 6px 18px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.msg.user .bubble .att-img{display:block;max-width:100%;max-height:260px;border-radius:10px;margin:2px 0 8px;cursor:zoom-in}
.att-file{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;margin:0 6px 6px 0;border:1px solid var(--border-2);border-radius:9px;background:var(--surface);font-size:.85em;white-space:normal}
.att-file .sz{color:var(--text-3)}
.pruned{display:inline-block;padding:4px 10px;border:1px dashed var(--border-2);border-radius:8px;color:var(--text-3);font-size:.82em;margin:0 6px 6px 0}
.msg.ai .head{display:flex;align-items:center;gap:8px;color:var(--text-2);font-size:.85em}
.msg.ai .head .ic{width:20px;height:20px;color:var(--text)}
.msg.ai .head .who{font-weight:500;color:var(--text)}
.msg.ai .head .mt{color:var(--text-3)}
.msg.ai .body{min-width:0;padding-left:0}
.msg.ai.err .body{color:var(--danger)}
.actions{display:flex;gap:2px;margin-left:-6px;opacity:0;transition:opacity .15s}
.msg:hover .actions,.msg:focus-within .actions,.msg.last .actions{opacity:1}
.msg.user .actions{margin:0 -6px 0 0}
.act{height:28px;padding:0 8px;border-radius:8px;display:inline-flex;align-items:center;gap:5px;color:var(--text-3);font-size:.8em}
.act:hover{background:var(--bg-3);color:var(--text)}
.act .ic{width:15px;height:15px}
.act.ok{color:var(--ok)}
.cursor::after{content:"";display:inline-block;width:7px;height:1em;margin-left:2px;vertical-align:-2px;background:var(--text);border-radius:2px;animation:blink 1s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
.typing{display:inline-flex;gap:5px;padding:8px 0}
.typing i{width:6px;height:6px;border-radius:50%;background:var(--text-3);animation:bounce 1.2s infinite ease-in-out}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes bounce{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
.sys-note{align-self:center;font-size:.8em;color:var(--text-3);padding:2px 12px;border-radius:99px;background:var(--bg-2)}
.edit-box{width:100%;max-width:100%}
.edit-box textarea{width:100%;min-height:80px;resize:vertical;padding:10px 12px;border:1px solid var(--border-2);border-radius:12px;background:var(--surface);outline:none}
.edit-box .row{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.err-actions{display:flex;gap:8px;margin-top:8px}

/* thinking */
.think{margin:0 0 10px;border:1px solid var(--border);border-radius:12px;background:var(--bg-2);overflow:hidden}
.think-h{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 12px;color:var(--text-2);font-size:.86em;line-height:1.2;text-align:left}
.think-h .tl{display:block;line-height:1.2}
.think-h:hover{color:var(--text)}
.think-h .ic{transition:transform .2s}
.think.collapsed .think-h .ic{transform:rotate(-90deg)}
.think.active .think-h .tl{background:linear-gradient(90deg,var(--text-3),var(--text),var(--text-3));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 1.8s linear infinite}
@keyframes shine{to{background-position:-200% 0}}
.think-b{padding:2px 14px 12px;color:var(--text-2);font-size:.9em;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;border-top:1px solid var(--border)}
.think.collapsed .think-b{display:none}

/* markdown */
.md{word-break:break-word;overflow-wrap:anywhere}
.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md p{margin:0 0 .85em}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:1.3em 0 .55em;line-height:1.35;font-weight:600}
.md h1{font-size:1.45em}.md h2{font-size:1.25em}.md h3{font-size:1.1em}.md h4,.md h5,.md h6{font-size:1em}
.md ul,.md ol{margin:0 0 .85em;padding-left:1.6em}
.md li{margin:.2em 0}.md li>p{margin:0}
.md li.task{list-style:none;margin-left:-1.3em}
.md li.task input{margin-right:6px;vertical-align:-1px}
.md blockquote{margin:0 0 .85em;padding:.1em 0 .1em 14px;border-left:3px solid var(--border-2);color:var(--text-2)}
.md hr{border:0;border-top:1px solid var(--border);margin:1.4em 0}
.md a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}
.md img{max-width:100%;max-height:520px;border-radius:12px;cursor:zoom-in;display:block;margin:.5em 0}
.md code.ic-code{font-family:var(--mono);font-size:.88em;background:var(--bg-3);padding:.15em .4em;border-radius:6px}
.md .tbl{overflow-x:auto;margin:0 0 .9em;border:1px solid var(--border);border-radius:10px}
.md table{border-collapse:collapse;width:100%;font-size:.92em}
.md th,.md td{padding:8px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.md th{background:var(--bg-2);font-weight:600;white-space:nowrap}
.md tr:last-child td{border-bottom:0}
.code{margin:0 0 .95em;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--code-bg)}
.code-h{display:flex;align-items:center;justify-content:space-between;padding:5px 8px 5px 14px;background:var(--code-head);color:var(--text-3);font-size:.78em;font-family:var(--mono)}
.code-h button{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;color:var(--text-2);font-family:var(--font)}
.code-h button:hover{background:var(--border);color:var(--text)}
.code-h{gap:10px}
.code-act{display:flex;align-items:center;gap:2px;flex:none}
.files-all{margin:.2em 0 .95em}
.fcard{margin:.2em 0 .95em;border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow:hidden}
.fc-h{display:flex;align-items:center;gap:12px;padding:10px 12px;cursor:pointer}
.fcard:not(.gen) .fc-h:hover{background:var(--bg-2)}
.fcard.gen .fc-h{cursor:default}
.fc-ic{flex:none;width:38px;height:38px;border-radius:9px;background:var(--bg-3);color:var(--text-2);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.7em;font-weight:700;letter-spacing:.3px}
.fc-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fc-tx b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fc-tx i{font-style:normal;color:var(--text-3);font-size:.82em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fc-act{display:flex;align-items:center;gap:6px;flex:none}
.fc-act button{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--border-2);background:var(--surface);color:var(--text-2);font-size:.84em}
.fc-act button:hover{background:var(--bg-3);color:var(--text)}
.fc-act .fc-tg{width:30px;padding:0;justify-content:center;border-color:transparent;background:transparent}
.fc-tg .ic{transition:transform .2s}
.fcard.open .fc-tg .ic{transform:rotate(180deg)}
.fc-spin{width:16px;height:16px;margin-right:6px;border:2px solid var(--border-2);border-top-color:var(--text-2);border-radius:50%;animation:fcspin .8s linear infinite}
@keyframes fcspin{to{transform:rotate(360deg)}}
.fc-b{border-top:1px solid var(--border);background:var(--code-bg);max-height:420px;overflow:auto}
.fc-b pre{margin:0;padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:.86em;line-height:1.6;tab-size:2}
.fc-b pre code{font-family:inherit;white-space:pre}
@media (max-width:520px){.fc-cp span{display:none}}
.code pre{margin:0;padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:.86em;line-height:1.6;tab-size:2}
.code pre code{font-family:inherit;white-space:pre}
.tk-c{color:#8a8f98;font-style:italic}.tk-s{color:#1a7f4b}.tk-n{color:#b45309}.tk-k{color:#7c3aed}.tk-t{color:#c2410c}.tk-a{color:#0e7490}
html[data-theme="dark"] .tk-c{color:#7b8190}html[data-theme="dark"] .tk-s{color:#7bd8a4}html[data-theme="dark"] .tk-n{color:#f0b56e}html[data-theme="dark"] .tk-k{color:#b79cff}html[data-theme="dark"] .tk-t{color:#ff9b7a}html[data-theme="dark"] .tk-a{color:#6dd3e8}

/* ---------- popover / dialogs / toast ---------- */
#popLayer{position:fixed;inset:0;z-index:60;pointer-events:none}
.pop{position:fixed;pointer-events:auto;min-width:200px;max-width:min(92vw,360px);max-height:min(70vh,520px);overflow:auto;background:var(--surface);border:1px solid var(--border-2);border-radius:14px;box-shadow:var(--shadow);padding:6px;animation:popin .2s cubic-bezier(.2,.9,.3,1.15);transform-origin:var(--ox,left) var(--oy,top)}
.pop.out{animation:popout .13s ease-in forwards;pointer-events:none}
@keyframes popin{from{opacity:0;transform:translateY(6px) scale(.94)}}
@keyframes popout{to{opacity:0;transform:translateY(4px) scale(.96)}}
.pop .it{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:9px;text-align:left;font-size:.92em}
.pop .it:hover{background:var(--bg-3)}
.pop .it .sub{margin-left:auto;color:var(--text-3);font-size:.85em;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pop .it.sel{font-weight:600}
.pop .it .ck{margin-left:auto;color:var(--accent)}
.pop .sep{height:1px;background:var(--border);margin:6px 4px}
.pop .cap{padding:6px 10px 2px;color:var(--text-3);font-size:.78em}
.pop .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pop select{width:calc(100% - 8px);margin:2px 4px 6px;height:34px;border-radius:9px;border:1px solid var(--border-2);background:var(--surface);padding:0 8px}
.overlay{position:fixed;inset:0;z-index:80;background:rgba(10,10,14,.46);display:flex;align-items:center;justify-content:center;padding:16px;animation:fade .15s}
html[data-theme="dark"] .overlay{background:rgba(0,0,0,.6)}
#dialogOv{z-index:90}
@keyframes fade{from{opacity:0}}
@keyframes sheetin{from{transform:translateY(40px);opacity:.6}}
.dialog{width:min(440px,100%);background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:20px;animation:popin .15s ease-out}
.dialog h3{margin:0 0 8px;font-size:1.05em}
.dialog p{margin:0 0 16px;color:var(--text-2);white-space:pre-wrap}
.dialog input[type=text]{width:100%;height:38px;border:1px solid var(--border-2);border-radius:10px;padding:0 12px;background:var(--surface);outline:none;margin-bottom:16px}
.dialog .row{display:flex;justify-content:flex-end;gap:8px}
.btn{height:36px;padding:0 16px;border-radius:10px;border:1px solid var(--border-2);background:var(--surface);font-weight:500;display:inline-flex;align-items:center;gap:8px;justify-content:center}
.btn:hover{background:var(--bg-3)}
.btn.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.btn.primary:hover{opacity:.9}
.btn.danger{color:var(--danger);border-color:var(--danger)}
.btn.danger.fill{background:var(--danger);color:#fff}
.btn.sm{height:30px;padding:0 12px;font-size:.88em;border-radius:8px}
.btn:disabled{opacity:.5;cursor:not-allowed}
#toasts{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:100;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;width:min(92vw,520px)}
.toast{pointer-events:auto;max-width:100%;padding:9px 14px;border-radius:11px;background:var(--primary);color:var(--on-primary);font-size:.88em;box-shadow:var(--shadow);animation:popin .16s ease-out;display:flex;gap:8px;align-items:center}
.toast.error{background:var(--danger);color:#fff}.toast.ok{background:var(--ok);color:#fff}
.drop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(3px);pointer-events:none;color:var(--text-2);font-size:1.1em}
.drop div{padding:22px 34px;border:2px dashed var(--border-2);border-radius:18px}
.lightbox{position:fixed;inset:0;z-index:95;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out}
.lightbox img{max-width:100%;max-height:100%;border-radius:8px}

/* ---------- settings ---------- */
.settings{width:min(880px,100%);height:min(640px,calc(100dvh - 32px));display:flex;background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);overflow:hidden;animation:popin .16s ease-out}
.s-nav{width:200px;flex:none;min-height:0;overflow-y:auto;background:var(--bg-2);border-right:1px solid var(--border);padding:16px 10px;display:flex;flex-direction:column;gap:2px}
.s-nav h2{margin:0 8px 12px;font-size:1.02em}
.s-nav button{display:flex;align-items:center;gap:10px;height:38px;padding:0 10px;border-radius:9px;color:var(--text-2);text-align:left}
.s-nav button:hover{background:var(--bg-3);color:var(--text)}
.s-nav button.on{background:var(--bg-3);color:var(--text);font-weight:500}
.s-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.s-head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}
.s-head h3{margin:0;font-size:1.02em}
.s-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:20px;scroll-behavior:smooth}
.s-pane{display:none}.s-pane.on{display:block}
.field{margin-bottom:16px}
.field>label,.lbl{display:block;font-size:.85em;font-weight:500;margin-bottom:6px;color:var(--text-2)}
.hint{font-size:.78em;color:var(--text-3);line-height:1.5}
.field .hint{margin-top:5px}
.inp,.field select,.field textarea{width:100%;height:38px;border:1px solid var(--border-2);border-radius:10px;padding:0 12px;background:var(--surface);outline:none}
.field textarea{height:auto;min-height:120px;padding:10px 12px;resize:vertical;line-height:1.55}
.inp:focus,.field select:focus,.field textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.inp.mono{font-family:var(--mono);font-size:.88em}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.inline{display:flex;gap:8px;align-items:center}
.inline .inp{flex:1}
.plist{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.pitem{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:11px;text-align:left;width:100%}
.pitem:hover{background:var(--bg-2)}
.pitem.on{border-color:var(--accent);background:var(--accent-soft)}
.pitem .tt{flex:1;min-width:0}
.pitem .tt b{display:block;font-weight:600;font-size:.93em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pitem .tt span{display:block;color:var(--text-3);font-size:.8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:.72em;padding:2px 8px;border-radius:99px;background:var(--bg-3);color:var(--text-2)}
.tag.cur{background:var(--ok-soft);color:var(--ok)}
.diag{margin-top:12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-2);padding:10px 14px;font-size:.86em}
.diag .ln{display:flex;gap:10px;padding:4px 0;align-items:flex-start}
.diag .ln .ic{margin-top:3px;flex:none}
.diag .ln.ok .ic{color:var(--ok)}.diag .ln.bad .ic{color:var(--danger)}.diag .ln.info .ic{color:var(--text-3)}
.diag .ln small{display:block;color:var(--text-3);word-break:break-word}
.switch{position:relative;width:38px;height:22px;flex:none}
.switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1}
.switch i{position:absolute;inset:0;border-radius:99px;background:var(--border-2);transition:background .15s}
.switch i::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:var(--shadow-sm);transition:transform .15s}
.switch input:checked+i{background:var(--accent)}
.switch input:checked+i::after{transform:translateX(16px)}
.row-sw{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--border)}
.row-sw:last-child{border-bottom:0}
.row-sw .tx b{display:block;font-weight:500;font-size:.93em}
.row-sw .tx span{color:var(--text-3);font-size:.8em}
.seg{display:inline-flex;padding:3px;background:var(--bg-3);border-radius:10px;gap:2px}
.seg button{height:30px;padding:0 14px;border-radius:8px;color:var(--text-2);font-size:.88em}
.seg button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm);font-weight:500}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.stat div{border:1px solid var(--border);border-radius:12px;padding:12px}
.stat b{display:block;font-size:1.15em;font-variant-numeric:tabular-nums}
.stat span{color:var(--text-3);font-size:.78em}
.sub-h{margin:22px 0 10px;font-size:.92em;font-weight:600}
.s-actions{position:sticky;bottom:0;z-index:2;margin:18px -20px -20px;padding:12px 20px calc(16px + env(safe-area-inset-bottom));background:var(--surface);border-top:1px solid var(--border)}
.s-body .s-pane{padding-bottom:4px}


/* ---------- 思考强度：档位计 + 滑动分段控件（参考 Codex 的推理强度切换） ---------- */
.tool{transition:background .2s,color .2s}
.ic.meter rect{fill:currentColor;stroke:none;opacity:.28;transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(.62);transition:opacity .25s ease,transform .38s cubic-bezier(.34,1.7,.5,1)}
.ic.meter rect:nth-child(2){transition-delay:.04s}.ic.meter rect:nth-child(3){transition-delay:.08s}.ic.meter rect:nth-child(4){transition-delay:.12s}
.ic.meter rect.on{opacity:1;transform:scaleY(1)}
#btnDeep.pulse .ic.meter{animation:meterpulse .45s cubic-bezier(.3,1.6,.5,1)}
@keyframes meterpulse{40%{transform:scale(1.22)}}
.lblwrap{position:relative;display:inline-block;height:1.5em;overflow:hidden;white-space:nowrap;vertical-align:middle;transition:width .3s cubic-bezier(.3,.9,.3,1)}
.lblwrap>span{display:block;line-height:1.5em;white-space:nowrap}
.lblwrap>.in,.lblwrap>.lblout{position:absolute;left:0;top:0}
.lblwrap>.in{transform:translateY(105%);opacity:0}
.lblwrap>.in.go{transform:none;opacity:1;transition:transform .3s cubic-bezier(.3,.9,.3,1),opacity .25s}
.lblwrap>.lblout{transition:transform .3s cubic-bezier(.3,.9,.3,1),opacity .2s}
.lblwrap>.lblout.go-up{transform:translateY(-105%);opacity:0}
.lblwrap>.lblout.go-down{transform:translateY(105%);opacity:0}
.lblwrap>.in.from-top{transform:translateY(-105%)}
.deep-pop{width:min(320px,86vw)}
.dp-title{display:flex;align-items:center;justify-content:space-between;padding:8px 10px 6px;font-size:.84em;color:var(--text-2)}
.dp-val{color:var(--text);font-weight:600}
.dseg{position:relative;display:grid;grid-template-columns:repeat(5,1fr);margin:0 4px;padding:3px;border-radius:11px;background:var(--bg-3)}
.dthumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px) / 5);border-radius:8px;background:var(--surface);box-shadow:var(--shadow-sm),0 0 0 1px var(--border-2);transition:transform .38s cubic-bezier(.34,1.35,.5,1)}
.dopt{position:relative;z-index:1;height:32px;border-radius:8px;font-size:.88em;color:var(--text-2);transition:color .2s}
.dopt:hover{color:var(--text)}
.dopt.on{color:var(--text);font-weight:600}
.dp-desc{min-height:2.9em;padding:9px 10px 6px;font-size:.8em;line-height:1.5;color:var(--text-3)}
.dp-desc.swap{animation:descin .28s ease-out}
@keyframes descin{from{opacity:0;transform:translateY(4px)}}

/* ---------- responsive ---------- */
@media (max-width:820px){
  .sidebar{position:fixed;z-index:70;top:0;bottom:0;left:0;margin-left:0!important;transform:translateX(-102%);width:min(84vw,300px);visibility:hidden;transition:transform .22s ease,visibility 0s .22s}
  .app.drawer .sidebar{transform:none;box-shadow:var(--shadow);visibility:visible;transition:transform .22s ease}
  .app.drawer .scrim{display:block;position:fixed;inset:0;z-index:65;background:rgba(0,0,0,.4)}
  #btnMenu{display:inline-flex}
  #btnCollapse{display:none}
  .thread{padding:8px 14px 20px;gap:18px}
  .composer-wrap{padding:0 12px 10px}
  .hero h1{font-size:1.6em}
  .stage.empty{padding-bottom:10vh}
  .msg.user .bubble{max-width:92%}
  .actions{opacity:1}
  .overlay#settingsOv{padding:0;align-items:flex-end}
  .settings{flex-direction:column;width:100%;height:min(92dvh,100dvh - 24px);border-radius:20px 20px 0 0;border-bottom:0;animation:sheetin .26s cubic-bezier(.2,.9,.3,1)}
  .s-body{padding:16px}
  .s-actions{margin:16px -16px -16px;padding:12px 16px calc(14px + env(safe-area-inset-bottom))}
  .s-nav{width:100%;flex:none;flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:10px;border-right:0;border-bottom:1px solid var(--border);gap:4px}
  .s-nav h2{display:none}
  .s-nav button{flex:none;height:34px}
  .two{grid-template-columns:1fr}
  .stat{grid-template-columns:1fr 1fr}
  .foot{display:none}
}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;transition-duration:.001ms!important}}

/* ---------- 首页介绍：输出式（模拟模型流式输出，逐段出现 + 光标） ---------- */
.ty-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ty-b{opacity:0;pointer-events:none;-webkit-user-select:none;user-select:none}
.ty-c{animation:tyin .34s ease-out both}
@keyframes tyin{from{opacity:0;filter:blur(3px)}}
.ty-cur{position:relative}
.ty-cur::after{content:"";position:absolute;left:1px;top:.2em;width:2px;height:1.15em;border-radius:1px;background:var(--text-2);animation:blink 1s steps(2,start) infinite}
.ty-cur.off::after{display:none}

/* ---------- 图标触碰反馈：按下缩放 + 高亮，松开回弹（配合 TouchFx） ---------- */
.icon-btn,.tool,.send,.act,.to-bottom,.chip-att .rm,.sess .acts button,.code-h button,.fc-act button,.side-link,.new-chat,.pill,.s-nav button,.think-h,.pop .it{-webkit-tap-highlight-color:transparent;touch-action:manipulation}
button:has(>.ic){-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.zc-tap{background-image:linear-gradient(color-mix(in srgb,currentColor 13%,transparent),color-mix(in srgb,currentColor 13%,transparent))!important}

/* ---------- 温度调节：圆角矩形滑块，拖动时填充色随数值渐变（冷蓝 → 青绿 → 琥珀 → 红） ---------- */
.tmp-field{--tp:.35;--tc:hsl(158,56%,42%)}
#sTempV{color:var(--tc);font-weight:600;font-variant-numeric:tabular-nums}
.tmp-tag{margin-left:8px;padding:1px 9px;border-radius:99px;font-size:.92em;font-weight:500;color:var(--tc);background:color-mix(in srgb,var(--tc) 15%,transparent)}
.tmp{--th:40px;position:relative;height:var(--th);border-radius:14px;background:var(--bg-3);background:color-mix(in srgb,var(--tc) 9%,var(--bg-3));touch-action:pan-y;-webkit-user-select:none;user-select:none;transition:background-color .2s}
.tmp::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 8%,transparent);pointer-events:none}
.tmp-fill{position:absolute;left:3px;top:3px;bottom:3px;width:calc(var(--th) - 6px + (100% - var(--th)) * var(--tp));border-radius:11px;background-color:var(--tc);background-image:linear-gradient(90deg,color-mix(in srgb,var(--tc) 78%,#fff),var(--tc));box-shadow:0 6px 14px -6px color-mix(in srgb,var(--tc) 70%,transparent);transition:width .18s cubic-bezier(.3,.9,.3,1)}
.tmp-fill::after{content:"";position:absolute;right:10px;top:50%;width:4px;height:16px;margin-top:-8px;border-radius:2px;background:rgba(255,255,255,.95);box-shadow:0 0 0 1px rgba(0,0,0,.06);transition:height .15s,margin-top .15s}
.tmp.drag .tmp-fill{transition:none}
.tmp.drag .tmp-fill::after{height:22px;margin-top:-11px}
.tmp input[type=range]{position:absolute;left:0;top:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:grab;-webkit-appearance:none;appearance:none;background:transparent;touch-action:pan-y}
.tmp input[type=range]:active{cursor:grabbing}
.tmp input[type=range]::-webkit-slider-runnable-track{height:var(--th);background:transparent;border:0}
.tmp input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:var(--th);height:var(--th);margin-top:0;border:0;border-radius:0;background:transparent;box-shadow:none}
.tmp input[type=range]::-moz-range-track{height:var(--th);background:transparent;border:0}
.tmp input[type=range]::-moz-range-thumb{width:var(--th);height:var(--th);border:0;border-radius:0;background:transparent}
.tmp:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}

/* ---------- Coding Agent：目录授权 / 文件树 / 操作日志 / Diff 确认 ---------- */
.tool.agent-on{background:var(--ok-soft);color:var(--ok)}
.agent-bar{display:flex;align-items:center;gap:8px;max-width:820px;margin:0 auto;padding:6px 20px 0;font-size:.84em;color:var(--text-2)}
.agent-bar .nm{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}
.agent-bar .nm svg{width:15px;height:15px;color:var(--ok);flex:none}
.agent-bar .nm b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:600}
.agent-bar .spacer{flex:1}
.agent-bar button{height:26px;padding:0 9px;border-radius:7px;color:var(--text-2);font-size:.94em;white-space:nowrap}
.agent-bar button:hover{background:var(--bg-3);color:var(--text)}
.agent-bar button.stopbtn{color:var(--danger)}

.agent-panel{width:0;flex:none;background:var(--bg-2);border-left:0 solid var(--border);overflow:hidden;display:flex;flex-direction:column;transition:width .22s ease,border-color .22s}
.app.agentOpen .agent-panel{width:320px;border-left-width:1px}
.ag-scrim{display:none}
.ag-head{display:flex;align-items:center;gap:8px;padding:12px 10px 8px;border-bottom:1px solid var(--border);flex:none}
.ag-head b{font-size:.95em;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ag-tabs{display:flex;gap:2px;padding:8px 10px 0;flex:none}
.ag-tabs button{flex:1;height:30px;border-radius:8px 8px 0 0;font-size:.86em;color:var(--text-2);border-bottom:2px solid transparent}
.ag-tabs button:hover{color:var(--text)}
.ag-tabs button.on{color:var(--text);border-color:var(--accent);font-weight:500}
.ag-pane{flex:1;min-height:0;overflow-y:auto;display:none;padding:8px 10px}
.ag-pane.on{display:flex;flex-direction:column}
.ag-empty{color:var(--text-3);font-size:.86em;text-align:center;padding:26px 14px}
.ag-dirbtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:40px;border-radius:10px;border:1px dashed var(--border-2);color:var(--text-2);font-size:.9em;margin:6px 0;flex:none}
.ag-dirbtn:hover{background:var(--bg-3);color:var(--text)}
.ag-foot{flex:none;padding:8px 2px 2px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap}
.ag-foot button{height:26px;padding:0 9px;border-radius:7px;color:var(--text-3);font-size:.8em}
.ag-foot button:hover{background:var(--bg-3);color:var(--text)}

.tree-row{display:flex;align-items:center;gap:5px;height:29px;padding:0 6px;border-radius:7px;color:var(--text-2);font-size:.86em;cursor:pointer;white-space:nowrap}
.tree-row:hover{background:var(--bg-3);color:var(--text)}
.tree-row.active{background:var(--accent-soft);color:var(--accent)}
.tree-row .tw{width:14px;height:14px;flex:none;color:var(--text-3);transition:transform .15s}
.tree-row.open>.tw{transform:rotate(90deg)}
.tree-row .ic{width:15px;height:15px;flex:none}
.tree-row .nm{overflow:hidden;text-overflow:ellipsis}
.tree-kids{margin-left:15px;border-left:1px solid var(--border);padding-left:2px}
.tree-more{color:var(--text-3);font-size:.82em;padding:4px 10px;cursor:pointer}
.tree-more:hover{color:var(--text)}

.ag-preview{border-top:1px solid var(--border);margin:8px -10px -8px;max-height:38vh;display:flex;flex-direction:column;flex:none}
.ag-preview .pv-h{display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:.82em;color:var(--text-2);border-bottom:1px solid var(--border);flex:none}
.ag-preview .pv-h b{font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ag-preview .pv-b{overflow:auto}
.ag-preview pre{margin:0;padding:10px 12px;font-family:var(--mono);font-size:.8em;line-height:1.55}

.astep{border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden;background:var(--surface);flex:none}
.astep-h{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer}
.astep-h svg{width:15px;height:15px;flex:none;color:var(--text-3)}
.astep-h .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.86em;font-family:var(--mono)}
.astep-h .st{flex:none;font-size:.76em;padding:1px 8px;border-radius:99px}
.astep-h .st.ok{background:var(--ok-soft);color:var(--ok)}
.astep-h .st.run{background:var(--accent-soft);color:var(--accent)}
.astep-h .st.err{background:var(--danger-soft);color:var(--danger)}
.astep-h .st.wait{background:var(--warn-soft);color:var(--warn)}
.astep-h .st.skip{background:var(--bg-3);color:var(--text-3)}
.astep-b{display:none;padding:0 10px 10px;font-size:.82em;color:var(--text-2)}
.astep.open .astep-b{display:block}
.astep-b pre{margin:6px 0 0;padding:8px 10px;background:var(--code-bg);border-radius:8px;overflow:auto;font-family:var(--mono);font-size:.92em;max-height:220px;white-space:pre-wrap;word-break:break-word}
.astep .spin{width:12px;height:12px;border-radius:50%;border:2px solid var(--border-2);border-top-color:var(--accent);animation:agspin .7s linear infinite;flex:none}
@keyframes agspin{to{transform:rotate(360deg)}}

.agent-sum{margin:2px 0 6px;border:1px solid var(--border);border-radius:10px;background:var(--bg-2);overflow:hidden}
.agent-sum-h{display:flex;align-items:center;gap:7px;padding:7px 10px;font-size:.84em;color:var(--text-2)}
.agent-sum-h svg{width:14px;height:14px;color:var(--text-3);flex:none}
.agent-sum-h b{color:var(--text);font-weight:500}
.agent-sum-h .cnt{color:var(--text-3)}
.agent-sum-b{display:none;padding:0 10px 8px}
.agent-sum.open .agent-sum-b{display:block}
.agent-sum.open .astep{margin-top:8px}

.diffwrap{border:1px solid var(--border);border-radius:10px;overflow:hidden;margin:10px 0}
.diff-file{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--code-head);font-family:var(--mono);font-size:.86em;border-bottom:1px solid var(--border)}
.diff-file .tag{flex:none;font-size:.74em;padding:1px 8px;border-radius:99px;font-family:var(--font)}
.diff-file .tag.new{background:var(--ok-soft);color:var(--ok)}
.diff-file .tag.mod{background:var(--warn-soft);color:var(--warn)}
.diff-file .tag.del{background:var(--danger-soft);color:var(--danger)}
.diff-body{max-height:46vh;overflow:auto;font-family:var(--mono);font-size:.82em;line-height:1.6}
.dline{display:flex}
.dline .gut{flex:none;width:28px;text-align:center;color:var(--text-3);user-select:none}
.dline .tx{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding-right:8px}
.dline.add{background:color-mix(in srgb,var(--ok) 12%,transparent)}
.dline.add .gut{color:var(--ok)}
.dline.del{background:color-mix(in srgb,var(--danger) 12%,transparent)}
.dline.del .gut{color:var(--danger)}
.dline.big{padding:10px 12px;color:var(--text-3);font-family:var(--font)}
.agent-danger{margin-top:10px;padding:9px 12px;border-radius:9px;background:var(--danger-soft);color:var(--danger);font-size:.86em;display:flex;gap:8px;align-items:flex-start}
.agent-danger svg{flex:none;margin-top:1px;width:16px;height:16px}
.ag-confirm-actions{display:flex;gap:10px;margin-top:12px}

@media (max-width:820px){
  .agent-panel{position:fixed;z-index:70;top:0;bottom:0;right:0;width:min(88vw,340px)!important;transform:translateX(102%);visibility:hidden;border-left:1px solid var(--border);transition:transform .22s ease,visibility 0s .22s}
  .app.agentDrawer .agent-panel{transform:none;visibility:visible;transition:transform .22s ease}
  .app.agentDrawer .ag-scrim{display:block;position:fixed;inset:0;z-index:65;background:rgba(0,0,0,.4)}
  .agent-bar{padding:6px 12px 0}
}

/* ---------- 登录 / 注册 ---------- */
body:not(.authed) .app{display:none}
.auth-screen{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg-2);overflow:auto}
.auth-card{width:min(400px,100%);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:28px 24px 24px;animation:popin .15s ease-out}
.auth-logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:1.15em;margin-bottom:18px}
.auth-logo .ic{width:28px;height:28px}
.auth-seg{display:flex;width:100%;margin-bottom:18px}
.auth-seg button{flex:1}
.auth-msg{margin:0 0 14px;padding:9px 12px;border-radius:10px;font-size:.88em;line-height:1.5;background:var(--danger-soft);color:var(--danger)}
.auth-msg.ok{background:var(--ok-soft);color:var(--ok)}
.auth-code{display:flex;gap:8px}
.auth-code .inp{flex:1;min-width:0;letter-spacing:.2em;font-family:var(--mono)}
.auth-code .btn{flex:none;min-width:120px}
.auth-submit{width:100%;height:40px;margin-top:4px}

/* ==========================================================================
 * 液态玻璃（Liquid Glass）· 参考的五个开源实现（GitHub）：
 *   1. kevinbism/liquid-glass-effect —— 半透明着色 + backdrop blur/saturate +
 *      亮描边 + inset 内高光 / 外投影，负责「玻璃厚度」（右下缘那道白边）
 *   2. nikdelvin/liquid-glass（MIT）—— iOS 26 的边缘折射与色散（chromatic
 *      aberration）。这里用「遮罩渐变描边 + 双色 drop-shadow」做轻量近似，不引入
 *      SVG feDisplacementMap：长文本不会被拉伸，Safari 也不会因为
 *      backdrop-filter: url() 不支持而整块失效（该库同样以 glassmorphism 回退）
 *   3. CodinVisual/ui-effects（MIT · effects/ai_glow.html）—— 用 @property 注册
 *      角度变量，conic-gradient 驱动「柔光晕 + 锐边」双层旋转彩虹环（思考 / 生成态）
 *   4. winaviation/liquid-glass-demo（kube 的 SVG Liquid Glass 移植）—— 随指针
 *      移动的镜面高光与折射光池，构成整页的光照模型
 *   5. CodeLab-creator/liquid-glass-button —— 悬停时掠过可点区域的色散流光扫层
 * 全部为 CSS + 一小段 JS，零外部依赖；不支持 backdrop-filter / mask / @property
 * 的浏览器会走文件末尾的 @supports 回退，退化为不透明面板，文字对比度不受影响。
 * ========================================================================== */

/* ---------- 指针光源坐标（由下方 JS 实时写入） ---------- */
:root{--zc-lx:50%;--zc-ly:-20%;--zc-ring-op:.55;--zc-angle:0deg;--zc-dx:50vw;--zc-dy:14vh}
@property --zc-angle{syntax:'<angle>';initial-value:0deg;inherits:false}
html[data-theme="dark"]{--zc-ring-op:.45}
@keyframes zcSpin{to{--zc-angle:360deg}}

/* ---------- 背景光场：玻璃要有内容才能被“折射”出来 ---------- */
body::before{
  content:"";position:fixed;inset:-12% -8%;z-index:-1;pointer-events:none;opacity:.5;will-change:transform;
  background:
    radial-gradient(44% 46% at 14% 18%,rgba(64,124,255,.34) 0%,rgba(64,124,255,0) 66%),
    radial-gradient(46% 44% at 86% 12%,rgba(0,196,255,.26) 0%,rgba(0,196,255,0) 64%),
    radial-gradient(52% 50% at 82% 88%,rgba(255,110,190,.24) 0%,rgba(255,110,190,0) 66%),
    radial-gradient(46% 46% at 18% 86%,rgba(60,224,180,.22) 0%,rgba(60,224,180,0) 64%),
    radial-gradient(72% 62% at 50% 45%,rgba(255,255,255,.10) 0%,rgba(255,255,255,0) 72%);
  animation:zcAurora 42s ease-in-out infinite alternate
}
html[data-theme="dark"] body::before{opacity:.34}
@keyframes zcAurora{
  0%{transform:translate3d(-2%,-2%,0) scale(1)}
  50%{transform:translate3d(3%,3%,0) scale(1.09)}
  100%{transform:translate3d(-3%,2%,0) scale(1.04)}
}

/* ---------- 跟随光池：一团缓慢追随指针的折射光，只动 transform（GPU 合成） ---------- */
body::after{
  content:"";position:fixed;left:0;top:0;z-index:-1;pointer-events:none;width:560px;height:560px;will-change:transform;
  transform:translate3d(var(--zc-dx,50vw),var(--zc-dy,14vh),0) translate(-50%,-50%);
  transition:transform .55s cubic-bezier(.22,1,.36,1);
  background:
    radial-gradient(closest-side,rgba(255,255,255,.55),rgba(255,255,255,0) 64%),
    radial-gradient(closest-side,color-mix(in srgb,var(--accent) 38%,transparent),color-mix(in srgb,var(--accent) 0%,transparent) 74%)
}
html[data-theme="dark"] body::after{opacity:.75}

/* ---------- 大面积玻璃：主区 / 侧栏 / Agent 面板 / 思考卡片 ---------- */
.main{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(24px) saturate(165%);-webkit-backdrop-filter:blur(24px) saturate(165%);box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.sidebar{background:color-mix(in srgb,var(--bg-2) 76%,transparent);backdrop-filter:blur(22px) saturate(165%);-webkit-backdrop-filter:blur(22px) saturate(165%);border-right-color:color-mix(in srgb,var(--text) 10%,transparent);box-shadow:inset 1px 0 0 rgba(255,255,255,.34)}
html[data-theme="dark"] .main{box-shadow:inset 0 1px 0 rgba(255,255,255,.07)}
html[data-theme="dark"] .sidebar{box-shadow:inset 1px 0 0 rgba(255,255,255,.05)}
.agent-panel{background:color-mix(in srgb,var(--bg-2) 80%,transparent);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%)}
.think{background:color-mix(in srgb,var(--bg-2) 86%,transparent);backdrop-filter:blur(12px) saturate(140%);-webkit-backdrop-filter:blur(12px) saturate(140%);border-color:color-mix(in srgb,var(--text) 10%,transparent)}

/* ---------- 输入区：主玻璃面板（聚焦时变成“凸透镜”） ----------
   右下两条负 spread 的 inset 高光来自 kevinbism 的厚度配方，亮色主题是玻璃切面，
   暗色主题换成冷蓝，避免纯白在深底上过亮。 */
.composer{
  position:relative;isolation:isolate;
  background:linear-gradient(158deg,color-mix(in srgb,var(--surface) 78%,transparent) 0%,color-mix(in srgb,var(--surface) 54%,transparent) 52%,color-mix(in srgb,var(--accent) 14%,transparent) 100%);
  border-color:color-mix(in srgb,var(--text) 12%,transparent);
  backdrop-filter:blur(24px) saturate(185%) brightness(1.04);
  -webkit-backdrop-filter:blur(24px) saturate(185%) brightness(1.04);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.62),inset -10px -8px 0 -11px rgba(255,255,255,.6),inset 0 -9px 0 -8px rgba(255,255,255,.45),inset 0 -12px 26px -20px rgba(255,255,255,.95),0 1px 2px rgba(18,22,54,.06),0 18px 44px -20px rgba(18,22,54,.45)
}
html[data-theme="dark"] .composer{box-shadow:inset 0 1px 0 rgba(255,255,255,.09),inset -10px -8px 0 -11px rgba(126,164,255,.34),inset 0 -9px 0 -8px rgba(126,164,255,.2),inset 0 -14px 30px -22px rgba(255,255,255,.6),0 22px 50px -24px rgba(0,0,0,.72)}
.composer:focus-within{
  --zc-ring-op:.95;
  border-color:color-mix(in srgb,var(--accent) 55%,transparent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.78),inset -10px -8px 0 -11px rgba(255,255,255,.7),inset 0 -9px 0 -8px rgba(255,255,255,.55),inset 0 -14px 30px -20px rgba(255,255,255,1),0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent),0 22px 50px -22px rgba(18,22,54,.5)
}
html[data-theme="dark"] .composer:focus-within{box-shadow:inset 0 1px 0 rgba(255,255,255,.14),inset -10px -8px 0 -11px rgba(126,164,255,.5),inset 0 -9px 0 -8px rgba(126,164,255,.3),inset 0 -14px 30px -22px rgba(255,255,255,.7),0 0 0 3px color-mix(in srgb,var(--accent) 24%,transparent),0 22px 50px -24px rgba(0,0,0,.75)}

/* ---------- 浮层玻璃：菜单 / 对话框 / 设置 / 登录卡 / 通知 ---------- */
.pop{
  background:color-mix(in srgb,var(--surface) 78%,transparent);
  backdrop-filter:blur(26px) saturate(190%);-webkit-backdrop-filter:blur(26px) saturate(190%);
  border-color:color-mix(in srgb,var(--text) 12%,transparent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 22px 50px -22px rgba(14,16,40,.6),0 2px 8px rgba(14,16,40,.14)
}
.dialog{
  position:relative;isolation:isolate;
  background:color-mix(in srgb,var(--surface) 86%,transparent);
  backdrop-filter:blur(30px) saturate(185%);-webkit-backdrop-filter:blur(30px) saturate(185%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 32px 74px -32px rgba(10,12,34,.75),0 4px 14px rgba(10,12,34,.18)
}
.settings{
  position:relative;isolation:isolate;
  background:color-mix(in srgb,var(--surface) 88%,transparent);
  backdrop-filter:blur(32px) saturate(185%);-webkit-backdrop-filter:blur(32px) saturate(185%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 44px 96px -44px rgba(10,12,34,.8)
}
.auth-card{
  position:relative;isolation:isolate;
  background:color-mix(in srgb,var(--surface) 86%,transparent);
  backdrop-filter:blur(28px) saturate(185%);-webkit-backdrop-filter:blur(28px) saturate(185%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 32px 74px -34px rgba(10,12,34,.75)
}
.auth-screen{background:color-mix(in srgb,var(--bg-2) 70%,transparent);backdrop-filter:blur(10px) saturate(150%);-webkit-backdrop-filter:blur(10px) saturate(150%)}
.toast{
  position:relative;isolation:isolate;
  background:color-mix(in srgb,var(--primary) 88%,transparent);
  backdrop-filter:blur(16px) saturate(160%);-webkit-backdrop-filter:blur(16px) saturate(160%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 16px 36px -16px rgba(10,12,34,.75)
}
.toast.error{background:color-mix(in srgb,var(--danger) 90%,transparent)}
.toast.ok{background:color-mix(in srgb,var(--ok) 90%,transparent)}
.overlay{backdrop-filter:blur(8px) saturate(140%);-webkit-backdrop-filter:blur(8px) saturate(140%)}
.drop{backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%)}

/* ---------- 玻璃凝结入场：模糊从 0 长到全量，像水汽在表面结成玻璃 ---------- */
@keyframes zcCondense{from{backdrop-filter:blur(0) saturate(100%);-webkit-backdrop-filter:blur(0) saturate(100%)}}
@keyframes zcVeil{from{backdrop-filter:blur(0) saturate(100%);-webkit-backdrop-filter:blur(0) saturate(100%)}}
.pop{animation:popin .2s cubic-bezier(.2,.9,.3,1.15),zcCondense .45s cubic-bezier(.23,1,.32,1);transform-origin:var(--ox,left) var(--oy,top)}
.dialog{animation:popin .15s ease-out,zcCondense .5s cubic-bezier(.23,1,.32,1)}
.settings{animation:popin .16s ease-out,zcCondense .55s cubic-bezier(.23,1,.32,1)}
.auth-card{animation:popin .15s ease-out,zcCondense .5s cubic-bezier(.23,1,.32,1)}
.overlay{animation:fade .15s,zcVeil .45s cubic-bezier(.23,1,.32,1)}

/* ---------- 小玻璃：顶栏胶囊 / 按钮 ---------- */
.pill{
  background:color-mix(in srgb,var(--surface) 55%,transparent);
  backdrop-filter:blur(14px) saturate(165%);-webkit-backdrop-filter:blur(14px) saturate(165%);
  border:1px solid color-mix(in srgb,var(--text) 10%,transparent);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5)
}
.pill:hover{background:color-mix(in srgb,var(--surface) 74%,transparent);border-color:color-mix(in srgb,var(--text) 22%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 8px 20px -12px rgba(18,22,54,.6)}
.hero .status{background:color-mix(in srgb,var(--surface) 55%,transparent);backdrop-filter:blur(14px) saturate(165%);-webkit-backdrop-filter:blur(14px) saturate(165%);box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}
.hero .status:hover{border-color:color-mix(in srgb,var(--text) 24%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 8px 20px -12px rgba(18,22,54,.55)}
.icon-btn,.tool,.new-chat,.side-link,.seg button,.s-nav button,.act,.fc-act button,.code-h button,.think-h,.send,.sess{
  transition:background-color .16s ease,background-position .75s cubic-bezier(.22,1,.36,1),color .16s ease,box-shadow .2s ease,border-color .2s ease,transform .2s ease,opacity .15s ease
}
.icon-btn:hover,.tool:hover,.new-chat:hover,.side-link:hover,.seg button:hover,.s-nav button:hover{
  box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 8px 18px -10px rgba(18,22,54,.6);
  border-color:color-mix(in srgb,var(--text) 24%,transparent)
}
.send{box-shadow:inset 0 1px 0 rgba(255,255,255,.34),inset 0 -8px 14px -8px rgba(0,0,0,.55),0 10px 22px -10px rgba(18,22,54,.7)}
.send:not(:disabled):active{box-shadow:inset 0 2px 6px rgba(0,0,0,.4),0 4px 10px -6px rgba(18,22,54,.7)}

/* ---------- 悬停流光：一道色散光带掠过可点区域（background-size 340% 的扫层） ---------- */
@keyframes zcSweep{from{background-position:15% 0}to{background-position:85% 0}}
.pill,.new-chat,.side-link,.hero .status,.sess,.s-nav button,.seg button,.act,.fc-act button,.code-h button,.tool{
  background-image:linear-gradient(100deg,transparent 40%,color-mix(in srgb,var(--accent) 34%,transparent) 50%,transparent 60%);
  background-size:340% 100%;
  background-position:15% 0
}
.pill:hover,.new-chat:hover,.side-link:hover,.hero .status:hover,.sess:hover,.s-nav button:hover,.seg button:hover,.act:hover,.fc-act button:hover,.code-h button:hover,.tool:hover{
  background-image:linear-gradient(100deg,transparent 40%,color-mix(in srgb,var(--accent) 34%,transparent) 50%,transparent 60%);
  background-position:15% 0;
  animation:zcSweep .85s cubic-bezier(.3,.9,.35,1)
}

/* ---------- 镜面高光：随指针移动（JS 写入 --zc-lx / --zc-ly，JS 里做 lerp 平滑） ---------- */
.composer::after,.dialog::after,.settings::after,.auth-card::after,.pop::after,.toast::after{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;
  background:radial-gradient(260px 190px at var(--zc-lx,50%) var(--zc-ly,-20%),rgba(255,255,255,.55),rgba(255,255,255,0) 72%)
}
html[data-theme="dark"] .composer::after,html[data-theme="dark"] .dialog::after,html[data-theme="dark"] .settings::after,
html[data-theme="dark"] .auth-card::after,html[data-theme="dark"] .pop::after,html[data-theme="dark"] .toast::after{
  background:radial-gradient(260px 190px at var(--zc-lx,50%) var(--zc-ly,-20%),rgba(186,214,255,.4),rgba(186,214,255,0) 72%)
}

/* ---------- 思考态：彩虹光晕绕卡片旋转（@property 角度变量，参考 CodinVisual ai_glow） ---------- */
.think.active{position:relative;isolation:isolate;border-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.think.active::before{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;opacity:.5;
  background:conic-gradient(from var(--zc-angle),rgba(59,201,245,.9),rgba(141,107,255,.9),rgba(255,111,163,.85),rgba(255,179,107,.9),rgba(59,201,245,.9));
  animation:zcSpin 4.2s linear infinite
}
.send{position:relative;isolation:isolate}

/* ---------- 边缘折射 / 色散描边：仅在支持遮罩裁剪时启用，避免盖住内容 ---------- */
@supports ((mask-composite: exclude) and (mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0))) or ((-webkit-mask-composite: xor) and (-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0))) {
  .composer::before,.dialog::before,.settings::before,.auth-card::before,.pop::before,.toast::before{
    content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;opacity:var(--zc-ring-op);
    background:linear-gradient(135deg,rgba(255,255,255,.95) 0%,color-mix(in srgb,var(--accent) 70%,transparent) 30%,rgba(255,255,255,.5) 48%,rgba(255,166,96,.55) 70%,rgba(255,255,255,.92) 100%);
    background-size:240% 240%;
    background-position:var(--zc-lx,50%) var(--zc-ly,-20%);
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;
    mask-composite:exclude
  }
  /* 色散描边：把这圈 1px 细环向左右各错开 1px 复制一层青 / 品红，近似 nikdelvin 的
     chromatic aberration；只加在主输入面板上，避免大面积 filter 开销 */
  .composer::before{animation:zcEdge 16s linear infinite;filter:drop-shadow(1px 0 0 rgba(0,220,255,.55)) drop-shadow(-1px 0 0 rgba(255,64,140,.5))}
  /* 思考中：锐利彩虹环 + 柔光一起旋转 */
  .think.active::after{
    content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:-1;
    background:conic-gradient(from var(--zc-angle),rgba(59,201,245,1),rgba(141,107,255,1),rgba(255,111,163,1),rgba(255,179,107,1),rgba(59,201,245,1));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;
    mask-composite:exclude;
    animation:zcSpin 4.2s linear infinite
  }
  /* 生成中：发送键外圈的液态光环（锐边 + 柔光两层） */
  .send.busy::before{
    content:"";position:absolute;inset:-7px;border-radius:50%;padding:7px;pointer-events:none;z-index:-1;
    background:conic-gradient(from var(--zc-angle),#3bc9f5,#8d6bff,#ff6fa3,#ffb36b,#3bc9f5);
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;
    mask-composite:exclude;
    filter:blur(3px);
    animation:zcSpin 1.6s linear infinite
  }
  .send.busy::after{
    content:"";position:absolute;inset:-15px;border-radius:50%;padding:15px;pointer-events:none;z-index:-1;
    background:conic-gradient(from var(--zc-angle),rgba(59,201,245,.9),rgba(141,107,255,.9),rgba(255,111,163,.85),rgba(255,179,107,.9),rgba(59,201,245,.9));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;
    mask-composite:exclude;
    filter:blur(10px);
    opacity:.7;
    animation:zcSpin 1.6s linear infinite
  }
}
/* 输入框边缘的流光：色带沿边缘缓慢流动，让“液态”感持续存在 */
@keyframes zcEdge{from{background-position:0% 0%}to{background-position:240% 100%}}

/* ---------- 无 backdrop-filter 的浏览器：直接改成不透明面板，保证文字对比度 ---------- */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .main{background-color:var(--bg)}
  .sidebar,.agent-panel,.think,.auth-screen{background-color:var(--bg-2)}
  .composer,.pop,.dialog,.settings,.auth-card,.pill,.hero .status,.overlay,.drop{background-color:var(--surface)}
  .overlay{background-color:color-mix(in srgb,var(--bg) 62%,transparent)}
  .toast{background-color:var(--primary)}
  .toast.error{background-color:var(--danger)}
  .toast.ok{background-color:var(--ok)}
  body::before{opacity:.3}
}

/* ---------- 移动端降低模糊半径，保证流畅 ---------- */
@media (max-width:820px){
  .main{backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%)}
  .sidebar,.agent-panel{backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%)}
  .composer{backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%)}
  .dialog,.settings,.auth-card{backdrop-filter:blur(22px) saturate(170%);-webkit-backdrop-filter:blur(22px) saturate(170%)}
  body::after{width:420px;height:420px}
}
.app.drawer .scrim,.app.agentDrawer .ag-scrim{backdrop-filter:blur(5px) saturate(130%);-webkit-backdrop-filter:blur(5px) saturate(130%)}

/* ---------- 打印：去掉光场与毛玻璃，交给纯色面板 ---------- */
@media print{
  body::before,body::after{display:none}
  .main,.sidebar,.agent-panel,.composer,.pop,.dialog,.settings,.auth-card,.pill,.think{backdrop-filter:none;-webkit-backdrop-filter:none;background-color:var(--surface)}
}

/* ---------- 减弱动态：停掉所有循环动画，光池停在原地，玻璃只留静态质感 ---------- */
@media (prefers-reduced-motion:reduce){
  body::before,body::after{animation:none;transition:none}
  .composer::before,.think.active::before,.think.active::after,.send.busy::before,.send.busy::after{animation:none}
  .pill:hover,.new-chat:hover,.side-link:hover,.hero .status:hover,.sess:hover,.s-nav button:hover,.seg button:hover,.act:hover,.fc-act button:hover,.code-h button:hover,.tool:hover{animation:none}
  .pop,.dialog,.settings,.auth-card,.overlay{animation-duration:.01s}
}

</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="i-logo" viewBox="0 0 24 24"><rect x="1.5" y="1.5" width="21" height="21" rx="6.5" style="fill:var(--primary);stroke:none"/><path d="M5 8.4h5.4L5 15.6h5.4M19 8.4h-3a2.4 2.4 0 0 0-2.4 2.4v2.4a2.4 2.4 0 0 0 2.4 2.4h3" style="fill:none;stroke:var(--on-primary);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></symbol>
  <symbol id="i-down" viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></symbol>
  <symbol id="i-stop" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" style="fill:currentColor;stroke:none"/></symbol>
  <symbol id="i-sidebar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M9.5 4v16"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></symbol>
  <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.2 5.6M20 4.5V11h-6.5"/></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M14 6l4 4"/></symbol>
  <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></symbol>
  <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 9"/></symbol>
  <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5z"/><path d="M14 3v5h5"/></symbol>
  <symbol id="i-bulb" viewBox="0 0 24 24"><path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/></symbol>
  <symbol id="i-brush" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A3.6 3.6 0 0 0 21 8.7C21 5.5 17 3 12 3z"/><circle cx="7.5" cy="11.5" r=".9"/><circle cx="10" cy="7.5" r=".9"/><circle cx="15" cy="7.5" r=".9"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
  <symbol id="i-logout" viewBox="0 0 24 24"><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
  <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.2" style="fill:currentColor"/><circle cx="12" cy="12" r="1.2" style="fill:currentColor"/><circle cx="18.5" cy="12" r="1.2" style="fill:currentColor"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V5M7 9l5-5 5 5M5 20h14"/></symbol>
  <symbol id="i-cloud" viewBox="0 0 24 24"><path d="M7 18.5a4.2 4.2 0 0 1-.7-8.3 5.7 5.7 0 0 1 11 1.4A3.5 3.5 0 0 1 17 18.5H7z"/></symbol>
  <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.1"/></symbol>
  <symbol id="i-cpu" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/></symbol>
  <symbol id="i-chat" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z"/></symbol>
  <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></symbol>
  <symbol id="i-database" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M4 7.2A1.7 1.7 0 0 1 5.7 5.5h3.6l2 2.2h8A1.7 1.7 0 0 1 21 9.4v8.1A1.7 1.7 0 0 1 19.3 19.2H4.7A1.7 1.7 0 0 1 3 17.5V7.2z"/></symbol>
  <symbol id="i-folder-open" viewBox="0 0 24 24"><path d="M3 8.2A1.7 1.7 0 0 1 4.7 6.5h3.6l2 2.1h7.4A1.7 1.7 0 0 1 19.4 10l-1.3 7.4a1.7 1.7 0 0 1-1.68 1.4H5.9a1.7 1.7 0 0 1-1.68-1.42L3 9z"/></symbol>
  <symbol id="i-agent" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="3.2"/><path d="M7.5 10l2.8 2.4-2.8 2.4"/><path d="M13 14.8h4"/></symbol>
  <symbol id="i-diff" viewBox="0 0 24 24"><path d="M9 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5H15a1.5 1.5 0 0 0 1.5-1.5V11"/><path d="M12.5 3.5H16a1.5 1.5 0 0 1 1.5 1.5v3.5"/><path d="M13.5 7.5h5M16 5v5"/></symbol>
</svg>

<div class="auth-screen" id="authScreen" hidden>
  <div class="auth-card" role="dialog" aria-modal="true" aria-label="登录与注册">
    <div class="auth-logo"><svg class="ic"><use href="#i-logo"/></svg><span>ZC-GURA</span></div>
    <div class="seg auth-seg" id="authTabs">
      <button type="button" data-tab="login" class="on">登录</button>
      <button type="button" data-tab="register">注册</button>
    </div>
    <div class="auth-msg" id="authMsg" role="alert" hidden></div>

    <form id="authLogin" novalidate autocomplete="on">
      <div class="field"><label for="loginEmail">QQ 邮箱</label><input class="inp" id="loginEmail" type="email" name="username" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="例如 12345678@qq.com"></div>
      <div class="field"><label for="loginPass">密码</label><input class="inp" id="loginPass" type="password" name="password" autocomplete="current-password" placeholder="请输入密码"></div>
      <button class="btn primary auth-submit" type="submit">登录</button>
    </form>

    <form id="authReg" novalidate autocomplete="on" hidden>
      <div class="field"><label for="regEmail">QQ 邮箱</label><input class="inp" id="regEmail" type="email" name="username" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="例如 12345678@qq.com"></div>
      <div class="field"><label for="regPass">设置密码</label><input class="inp" id="regPass" type="password" name="new-password" autocomplete="new-password" placeholder="至少 8 位"></div>
      <div class="field"><label for="regPass2">确认密码</label><input class="inp" id="regPass2" type="password" name="new-password2" autocomplete="new-password" placeholder="再次输入密码"></div>
      <div class="field">
        <label for="regCode">邮箱验证码</label>
        <div class="auth-code"><input class="inp" id="regCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码"><button class="btn" id="regSend" type="button">发送验证码</button></div>
        <div class="hint">填好邮箱和密码后点击“发送验证码”，验证码会发送到该 QQ 邮箱。</div>
      </div>
      <button class="btn primary auth-submit" type="submit">注册</button>
    </form>
  </div>
</div>

<div class="app" id="app">
  <aside class="sidebar" id="sidebar" aria-label="会话列表">
    <div class="side-top">
      <div class="brand"><svg class="ic"><use href="#i-logo"/></svg><span>ZC-GURA</span></div>
      <button class="icon-btn" id="btnCollapse" title="收起侧栏" aria-label="收起侧栏"><svg class="ic"><use href="#i-sidebar"/></svg></button>
    </div>
    <button class="new-chat" id="btnNew"><svg class="ic"><use href="#i-plus"/></svg><span>新对话</span></button>
    <div class="search"><svg class="ic"><use href="#i-search"/></svg><input id="sessionSearch" type="search" placeholder="搜索对话" autocomplete="off" aria-label="搜索对话"></div>
    <nav class="session-list" id="sessionList"></nav>
    <div class="side-bottom">
      <button class="side-link" id="btnSettings"><svg class="ic"><use href="#i-settings"/></svg><span>设置</span></button>
      <button class="side-link" id="btnLogout" hidden><svg class="ic"><use href="#i-logout"/></svg><span>退出登录</span></button>
      <div class="side-status" id="syncBadge"></div>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>

  <main class="main" id="main">
    <header class="topbar">
      <button class="icon-btn" id="btnMenu" title="会话列表" aria-label="会话列表"><svg class="ic"><use href="#i-sidebar"/></svg></button>
      <button class="pill" id="modelBtn" aria-haspopup="true"><span class="dot" id="apiDot"></span><span id="modelLabel">未配置 API</span><svg class="ic sm"><use href="#i-chev"/></svg></button>
      <div class="spacer"></div>
      <button class="icon-btn" id="btnTheme" title="切换主题" aria-label="切换主题"><svg class="ic"><use href="#i-moon" id="themeUse"/></svg></button>
      <button class="icon-btn" id="btnMore" title="更多" aria-label="更多操作" aria-haspopup="true"><svg class="ic"><use href="#i-more"/></svg></button>
    </header>

    <div class="stage empty" id="stage">
      <div class="hero" id="hero">
        <svg class="logo-big"><use href="#i-logo"/></svg>
        <h1>今天想做点什么？</h1>
        <p>连接你自己的模型接口，在一个界面里完成对话、分析、写作与图像生成。</p>
        <button class="status" id="heroStatus"><span class="dot" id="heroDot"></span><span id="heroStatusText">尚未配置 API</span></button>
      </div>
      <section class="chat" id="chat" tabindex="-1" aria-live="polite"><div class="thread" id="thread"></div></section>
      <button class="to-bottom" id="toBottom" hidden title="回到底部" aria-label="回到底部"><svg class="ic"><use href="#i-down"/></svg></button>
      <div class="composer-wrap">
        <div class="agent-bar" id="agentBar" hidden>
          <span class="nm"><svg><use href="#i-agent"/></svg><b id="agentBarName">Agent</b></span>
          <span class="spacer"></span>
          <button type="button" id="agentBarTree"><svg class="ic sm"><use href="#i-folder"/></svg>文件</button>
          <button type="button" id="agentBarLog"><svg class="ic sm"><use href="#i-diff"/></svg>日志</button>
          <button type="button" id="agentBarExit"><svg class="ic sm"><use href="#i-x"/></svg>退出</button>
        </div>
        <div class="composer" id="composer">
          <div class="chips" id="chips"></div>
          <textarea id="input" rows="1" placeholder="给 ZC-GURA 发送消息" aria-label="消息输入框" enterkeyhint="send"></textarea>
          <div class="c-tools">
            <button class="tool" id="btnAttach" title="添加图片或文件" aria-label="添加图片或文件" aria-haspopup="true"><svg class="ic"><use href="#i-plus"/></svg></button>
            <div class="tool-scroll" id="toolScroll">
              <button class="tool" id="btnDeep" title="思考强度" aria-haspopup="true" data-lv="0"><svg class="ic meter" id="deepMeter" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="15" width="3.6" height="6" rx="1.2"/><rect x="7.9" y="11" width="3.6" height="10" rx="1.2"/><rect x="13.3" y="7" width="3.6" height="14" rx="1.2"/><rect x="18.7" y="3" width="3.6" height="18" rx="1.2"/></svg><span class="lblwrap" id="deepLabelWrap"><span class="lblcur" id="deepLabel">深度思考</span></span></button>
              <button class="tool" id="btnDraw" title="图像生成模式"><svg class="ic"><use href="#i-brush"/></svg><span>生图</span></button>
              <button class="tool" id="btnAgent" title="Coding Agent 模式：授权本地项目目录后，AI 可读写文件"><svg class="ic"><use href="#i-agent"/></svg><span>Agent</span></button>
            </div>
            <div class="spacer"></div>
            <button class="send" id="btnSend" disabled title="发送" aria-label="发送"><svg class="ic" id="sendIcon"><use href="#i-up"/></svg></button>
          </div>
        </div>
        <p class="foot">Enter 发送，Shift + Enter 换行。AI 生成的内容可能有误，请核实重要信息。</p>
      </div>
    </div>
  </main>
  <div class="ag-scrim" id="agScrim"></div>
  <aside class="agent-panel" id="agentPanel" aria-label="Coding Agent 面板">
    <div class="ag-head">
      <svg class="ic"><use href="#i-agent"/></svg>
      <b id="agHeadName">Coding Agent</b>
      <button class="icon-btn" id="agentPanelClose" aria-label="关闭面板"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>
    <div class="ag-tabs" id="agTabs">
      <button type="button" data-agtab="tree" class="on">文件树</button>
      <button type="button" data-agtab="log">操作日志</button>
    </div>
    <div class="ag-pane on" data-agpane="tree" id="agPaneTree">
      <div id="agTreeBox"></div>
      <div class="ag-preview" id="agPreview" hidden>
        <div class="pv-h"><svg class="ic sm"><use href="#i-file"/></svg><b id="agPvName"></b><button class="icon-btn" id="agPvClose" aria-label="关闭预览"><svg class="ic sm"><use href="#i-x"/></svg></button></div>
        <div class="pv-b"><pre><code id="agPvCode"></code></pre></div>
      </div>
    </div>
    <div class="ag-pane" data-agpane="log" id="agPaneLog">
      <div id="agLogBox"></div>
    </div>
    <div class="ag-foot" id="agFoot" hidden>
      <button type="button" id="agChangeDir"><svg class="ic sm"><use href="#i-folder-open"/></svg>更换目录</button>
      <button type="button" id="agForgetDir">忘记此目录</button>
    </div>
  </aside>
</div>

<div class="overlay" id="agentDiffOv" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="agdTitle" style="width:min(640px,96vw)">
    <h3 id="agdTitle">确认文件改动</h3>
    <div id="agdBody"></div>
    <div class="ag-confirm-actions">
      <button class="btn" id="agdReject" type="button">拒绝</button>
      <button class="btn primary" id="agdApprove" type="button">确认执行</button>
    </div>
  </div>
</div>

<input type="file" id="fileImg" accept="image/*" multiple hidden>
<input type="file" id="fileDoc" multiple hidden>
<input type="file" id="fileBackup" accept="application/json,.json" hidden>
<div id="popLayer"></div>
<div id="toasts" role="status" aria-live="polite"></div>

<div class="overlay" id="dialogOv" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <h3 id="dlgTitle"></h3>
    <p id="dlgMsg"></p>
    <input type="text" id="dlgInput" hidden>
    <div class="row"><button class="btn" id="dlgCancel">取消</button><button class="btn primary" id="dlgOk">确定</button></div>
  </div>
</div>

<div class="overlay" id="settingsOv" hidden>
  <div class="settings" role="dialog" aria-modal="true" aria-label="设置">
    <div class="s-nav" id="sNav">
      <h2>设置</h2>
      <button data-tab="api" class="on"><svg class="ic"><use href="#i-cpu"/></svg>模型与 API</button>
      <button data-tab="chat"><svg class="ic"><use href="#i-chat"/></svg>对话</button>
      <button data-tab="draw"><svg class="ic"><use href="#i-brush"/></svg>图像生成</button>
      <button data-tab="look"><svg class="ic"><use href="#i-sliders"/></svg>外观</button>
      <button data-tab="data"><svg class="ic"><use href="#i-database"/></svg>数据与同步</button>
    </div>
    <div class="s-main">
      <div class="s-head"><h3 id="sTitle">模型与 API</h3><button class="icon-btn" id="sClose" aria-label="关闭"><svg class="ic"><use href="#i-x"/></svg></button></div>
      <div class="s-body">

        <div class="s-pane on" data-pane="api">
          <div class="plist" id="apiList"></div>
          <button class="btn sm" id="apiAdd" style="margin-bottom:18px"><svg class="ic sm"><use href="#i-plus"/></svg>添加 API</button>
          <div id="apiForm">
            <div class="field"><label for="fName">名称</label><input class="inp" id="fName" placeholder="例如：自定义API名称" autocomplete="off"></div>
            <div class="field"><label for="fUrl">API 地址</label><input class="inp mono" id="fUrl" placeholder="https://api.openai.com/v1/chat/completions" autocomplete="off" spellcheck="false">
              <div class="hint" id="fUrlHint">可填写完整接口地址，也可只填站点根地址或 /v1，系统会自动补全路径。</div></div>
            <div class="field"><label for="fKey">API Key</label><div class="inline"><input class="inp mono" id="fKey" type="password" placeholder="sk-…（可留空）" autocomplete="off" spellcheck="false"><button class="icon-btn" id="fKeyEye" type="button" aria-label="显示或隐藏密钥"><svg class="ic"><use href="#i-eye"/></svg></button></div></div>
            <div class="two">
              <div class="field"><label for="fFormat">接口格式</label><select id="fFormat"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Claude</option><option value="gemini">Google Gemini</option><option value="ollama">Ollama</option></select></div>
              <div class="field"><label for="fRoute">连接方式</label><select id="fRoute"><option value="auto">自动（推荐）</option><option value="direct">仅浏览器直连</option><option value="relay">始终经本站代理</option></select></div>
            </div>
            <div class="field"><label for="fModel">模型</label>
              <div class="inline"><input class="inp mono" id="fModel" placeholder="gpt-4o" autocomplete="off" spellcheck="false" list="modelOptions"><button class="btn sm" id="fDetect" type="button">检测模型</button></div>
              <datalist id="modelOptions"></datalist>
              <div class="hint" id="fDetectHint"></div></div>
            <div class="field"><label for="fHeaders">自定义请求头（可选，JSON）</label><input class="inp mono" id="fHeaders" placeholder='{"api-key":"…"}' autocomplete="off" spellcheck="false"></div>
            <div class="diag" id="apiDiag" hidden></div>
            <div class="inline s-actions" style="flex-wrap:wrap;gap:10px">
              <button class="btn primary" id="apiSave">保存</button>
              <button class="btn" id="apiUse">设为当前</button>
              <button class="btn" id="apiTest">测试连接</button>
              <span class="spacer"></span>
              <button class="btn danger" id="apiDel">删除</button>
            </div>
          </div>
        </div>

        <div class="s-pane" data-pane="chat">
          <div class="field"><label for="sSystem">系统提示词</label><textarea id="sSystem" placeholder="留空则使用默认提示词。用于设定模型的角色、语气和输出规范。"></textarea></div>
          <div class="two">
            <div class="field"><label for="sCtx">携带的历史消息数</label><select id="sCtx"><option value="10">最近 10 条</option><option value="20">最近 20 条</option><option value="30">最近 30 条</option><option value="60">最近 60 条</option><option value="200">尽可能多（200 条）</option></select></div>
            <div class="field tmp-field" id="tmpField"><label for="sTemp">温度：<span id="sTempV">0.7</span><span class="tmp-tag" id="sTempT">均衡</span></label>
              <div class="tmp" id="tmpBox"><div class="tmp-fill"></div><input type="range" id="sTemp" min="0" max="2" step="0.1" value="0.7" aria-describedby="sTempH"></div>
              <div class="hint" id="sTempH"></div></div>
          </div>
          <div class="two">
            <div class="field"><label for="sMax">最大输出 Token</label><select id="sMax"><option value="0">自动</option><option value="2048">2048</option><option value="4096">4096</option><option value="8192">8192</option><option value="16384">16384</option><option value="32768">32768</option></select><div class="hint">深度思考开启时会自动取更大的值。</div></div>
            <div class="field"><label for="sTimeout">请求超时（秒）</label><select id="sTimeout"><option value="60">60</option><option value="120">120</option><option value="240">240</option><option value="480">480</option></select><div class="hint">等待服务端返回响应头的最长时间。</div></div>
          </div>
          <div class="row-sw"><div class="tx"><b>流式输出</b><span>边生成边显示；不支持时会自动降级为普通请求</span></div><label class="switch"><input type="checkbox" id="sStream"><i></i></label></div>
          <div class="row-sw"><div class="tx"><b>显示思考过程</b><span>模型返回推理内容时，在回答上方展示可折叠区域</span></div><label class="switch"><input type="checkbox" id="sShowThink"><i></i></label></div>
          <div class="row-sw"><div class="tx"><b>文件生成与下载</b><span>让模型把文件以可下载的文件卡片直接返回（而不是在正文里贴代码）；关闭后代码块仍带下载按钮</span></div><label class="switch"><input type="checkbox" id="sFileGen"><i></i></label></div>
        </div>

        <div class="s-pane" data-pane="draw">
          <p class="hint" style="margin-top:0;color:var(--text-3)">独立于对话 API。支持 OpenAI 兼容的 /v1/images/generations 与 Gemini Imagen 的 :predict 接口。在输入框中使用 /画图 描述，或点击「生图」后发送。</p>
          <div class="field"><label for="dUrl">画图 API 地址</label><input class="inp mono" id="dUrl" placeholder="https://api.openai.com" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="dKey">API Key</label><input class="inp mono" id="dKey" type="password" autocomplete="off" spellcheck="false"></div>
          <div class="two">
            <div class="field"><label for="dModel">模型</label><input class="inp mono" id="dModel" placeholder="gpt-image-1 / dall-e-3" autocomplete="off" spellcheck="false"></div>
            <div class="field"><label for="dFormat">接口格式</label><select id="dFormat"><option value="openai">OpenAI 兼容</option><option value="gemini">Gemini Imagen</option></select></div>
          </div>
          <div class="field"><label for="dSize">图片尺寸</label><select id="dSize"><option>1024x1024</option><option>1024x1536</option><option>1536x1024</option><option>512x512</option><option>1792x1024</option><option>1024x1792</option></select></div>
          <button class="btn primary" id="dSave">保存</button>
        </div>

        <div class="s-pane" data-pane="look">
          <div class="row-sw"><div class="tx"><b>主题</b><span>自动模式跟随系统外观</span></div><div class="seg" id="segTheme"><button data-v="auto">自动</button><button data-v="light">浅色</button><button data-v="dark">深色</button></div></div>
          <div class="row-sw"><div class="tx"><b>字号</b><span>调整界面与消息文字大小</span></div><div class="seg" id="segFont"><button data-v="small">小</button><button data-v="medium">标准</button><button data-v="large">大</button></div></div>
        </div>

        <div class="s-pane" data-pane="data">
          <div class="stat">
            <div><b id="stTotal">0</b><span>累计 Token</span></div>
            <div><b id="stIn">0</b><span>输入</span></div>
            <div><b id="stOut">0</b><span>输出</span></div>
            <div><b id="stCost">$0</b><span>费用估算</span></div>
          </div>
          <div class="inline" style="flex-wrap:wrap;margin-bottom:6px">
            <button class="btn sm" id="dtExportTxt"><svg class="ic sm"><use href="#i-download"/></svg>导出当前对话（Markdown）</button>
            <button class="btn sm" id="dtBackup"><svg class="ic sm"><use href="#i-download"/></svg>备份全部数据</button>
            <button class="btn sm" id="dtRestore"><svg class="ic sm"><use href="#i-upload"/></svg>从备份恢复</button>
            <button class="btn sm" id="dtResetStat">重置用量统计</button>
          </div>
          <div class="hint" id="dtUsage" style="margin-bottom:6px"></div>

          <div class="sub-h">云同步</div>
          <div class="row-sw"><div class="tx"><b>跨设备同步</b><span id="syAvail">检测中…</span></div><label class="switch"><input type="checkbox" id="syOn"><i></i></label></div>
          <div class="field" style="margin-top:12px"><label for="syPass">同步密钥</label><div class="inline"><input class="inp" id="syPass" type="password" placeholder="至少 12 位，多台设备填写完全相同的密钥" autocomplete="new-password" style="flex:1"><button class="btn sm" id="syGen" type="button">生成随机密钥</button></div><div class="hint">数据上传前会用该密钥在本地加密（AES-GCM）后再同步，云端只保存密文。<b>但任何人只要输入与你完全相同的密钥，都能解密并读取/覆盖这份数据</b>——请点击"生成随机密钥"使用高强度随机密钥，不要使用生日、常见词等容易被猜到或与他人重复的内容，也不要把密钥告诉别人。</div></div>
          <div class="row-sw"><div class="tx"><b>同步 API Key</b><span>默认关闭；开启后各 API 的密钥会随其余数据一起加密同步（仍遵循上方"同步密钥"的共享密钥规则）</span></div><label class="switch"><input type="checkbox" id="syKeys"><i></i></label></div>
          <div class="inline" style="margin-top:12px"><button class="btn sm" id="syNow">立即同步</button><span class="hint" id="syStatus" style="margin:0"></span></div>

          <div class="sub-h">服务状态</div>
          <div class="hint" id="svcStatus">检测中…</div>

          <div class="sub-h">危险操作</div>
          <button class="btn danger sm" id="dtClear">清除全部会话</button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function () {
'use strict';
/* ==========================================================================
 * 01 核心工具：DOM 助手、存储、Toast、对话框、浮层
 * ========================================================================== */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

function el(tag, props) {
  const n = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (let i = 2; i < arguments.length; i++) {
    const kids = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]];
    kids.forEach((c) => {
      if (c == null || c === false) return;
      n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
  }
  return n;
}

function icon(name, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(n);
}
function debounce(fn, ms) {
  let t = null;
  const d = function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); };
  d.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
  return d;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onA); resolve(); }, ms);
    const onA = () => { clearTimeout(t); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onA, { once: true });
  });
}
function abortError() { const e = new Error('已取消'); e.name = 'AbortError'; e.kind = 'abort'; return e; }

function timeGroup(ts) {
  const d = new Date(ts), n = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return '近 7 天';
  if (diff < 30) return '近 30 天';
  return '更早';
}

async function sha256hex(text) {
  try {
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.prototype.map.call(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* 降级 */ }
  let h1 = 0x811c9dc5, h2 = 0x1b873593, out = '';
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619); h2 = Math.imul(h2 + text.charCodeAt(i), 2246822519);
  }
  for (let k = 0; k < 4; k++) { h1 = Math.imul(h1 ^ (h1 >>> 15), 2246822519); h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489917); out += ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')); }
  return out.slice(0, 64);
}

// ---------------------------------------------------------------------------
// 云同步端到端加密：payload 在离开浏览器前用「同步密钥」派生出的 AES-GCM 密钥
// 加密，KV 中只保存密文，服务端/日志/网络中间人均无法读取明文（含 API Key）。
// 加密密钥与用于定位云端存储位置的 ns（见 sha256hex 调用处）分别用不同的
// domain-separation 前缀派生，二者互不可推导。
// 注意：这仍是"共享密钥"模型——同一份密钥在任何人手中都能解出同一份数据，
// 无法防止"两个人凑巧使用了完全相同的密钥"，只能通过使用足够长、随机的密钥
// 把这种概率降到可忽略不计（见 zcRandomPass / #syGen 按钮）。
// ---------------------------------------------------------------------------
const ZC_ENC_PREFIX = 'zcenc1:';

function zcBytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function zcB64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function zcDeriveAesKey(pass) {
  if (!(window.crypto && crypto.subtle)) return null;
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode('zc_gura_sync_enc:' + String(pass)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('zc_gura_sync_enc_salt_v1'), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function zcEncryptJson(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0); combined.set(new Uint8Array(cipher), iv.length);
  return ZC_ENC_PREFIX + zcBytesToB64(combined);
}
// 返回解密后的对象；若字符串不是本方案的加密信封（旧版明文数据）则返回 null，
// 由调用方自行按旧格式解析（兼容升级前已同步过的历史数据）。
// 若字符串确实是加密信封但解密失败（同步密钥不正确 / 数据损坏），则抛出异常。
async function zcDecryptJson(text, key) {
  if (typeof text !== 'string' || text.indexOf(ZC_ENC_PREFIX) !== 0) return null;
  if (!key) throw new Error('当前浏览器不支持解密（缺少 WebCrypto）');
  const combined = zcB64ToBytes(text.slice(ZC_ENC_PREFIX.length));
  const iv = combined.slice(0, 12), cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}
// 生成足够随机的同步密钥，避免用户手输"容易被猜到/和他人重复"的口令
// （这是本次修复的核心：肉眼可猜的短密钥是不同用户之间数据被互相同步的根源）。
function zcRandomPass(len) {
  len = len || 24;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* 回退 */ }
  try {
    const ta = el('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

function downloadBlob(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- 文件生成：围栏标注文件名 → 可下载文件（单个 / 打包 zip） ---------- */
const FileGen = {
  EXT: {
    javascript: 'js', js: 'js', mjs: 'mjs', cjs: 'cjs', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py', html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    json: 'json', jsonc: 'json', json5: 'json5', markdown: 'md', md: 'md', mdx: 'mdx',
    c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'hpp', cs: 'cs', csharp: 'cs',
    java: 'java', kotlin: 'kt', kt: 'kt', swift: 'swift', go: 'go', golang: 'go', rust: 'rs', rs: 'rs',
    lua: 'lua', php: 'php', ruby: 'rb', rb: 'rb', perl: 'pl', pl: 'pl', r: 'r', dart: 'dart', scala: 'scala',
    objc: 'm', objectivec: 'm', 'objective-c': 'm', asm: 'asm', sql: 'sql', graphql: 'graphql', proto: 'proto',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1', bat: 'bat', cmd: 'bat',
    yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini', conf: 'conf', nginx: 'conf', xml: 'xml', svg: 'svg',
    vue: 'vue', svelte: 'svelte', csv: 'csv', tsv: 'tsv', tex: 'tex', latex: 'tex', diff: 'diff', patch: 'patch',
    mermaid: 'mmd', txt: 'txt', text: 'txt', plaintext: 'txt'
  },
  MIME: {
    html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    json: 'application/json', md: 'text/markdown', xml: 'application/xml', svg: 'image/svg+xml', csv: 'text/csv'
  },
  KIND: {
    js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', py: 'Python',
    html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less', json: 'JSON', json5: 'JSON5', md: 'Markdown', mdx: 'MDX',
    c: 'C', h: 'C 头文件', cpp: 'C++', hpp: 'C++ 头文件', cs: 'C#', java: 'Java', kt: 'Kotlin', swift: 'Swift', go: 'Go', rs: 'Rust',
    lua: 'Lua', php: 'PHP', rb: 'Ruby', pl: 'Perl', r: 'R', dart: 'Dart', scala: 'Scala', m: 'Objective-C', asm: '汇编',
    sql: 'SQL', graphql: 'GraphQL', proto: 'Protobuf', sh: 'Shell', ps1: 'PowerShell', bat: '批处理', yml: 'YAML', yaml: 'YAML',
    toml: 'TOML', ini: 'INI', conf: '配置文件', xml: 'XML', svg: 'SVG', vue: 'Vue', svelte: 'Svelte', csv: 'CSV', tsv: 'TSV',
    tex: 'LaTeX', diff: 'Diff', patch: 'Patch', mmd: 'Mermaid', txt: '文本'
  },
  has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); },
  ext(n) { n = String(n || ''); const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i + 1).toLowerCase() : ''; },
  clean(n) {
    n = String(n || '').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\s+|\s+$/g, '');
    if (n.length > 100) { const i = n.lastIndexOf('.'); n = (i > 0 && n.length - i <= 11) ? n.slice(0, 100 - (n.length - i)) + n.slice(i) : n.slice(0, 100); }
    return n;
  },
  /* 像“文件名.后缀”的片段 → 规范化后的文件名，否则返回空串 */
  fileLike(s) {
    s = String(s || '').replace(/^[\s"'“”‘’(\[{]+|[\s"'“”‘’,;)\]}]+$/g, '');
    s = s.split(/[\/\\]/).pop();
    return /^[^\s:*?"<>|]+\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(s) ? this.clean(s) : '';
  },
  defName(k) {
    k = String(k || '').toLowerCase();
    if (k === 'dockerfile') return 'Dockerfile';
    if (k === 'makefile' || k === 'make') return 'Makefile';
    const e = this.has(this.EXT, k) ? this.EXT[k] : 'txt';
    return (e === 'md' ? 'document' : 'code') + '.' + e;
  },
  /* 解析围栏首行：支持 “lua main.lua” “js:app.js” “js title="app.js"” “js filename=app.js”，
     以及代码首行注释 “// filename: app.js”。未标注文件名时按语言给默认名。 */
  info(lang, rest, code) {
    let lg = String(lang || ''), tail = String(rest || ''), name = '';
    const kv = /(?:^|[\s{,])(?:filename|file|title|name|path)\s*[=:]\s*(?:"([^"]+)"|'([^']+)'|([^\s"',}]+))/i.exec(' ' + lg + ' ' + tail);
    if (kv) name = this.fileLike(kv[1] || kv[2] || kv[3]);
    if (lg.indexOf('=') >= 0) lg = '';
    const cm = /^([^:]+):(.*)$/.exec(lg);
    if (cm) { if (!name) name = this.fileLike(cm[2]); lg = cm[1]; }
    if (!name && lg) { const f = this.fileLike(lg); if (f) { name = f; lg = ''; } }
    if (!name) { const ts = tail.split(/\s+/); for (let i = 0; i < ts.length && !name; i++) name = this.fileLike(ts[i]); }
    if (!name) {
      const c = String(code || ''), nl = c.indexOf('\n'), first = nl < 0 ? c : c.slice(0, nl);
      const cmt = /^\s*(?:\/\/|#|--|;|\/\*+|<!--)\s*(?:filename|file\s*name|file|文件名|文件)\s*[:：=]\s*([^\s*]+)/i.exec(first);
      if (cmt) name = this.fileLike(cmt[1]);
    }
    const named = !!name;
    const ext = named ? this.ext(name) : '';
    if (!named) name = this.defName(lg);
    return { named, name, lang: lg || ext };
  },
  kind(name) {
    const e = this.ext(name);
    if (this.has(this.KIND, e)) return this.KIND[e];
    if (/^dockerfile$/i.test(name)) return 'Dockerfile';
    if (/^makefile$/i.test(name)) return 'Makefile';
    return e ? e.toUpperCase() : '文本';
  },
  bytes(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c < 0xDC00) ? (i++, 4) : 3; }
    return n;
  },
  size(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; },
  /* 文件卡片：回复里直接呈现为“文件”（文件名 / 类型 / 行数 / 体积 + 下载），代码默认折叠，点开可预览 */
  card(f, code, gen) {
    const lines = code ? code.split('\n').length : 0;
    const e = this.ext(f.name);
    const ic = '<span class="fc-ic">' + esc((e || 'file').toUpperCase().slice(0, 4)) + '</span>';
    if (gen) {
      return '<div class="fcard gen"><div class="fc-h">' + ic + '<span class="fc-tx"><b>' + esc(f.name) + '</b><i>正在生成… · ' + lines + ' 行</i></span><span class="fc-act"><span class="fc-spin"></span></span></div></div>';
    }
    const meta = this.kind(f.name) + ' · ' + lines + ' 行 · ' + this.size(this.bytes(code));
    return '<div class="fcard" data-lang="' + esc(f.lang) + '"><div class="fc-h">' + ic +
      '<span class="fc-tx"><b>' + esc(f.name) + '</b><i>' + esc(meta) + '</i></span><span class="fc-act">' +
      '<button type="button" class="fc-cp" data-copy="1" title="复制内容"><svg class="ic sm"><use href="#i-copy"/></svg><span>复制</span></button>' +
      '<button type="button" data-dl="' + esc(f.name) + '" title="下载 ' + esc(f.name) + '"><svg class="ic sm"><use href="#i-download"/></svg><span>下载</span></button>' +
      '<button type="button" class="fc-tg" aria-expanded="false" aria-label="展开或收起预览" title="预览"><svg class="ic sm"><use href="#i-chev"/></svg></button>' +
      '</span></div><div class="fc-b" hidden><pre><code>' + esc(code) + '</code></pre></div></div>';
  },
  /* 展开 / 收起预览（首次展开时才做语法高亮） */
  toggle(card) {
    const b = card.querySelector('.fc-b');
    if (!b) return;
    const open = b.hasAttribute('hidden');
    if (open) {
      const code = b.querySelector('code');
      if (code && !code.getAttribute('data-hl')) { code.innerHTML = Hl(code.textContent, card.getAttribute('data-lang') || ''); code.setAttribute('data-hl', '1'); }
      b.removeAttribute('hidden');
    } else b.setAttribute('hidden', '');
    card.classList.toggle('open', open);
    const tg = card.querySelector('.fc-tg');
    if (tg) tg.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
  save(name, text) {
    const e = this.ext(name);
    const mime = this.has(this.MIME, e) ? this.MIME[e] : 'text/plain';
    downloadBlob(name, (e === 'csv' ? '\uFEFF' : '') + text, mime + ';charset=utf-8');
  },
  /* 打包当前消息里所有带文件名的代码块 */
  saveAll(root) {
    const files = [], used = Object.create(null);
    Array.prototype.forEach.call((root || document).querySelectorAll('.fcard'), (c) => {
      const b = c.querySelector('button[data-dl]'), pre = c.querySelector('pre');
      if (!b || !pre) return;
      const base = b.getAttribute('data-dl');
      let n = base, k = 1;
      while (used[n.toLowerCase()]) { k++; const i = base.lastIndexOf('.'); n = i > 0 ? base.slice(0, i) + ' (' + k + ')' + base.slice(i) : base + ' (' + k + ')'; }
      used[n.toLowerCase()] = 1;
      files.push({ name: n, text: (this.ext(n) === 'csv' ? '\uFEFF' : '') + pre.textContent });
    });
    if (!files.length) return;
    downloadBlob('ZC-GURA_文件_' + new Date().toISOString().slice(0, 10) + '.zip', this.zip(files), 'application/zip');
  },
  /* 最小 zip 写入器（store 不压缩，UTF-8 文件名），无需外部依赖 */
  zip(files) {
    const enc = new TextEncoder();
    if (!this._crc) {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
      this._crc = t;
    }
    const T = this._crc;
    const crc = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const d = new Date();
    const dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosD = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let off = 0;
    files.forEach((f) => {
      const nm = enc.encode(f.name), data = enc.encode(f.text), sum = crc(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosT, true); lh.setUint16(12, dosD, true); lh.setUint32(14, sum, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nm, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosT, true); ch.setUint16(14, dosD, true); ch.setUint32(16, sum, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true);
      ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + data.length;
    });
    let csize = 0; central.forEach((p) => { csize += p.length; });
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, off, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  },
  footer(n) {
    return n >= 2 ? '<div class="files-all"><button type="button" class="btn sm" data-dlall="1"><svg class="ic sm"><use href="#i-download"/></svg><span>打包下载全部文件（' + n + ' 个）</span></button></div>' : '';
  },
  /* 追加到系统提示词：教模型用「语言 文件名」标注代码块，界面据此显示为可下载文件 */
  prompt() {
    if (Settings.get('fileGen') === false) return '';
    const F = '\x60\x60\x60';
    return '\n\n【文件输出规范】当用户要求你编写、生成、创建、导出或修改文件（例如 .js .html .md .c .lua .py .json .css .txt 等任意文本或代码文件），或让你写一个完整的脚本、程序、网页、配置、文档时，请把每个文件的完整内容放进各自独立的 Markdown 围栏代码块，并在起始围栏行写明语言和文件名，格式如：' + F + 'lua main.lua。界面会把这样的代码块直接显示为可下载的文件卡片，正文里不会展开代码，所以：1）一个文件一个代码块，文件名必须带正确的后缀；2）内容必须完整可用，不得用“省略”“同上”“……”代替，也不要在代码块之外重复贴同样的代码；3）如果文件内容本身包含 ' + F + ' 围栏（例如 .md 文件），外层围栏改用四个反引号；4）代码块之外只用一两句话说明文件的用途和用法。仅在用户确实需要文件或完整成品时这样做；回答问题、讲解概念时的简短代码片段不要标注文件名。';
  }
};

/* ---------- 本地存储（前缀与旧版一致：zc_gura_） ---------- */
const PFX = 'zc_gura_';
const Store = {
  onChange: null,
  get(k, fb) {
    try {
      const v = localStorage.getItem(PFX + k);
      if (v === null) return fb;
      try { return JSON.parse(v); } catch (e) { return v; }
    } catch (e) { return fb; }
  },
  set(k, v, silent) {
    const s = JSON.stringify(v);
    try { localStorage.setItem(PFX + k, s); }
    catch (e) {
      const q = !!(e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014));
      return { ok: false, quota: q, error: e };
    }
    if (!silent && Store.onChange) Store.onChange(k);
    return { ok: true };
  },
  remove(k) { try { localStorage.removeItem(PFX + k); } catch (e) { /* ignore */ } if (Store.onChange) Store.onChange(k); },
  usage() {
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PFX) === 0) n += k.length + (localStorage.getItem(k) || '').length;
      }
    } catch (e) { /* ignore */ }
    return n * 2; // UTF-16
  }
};

/* ---------- 液态玻璃：随指针移动的镜面高光 + 追随指针的折射光池（参考 kube.io / Apple Liquid Glass 的光照模型） ---------- */
/* 性能要点：指针坐标在 JS 里做 lerp 平滑后逐帧写入 --zc-lx/--zc-ly；指针静止、页面
   隐藏、系统开启「减弱动态」时立刻停掉 rAF 循环，只在指针移动 / 页面滚动时才醒来。 */
(function zcGlassLight() {
  try {
    var root = document.documentElement;
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var SEL = '.composer,.dialog,.settings,.auth-card,.pop,.toast';
    var list = [], raf = 0, lastScan = 0, running = false;
    var tx = 0.5, ty = 0.12, cx = 0.5, cy = 0.12; // 目标位置 / 当前显示位置（lerp）
    var lastMove = 0;
    var poolOK = !!(root && root.style && root.style.setProperty);

    function reduced() { try { return !!(mq && mq.matches); } catch (e) { return false; } }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } running = false; }
    function schedule() { if (!raf && !reduced() && !document.hidden) raf = requestAnimationFrame(paint); }

    function scan() {
      var now = Date.now();
      if (!list.length || now - lastScan > 800) {
        lastScan = now;
        try { list = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { list = []; }
      }
      return list;
    }

    function paint() {
      raf = 0;
      if (reduced() || document.hidden) { stop(); return; }
      var now = Date.now();
      cx += (tx - cx) * 0.24;
      cy += (ty - cy) * 0.24;
      var settled = Math.abs(tx - cx) < 0.0025 && Math.abs(ty - cy) < 0.0025;

      var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      var items = scan(), read = [], i;
      for (i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > -300 && r.top < vh + 300) read.push([items[i], r]);
      }
      for (i = 0; i < read.length; i++) {
        var box = read[i][1];
        var lx = (cx * vw - box.left) / box.width * 100;
        var ly = (cy * vh - box.top) / box.height * 100;
        read[i][0].style.setProperty('--zc-lx', Math.max(-40, Math.min(140, lx)).toFixed(1) + '%');
        read[i][0].style.setProperty('--zc-ly', Math.max(-40, Math.min(140, ly)).toFixed(1) + '%');
      }
      // 已经贴住目标、指针也安静了一阵：写完最后一帧就收工，省电
      if (settled && now - lastMove > 420) { running = false; return; }
      raf = requestAnimationFrame(paint);
    }

    function onMove(e) {
      var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      tx = e.clientX / vw;
      ty = e.clientY / vh;
      lastMove = Date.now();
      // 折射光池跟随指针：只改两个自定义属性，平滑过渡交给 CSS 的 transform transition
      if (poolOK) {
        root.style.setProperty('--zc-dx', Math.round(e.clientX) + 'px');
        root.style.setProperty('--zc-dy', Math.round(e.clientY) + 'px');
      }
      running = true;
      schedule();
    }

    // 页面滚动 / 尺寸变化时玻璃相对指针的位置也变了，需要重算高光
    function nudge() {
      if (reduced() || document.hidden) return;
      lastMove = Date.now() - 200; // 滚动期间持续刷新，停手后较快收尾
      running = true;
      schedule();
    }

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onMove, { passive: true });
    // 指针离开窗口：高光缓缓回到默认角度
    document.addEventListener('pointerleave', function () {
      if (reduced()) return;
      tx = 0.5; ty = 0.12; lastMove = Date.now(); running = true; schedule();
    }, { passive: true });
    window.addEventListener('scroll', nudge, { passive: true, capture: true });
    window.addEventListener('resize', nudge, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else if (running) schedule();
    });
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', function () { if (reduced()) stop(); });
      else if (mq.addListener) mq.addListener(function () { if (reduced()) stop(); });
    }
    if (window.MutationObserver) {
      // 新打开的菜单 / 对话框也要拿到高光坐标
      new MutationObserver(function () { lastScan = 0; }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (reduced()) return; // 减弱动态：完全交给 CSS 的静态玻璃
    scan();
  } catch (e) { /* 玻璃高光是纯装饰，失败不影响任何功能 */ }
})();

/* ---------- Toast ---------- */
const Toast = {
  show(msg, type, ms) {
    const box = $('#toasts');
    const t = el('div', { class: 'toast' + (type ? ' ' + type : ''), role: 'status' }, msg);
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    box.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, ms || (type === 'error' ? 4600 : 2400));
  },
  ok(m) { this.show(m, 'ok'); },
  err(m) { this.show(m, 'error'); },
  info(m) { this.show(m); }
};

/* ---------- 对话框（替代 confirm / prompt） ---------- */
const Dialog = {
  _open(opts) {
    return new Promise((resolve) => {
      const ov = $('#dialogOv'), input = $('#dlgInput'), ok = $('#dlgOk'), cancel = $('#dlgCancel');
      $('#dlgTitle').textContent = opts.title || '';
      const msg = $('#dlgMsg'); msg.textContent = opts.message || ''; msg.hidden = !opts.message;
      input.hidden = !opts.input; input.value = opts.value || '';
      ok.textContent = opts.okText || '确定';
      ok.className = 'btn ' + (opts.danger ? 'danger fill' : 'primary');
      cancel.hidden = !!opts.hideCancel;
      ov.hidden = false;
      const prevFocus = document.activeElement;
      setTimeout(() => (opts.input ? input : ok).focus(), 30);
      const done = (v) => {
        ov.hidden = true;
        ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true); ov.removeEventListener('mousedown', onBg);
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* ignore */ }
        resolve(v);
      };
      const onOk = () => done(opts.input ? input.value : true);
      const onCancel = () => done(opts.input ? null : false);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        else if (e.key === 'Enter' && (opts.input ? e.target === input : true)) { e.preventDefault(); e.stopPropagation(); onOk(); }
      };
      const onBg = (e) => { if (e.target === ov) onCancel(); };
      ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true); ov.addEventListener('mousedown', onBg);
    });
  },
  confirm(title, message, okText, danger) { return this._open({ title, message, okText, danger }); },
  prompt(title, value) { return this._open({ title, input: true, value }); },
  alert(title, message) { return this._open({ title, message, hideCancel: true }); }
};

/* ---------- 浮层菜单 ---------- */
const Pop = {
  node: null, anchor: null,
  open(anchor, node, opt) {
    opt = opt || {};
    this.close(true);
    node.classList.add('pop');
    $('#popLayer').appendChild(node);
    this.node = node; this.anchor = anchor;
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth, h = node.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = opt.alignRight ? r.right - w : r.left;
    left = clamp(left, 8, Math.max(8, vw - w - 8));
    let top;
    const up = !!(opt.up || (r.bottom + h + 8 > vh && r.top > h + 8));
    top = up ? r.top - h - 6 : r.bottom + 6;
    node.style.setProperty('--ox', opt.alignRight ? 'right' : 'left');
    node.style.setProperty('--oy', up ? 'bottom' : 'top');
    node.style.left = left + 'px'; node.style.top = clamp(top, 8, Math.max(8, vh - h - 8)) + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', Pop._onDown, true);
      document.addEventListener('keydown', Pop._onKey, true);
    }, 0);
    return node;
  },
  _onDown(e) { if (Pop.node && !Pop.node.contains(e.target) && !(Pop.anchor && Pop.anchor.contains(e.target))) Pop.close(); },
  _onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); Pop.close(); } },
  close(now) {
    const n = this.node;
    this.node = null;
    if (n) {
      if (now === true) n.remove();
      else { n.classList.add('out'); setTimeout(() => n.remove(), 140); }
    }
    document.removeEventListener('pointerdown', Pop._onDown, true);
    document.removeEventListener('keydown', Pop._onKey, true);
  },
  isOpenFor(anchor) { return !!this.node && this.anchor === anchor; },
  item(iconName, label, onClick, opts) {
    opts = opts || {};
    const b = el('button', { class: 'it' + (opts.sel ? ' sel' : ''), type: 'button', onclick: () => { if (!opts.keep) Pop.close(); onClick && onClick(); } });
    if (iconName) b.appendChild(icon(iconName));
    b.appendChild(el('span', { class: 'grow', text: label }));
    if (opts.sub) b.appendChild(el('span', { class: 'sub', text: opts.sub }));
    if (opts.sel) { const c = icon('check'); c.classList.add('ck'); b.appendChild(c); }
    return b;
  }
};


/* ==========================================================================
 * 02 接口适配（Format）与网络层（Net）
 *  - Format：OpenAI / Anthropic / Gemini / Ollama 的地址、请求头、请求体、响应解析
 *  - Net：直连 → 同源代理自动兜底、路由记忆、超时、指数退避重试、错误归类
 *  - Quirks：自动学习各模型不接受的参数（max_tokens / temperature / 推理参数 / 流式）
 * ========================================================================== */
const RELAY_PATH = '/__zc_relay__';
const NL = '\n';

const Format = {
  LIST: [
    { id: 'openai', label: 'OpenAI 兼容', short: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic Claude', short: 'Claude' },
    { id: 'gemini', label: 'Google Gemini', short: 'Gemini' },
    { id: 'ollama', label: 'Ollama', short: 'Ollama' }
  ],
  normalize(f) {
    f = String(f || '').toLowerCase();
    if (f === 'claude') f = 'anthropic';
    if (f === 'google') f = 'gemini';
    return this.LIST.some((x) => x.id === f) ? f : 'openai';
  },
  short(f) { const n = this.normalize(f); return this.LIST.filter((x) => x.id === n)[0].short; },
  guess(url) {
    const u = String(url || '').toLowerCase();
    if (u.indexOf('anthropic') >= 0 || /\/messages(\?|$)/.test(u)) return 'anthropic';
    if (u.indexOf('generativelanguage') >= 0 || u.indexOf('generatecontent') >= 0) return 'gemini';
    if (u.indexOf('/api/chat') >= 0 || u.indexOf(':11434') >= 0) return 'ollama';
    return 'openai';
  },
  of(cfg) { return !cfg ? 'openai' : (cfg.format ? this.normalize(cfg.format) : this.guess(cfg.url)); },

  trim(u) { return String(u || '').trim().replace(/[\/?#]+$/, ''); },
  root(url) {
    let u = this.trim(url);
    u = u.replace(/\/(chat\/completions|completions|messages|api\/chat)$/, '');
    u = u.replace(/\/(v1|v1beta)$/, '');
    return this.trim(u);
  },
  endpoint(fmt, cfg, stream) {
    fmt = this.normalize(fmt);
    const u = this.trim(cfg.url);
    if (fmt === 'openai') {
      if (u.indexOf('/chat/completions') >= 0) return u;
      if (/\/v\d+[a-z]*$/i.test(u)) return u + '/chat/completions';
      return this.root(u) + '/v1/chat/completions';
    }
    if (fmt === 'anthropic') {
      if (/\/messages$/.test(u)) return u;
      if (/\/v1$/.test(u)) return u + '/messages';
      return u + '/v1/messages';
    }
    if (fmt === 'ollama') {
      if (/\/api\/chat$/.test(u)) return u;
      if (/\/api$/.test(u)) return u + '/chat';
      return u + '/api/chat';
    }
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const model = String(cfg.model || 'gemini-1.5-flash').replace(/^models\//, '');
    let ep;
    if (/:(stream)?generatecontent/i.test(u)) ep = u.replace(/:(stream)?generatecontent.*$/i, ':' + method);
    else if (/\/models\/[^\/:]+$/.test(u)) ep = u + ':' + method;
    else ep = this.root(u) + '/v1beta/models/' + model + ':' + method;
    const q = [];
    if (cfg.key) q.push('key=' + encodeURIComponent(cfg.key));
    if (stream) q.push('alt=sse');
    return q.length ? ep + '?' + q.join('&') : ep;
  },
  headers(fmt, cfg, stream) {
    fmt = this.normalize(fmt);
    const h = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream, application/json' : 'application/json' };
    if (fmt === 'anthropic') {
      if (cfg.key) h['x-api-key'] = cfg.key;
      h['anthropic-version'] = '2023-06-01';
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (fmt === 'gemini') {
      if (cfg.key) h['x-goog-api-key'] = cfg.key;
    } else if (cfg.key) {
      h.Authorization = 'Bearer ' + cfg.key;
    }
    let extra = cfg.headers;
    if (typeof extra === 'string' && extra.trim()) { try { extra = JSON.parse(extra); } catch (e) { extra = null; } }
    if (isObj(extra)) for (const k in extra) if (extra[k] != null && extra[k] !== '') h[k] = String(extra[k]);
    return h;
  },

  /* ---- 消息拆分：文本 + 图片（跳过已被清理的图片） ---- */
  split(content) {
    const out = { text: '', images: [] };
    if (typeof content === 'string') { out.text = content; return out; }
    if (!Array.isArray(content)) return out;
    const texts = [];
    content.forEach((p) => {
      if (!p) return;
      if (p.type === 'text' && p.text) texts.push(p.text);
      else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
        const url = p.image_url.url; let mime = 'image/png', data = '';
        const ci = url.indexOf(',');
        if (url.indexOf('data:') === 0 && ci > 0) { const semi = url.indexOf(';'); mime = semi > 5 ? url.slice(5, semi) : 'image/png'; data = url.slice(ci + 1); }
        out.images.push({ mime, data, url });
      }
    });
    out.text = texts.join(NL + NL);
    return out;
  },
  /* 合并相邻同角色消息（Anthropic / Gemini / Ollama 更稳） */
  mergeSameRole(msgs) {
    const out = [];
    msgs.forEach((m) => {
      const last = out[out.length - 1];
      if (last && last.role === m.role) {
        const a = this.split(last.content), b = this.split(m.content);
        const parts = [];
        const t = [a.text, b.text].filter(Boolean).join(NL + NL);
        if (t) parts.push({ type: 'text', text: t });
        a.images.concat(b.images).forEach((im) => parts.push({ type: 'image_url', image_url: { url: im.url } }));
        last.content = parts;
      } else out.push({ role: m.role, content: m.content });
    });
    return out;
  },
  openaiContent(content) {
    if (typeof content === 'string') return content;
    const s = this.split(content);
    if (!s.images.length) return s.text || '';
    const parts = [];
    if (s.text) parts.push({ type: 'text', text: s.text });
    s.images.forEach((im) => parts.push({ type: 'image_url', image_url: { url: im.url } }));
    return parts;
  },

  buildBody(fmt, cfg, o) {
    fmt = this.normalize(fmt);
    const f = o.flags || {};
    const msgs = o.messages || [];
    let maxT = o.maxTokens || 0;
    if (f.maxCap && maxT > f.maxCap) maxT = f.maxCap;
    const temp = o.temperature;

    if (fmt === 'openai') {
      const b = { model: cfg.model, messages: msgs.map((m) => ({ role: m.role, content: this.openaiContent(m.content) })), stream: !!o.stream };
      if (!f.noTemp && temp != null) b.temperature = temp;
      if (maxT) b[f.mct ? 'max_completion_tokens' : 'max_tokens'] = maxT;
      if (o.stream && !f.noStreamOpts) b.stream_options = { include_usage: true };
      return Object.assign(b, o.extra || {});
    }

    let systemText = '';
    const rest = [];
    msgs.forEach((m) => {
      if (m.role === 'system') { const t = this.split(m.content).text; systemText = systemText ? systemText + NL + t : t; }
      else rest.push(m);
    });
    const merged = this.mergeSameRole(rest);
    while (merged.length && merged[0].role !== 'user') merged.shift();

    if (fmt === 'anthropic') {
      const list = merged.map((m) => {
        const s = this.split(m.content), blocks = [];
        s.images.forEach((im) => {
          if (im.data) blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
          else if (/^https?:/i.test(im.url)) blocks.push({ type: 'image', source: { type: 'url', url: im.url } });
        });
        if (s.text) blocks.push({ type: 'text', text: s.text });
        if (!blocks.length) blocks.push({ type: 'text', text: '(空)' });
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks };
      });
      const b = { model: cfg.model, messages: list, max_tokens: maxT || 4096, stream: !!o.stream };
      if (systemText) b.system = systemText;
      Object.assign(b, o.extra || {});
      if (b.thinking && b.thinking.type === 'enabled') {
        b.temperature = 1;
        if (b.max_tokens <= b.thinking.budget_tokens) b.max_tokens = b.thinking.budget_tokens + 2048;
      } else if (!f.noTemp && temp != null) b.temperature = Math.min(1, temp);
      return b;
    }

    if (fmt === 'gemini') {
      const contents = merged.map((m) => {
        const s = this.split(m.content), parts = [];
        if (s.text) parts.push({ text: s.text });
        s.images.forEach((im) => { if (im.data) parts.push({ inline_data: { mime_type: im.mime, data: im.data } }); });
        if (!parts.length) parts.push({ text: '(空)' });
        return { role: m.role === 'assistant' ? 'model' : 'user', parts };
      });
      const gc = {};
      if (!f.noTemp && temp != null) gc.temperature = Math.min(2, temp);
      if (maxT) gc.maxOutputTokens = maxT;
      const b = { contents, generationConfig: gc };
      if (systemText) b.systemInstruction = { parts: [{ text: systemText }] };
      if (o.extra && o.extra.thinkingBudget) gc.thinkingConfig = { thinkingBudget: o.extra.thinkingBudget, includeThoughts: true };
      return b;
    }

    const om = [];
    if (systemText) om.push({ role: 'system', content: systemText });
    merged.forEach((m) => {
      const s = this.split(m.content);
      const one = { role: m.role === 'assistant' ? 'assistant' : 'user', content: s.text || '' };
      const imgs = s.images.filter((im) => im.data).map((im) => im.data);
      if (imgs.length) one.images = imgs;
      om.push(one);
    });
    const opts = {};
    if (!f.noTemp && temp != null) opts.temperature = temp;
    if (maxT) opts.num_predict = maxT;
    const ob = { model: cfg.model, messages: om, stream: !!o.stream, options: opts };
    if (o.extra && o.extra.think) ob.think = true;
    return ob;
  },
  request(cfg, o) {
    const fmt = this.of(cfg);
    return { format: fmt, url: this.endpoint(fmt, cfg, !!o.stream), headers: this.headers(fmt, cfg, !!o.stream), body: this.buildBody(fmt, cfg, o) };
  },

  /* ---- 深度思考参数（stage 0=完整 1=精简 2=不带） ---- */
  LEVELS: {
    low: { text: '低', budget: 1024, gem: 1024, effort: 'low', max: 4096 },
    medium: { text: '中', budget: 4096, gem: 4096, effort: 'medium', max: 8192 },
    high: { text: '高', budget: 8192, gem: 8192, effort: 'high', max: 16384 },
    max: { text: '最高', budget: 16384, gem: 24576, effort: 'high', max: 32768 }
  },
  reasoning(fmt, level, stage) {
    const L = this.LEVELS[level] || this.LEVELS.medium;
    fmt = this.normalize(fmt);
    if (stage >= 2) return {};
    if (fmt === 'anthropic') return stage === 0 ? { thinking: { type: 'enabled', budget_tokens: L.budget } } : {};
    if (fmt === 'gemini') return stage === 0 ? { thinkingBudget: L.gem } : {};
    if (fmt === 'ollama') return stage === 0 ? { think: true } : {};
    return stage === 0 ? { reasoning_effort: L.effort, thinking: { type: 'enabled', budget_tokens: L.budget } } : { reasoning_effort: L.effort };
  },

  /* ---- 非流式响应解析 ---- */
  _oaText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (p && (p.text || (p.type === 'text' && p.text))) || '').join('');
    return '';
  },
  content(fmt, d) {
    fmt = this.normalize(fmt);
    if (!d) return '';
    if (fmt === 'anthropic') return (d.content || []).filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join(NL);
    if (fmt === 'gemini') {
      const c = d.candidates && d.candidates[0];
      return ((c && c.content && c.content.parts) || []).filter((p) => p && p.text && !p.thought).map((p) => p.text).join('');
    }
    if (fmt === 'ollama') return (d.message && d.message.content) || d.response || '';
    const ch = d.choices && d.choices[0];
    if (ch) return this._oaText(ch.message && ch.message.content) || (typeof ch.text === 'string' ? ch.text : '');
    return (typeof d.content === 'string' ? d.content : '') || (typeof d.response === 'string' ? d.response : '') || (typeof d.output_text === 'string' ? d.output_text : '');
  },
  reasoningContent(fmt, d) {
    fmt = this.normalize(fmt);
    if (!d) return '';
    if (fmt === 'anthropic') return (d.content || []).filter((b) => b && b.type === 'thinking' && b.thinking).map((b) => b.thinking).join(NL);
    if (fmt === 'gemini') {
      const c = d.candidates && d.candidates[0];
      return ((c && c.content && c.content.parts) || []).filter((p) => p && p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    }
    if (fmt === 'ollama') return (d.message && typeof d.message.thinking === 'string' && d.message.thinking) || '';
    const ch = d.choices && d.choices[0], m = ch && ch.message;
    if (m) { if (typeof m.reasoning_content === 'string' && m.reasoning_content) return m.reasoning_content; if (typeof m.reasoning === 'string' && m.reasoning) return m.reasoning; }
    return '';
  },
  usage(fmt, d) {
    fmt = this.normalize(fmt);
    if (!d) return null;
    if (fmt === 'anthropic' && d.usage) { const u = d.usage; return { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) }; }
    if (fmt === 'gemini' && d.usageMetadata) { const g = d.usageMetadata; return { prompt_tokens: g.promptTokenCount || 0, completion_tokens: (g.candidatesTokenCount || 0) + (g.thoughtsTokenCount || 0), total_tokens: g.totalTokenCount || 0 }; }
    if (fmt === 'ollama' && (d.prompt_eval_count || d.eval_count)) return { prompt_tokens: d.prompt_eval_count || 0, completion_tokens: d.eval_count || 0, total_tokens: (d.prompt_eval_count || 0) + (d.eval_count || 0) };
    const u = d.usage;
    return u && (u.prompt_tokens || u.completion_tokens || u.total_tokens) ? { prompt_tokens: u.prompt_tokens || u.input_tokens || 0, completion_tokens: u.completion_tokens || u.output_tokens || 0, total_tokens: u.total_tokens || 0 } : null;
  },
  finishReason(fmt, d) {
    fmt = this.normalize(fmt);
    if (!d) return null;
    if (fmt === 'anthropic') return d.stop_reason || null;
    if (fmt === 'gemini') { const c = d.candidates && d.candidates[0]; return (c && c.finishReason) || null; }
    if (fmt === 'ollama') return d.done_reason || (d.done ? 'stop' : null);
    const ch = d.choices && d.choices[0];
    return (ch && ch.finish_reason) || null;
  },
  isLength(fmt, r) {
    if (!r) return false;
    fmt = this.normalize(fmt);
    return fmt === 'anthropic' ? r === 'max_tokens' : fmt === 'gemini' ? r === 'MAX_TOKENS' : r === 'length';
  },

  /* ---- 流式增量解析 ---- */
  delta(fmt, j) {
    fmt = this.normalize(fmt);
    if (!j) return '';
    if (fmt === 'anthropic') {
      if (j.type === 'content_block_delta' && j.delta && j.delta.type !== 'thinking_delta' && j.delta.type !== 'signature_delta') return j.delta.text || '';
      if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'text') return j.content_block.text || '';
      return '';
    }
    if (fmt === 'gemini') return this.content('gemini', j);
    if (fmt === 'ollama') return (j.message && j.message.content) || j.response || '';
    const ch = j.choices && j.choices[0];
    if (!ch) return typeof j.content === 'string' ? j.content : (typeof j.response === 'string' ? j.response : '');
    if (ch.delta) return this._oaText(ch.delta.content);
    if (typeof ch.text === 'string') return ch.text;
    if (ch.message) return this._oaText(ch.message.content);
    return '';
  },
  reasoningDelta(fmt, j) {
    fmt = this.normalize(fmt);
    if (!j) return '';
    if (fmt === 'anthropic') {
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'thinking_delta') return j.delta.thinking || '';
      if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'thinking') return j.content_block.thinking || '';
      return '';
    }
    if (fmt === 'gemini' || fmt === 'ollama') return this.reasoningContent(fmt, j);
    const ch = j.choices && j.choices[0];
    if (!ch) return '';
    const d = ch.delta || ch.message;
    if (d) { if (typeof d.reasoning_content === 'string') return d.reasoning_content; if (typeof d.reasoning === 'string') return d.reasoning; }
    return '';
  },
  streamUsage(fmt, j) {
    fmt = this.normalize(fmt);
    if (!j) return null;
    if (fmt === 'anthropic') {
      if (j.type === 'message_delta' && j.usage) return { prompt_tokens: j.usage.input_tokens || 0, completion_tokens: j.usage.output_tokens || 0, total_tokens: (j.usage.input_tokens || 0) + (j.usage.output_tokens || 0), partial: true };
      if (j.type === 'message_start' && j.message) return this.usage('anthropic', j.message);
      return null;
    }
    return this.usage(fmt, j);
  },
  streamFinish(fmt, j) {
    fmt = this.normalize(fmt);
    if (!j) return null;
    if (fmt === 'anthropic') return j.type === 'message_delta' && j.delta ? j.delta.stop_reason || null : null;
    return this.finishReason(fmt, j);
  },
  streamEnded(fmt, j) {
    fmt = this.normalize(fmt);
    if (fmt === 'anthropic') return !!j && j.type === 'message_stop';
    if (fmt === 'ollama') return !!j && j.done === true;
    return false;
  },
  streamError(j) {
    if (!j) return '';
    if (j.type === 'error' && j.error) return j.error.message || JSON.stringify(j.error);
    if (j.error) return typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
    return '';
  },

  /* ---- 模型列表 ---- */
  modelEndpoints(fmt, url, key) {
    fmt = this.normalize(fmt);
    const u = this.trim(url).replace(/\/(chat\/completions|completions|messages|api\/chat)$/, '');
    const base = this.root(url);
    let origin = '';
    try { const p = new URL(base); origin = p.protocol + '//' + p.host; } catch (e) { /* ignore */ }
    let list;
    if (fmt === 'ollama') list = [base + '/api/tags'];
    else if (fmt === 'gemini') list = [base + '/v1beta/models'];
    else if (fmt === 'anthropic') list = [base + '/v1/models', origin && origin + '/v1/models', origin && origin + '/models', origin && origin + '/compatible-mode/v1/models'];
    else list = [/\/v\d+[a-z]*$/i.test(u) ? u + '/models' : '', base + '/v1/models', base + '/models'];
    const seen = {};
    return list.filter((x) => x && !seen[x] && (seen[x] = 1));
  },
  parseModels(fmt, d) {
    fmt = this.normalize(fmt);
    if (!d) return [];
    let arr = fmt === 'ollama' || fmt === 'gemini' ? d.models : (d.data || d.models || d.list || (Array.isArray(d) ? d : null));
    if (!Array.isArray(arr)) return [];
    const out = [];
    arr.forEach((m) => {
      if (fmt === 'gemini' && m && m.supportedGenerationMethods && m.supportedGenerationMethods.indexOf('generateContent') < 0) return;
      let id = typeof m === 'string' ? m : (m && (m.id || m.name || m.model)) || '';
      if (fmt === 'gemini' && id.indexOf('models/') === 0) id = id.slice(7);
      if (id) out.push(id);
    });
    return Array.from(new Set(out));
  }
};

/* ---------- 从错误响应中提取可读信息 ---------- */
function extractErrorText(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const e = j.error || j;
    if (typeof e === 'string') return e;
    return e.message || e.msg || e.detail || (Array.isArray(j.detail) && JSON.stringify(j.detail)) || JSON.stringify(j).slice(0, 400);
  } catch (e) { /* 非 JSON */ }
  const t = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
}

/* ---------- 网络层 ---------- */
const Net = {
  cache: null,
  _load() { if (!this.cache) this.cache = Store.get('route_cache', {}) || {}; return this.cache; },
  _remember(host, route) {
    const c = this._load();
    if (c[host] && c[host].r === route) return;
    c[host] = { r: route, t: Date.now() };
    Store.set('route_cache', c, true);
  },
  _preferred(host) {
    const e = this._load()[host];
    return e && Date.now() - e.t < 7 * 86400000 ? e.r : null;
  },
  isPrivateHost(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === 'localhost' || h.endsWith('.local') || h === '[::1]' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    } catch (e) { return false; }
  },
  classify(status) {
    if (status === 401 || status === 403) return { retry: false, kind: 'auth' };
    if (status === 402) return { retry: false, kind: 'quota' };
    if (status === 404) return { retry: false, kind: 'notfound' };
    if (status === 408) return { retry: true, kind: 'timeout' };
    if (status === 429) return { retry: true, kind: 'ratelimit' };
    if (status >= 500 && status <= 599) return { retry: status !== 501, kind: 'server' };
    return { retry: false, kind: status >= 400 ? 'client' : 'ok' };
  },
  friendly(status) {
    if (status === 401) return 'API Key 无效或未授权，请检查密钥。';
    if (status === 402) return '账户余额不足或额度已用尽。';
    if (status === 403) return '权限不足，服务端拒绝了本次访问。';
    if (status === 404) return '接口地址或模型不存在，请检查 API 地址和模型名称。';
    if (status === 413) return '请求内容过大，请减少图片数量或缩短上下文。';
    if (status === 429) return '请求过于频繁或额度受限，请稍后再试。';
    if (status >= 500) return '服务端暂时不可用，请稍后重试。';
    return '';
  },
  backoff(n) { const exp = Math.min(20000, 800 * Math.pow(2, Math.max(0, n - 1))); return Math.round(exp * (0.8 + Math.random() * 0.4)); },
  retryAfter(resp) {
    const v = resp.headers.get('retry-after');
    if (!v) return 0;
    const s = parseFloat(v);
    if (!isNaN(s)) return clamp(s * 1000, 0, 30000);
    const d = Date.parse(v);
    return isNaN(d) ? 0 : clamp(d - Date.now(), 0, 30000);
  },

  async _send(route, url, opts, timeoutMs, ext) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onAbort = () => ctrl.abort();
    if (ext) {
      if (ext.aborted) { clearTimeout(timer); throw abortError(); }
      ext.addEventListener('abort', onAbort, { once: true });
    }
    try {
      let resp;
      const method = opts.method || 'GET';
      if (route === 'relay') {
        const h = {};
        const src = opts.headers || {};
        Object.keys(src).forEach((k) => { h[k] = src[k]; });
        h['x-zc-target-url'] = encodeURIComponent(url);
        h['x-zc-target-method'] = method;
        h['x-zc-timeout-ms'] = String(Math.min(600000, timeoutMs + 5000));
        resp = await fetch(RELAY_PATH, { method, headers: h, body: opts.body, signal: ctrl.signal, cache: 'no-store' });
        if (resp.headers.get('x-zc-relay-error')) {
          let info = {};
          try { info = await resp.json(); } catch (e) { /* ignore */ }
          const err = new Error(info.error || ('代理返回错误 ' + resp.status));
          err.kind = info.code === 'RELAY_TIMEOUT' ? 'timeout' : 'relay';
          err.code = info.code || '';
          err.status = resp.status;
          err.fatal = /FORBIDDEN|BAD_|BLOCKED|NOT_ALLOWED|TOO_LARGE/.test(err.code);
          throw err;
        }
        if (!resp.headers.get('x-zc-relay')) {
          const err = new Error('本站代理不可用（当前页面可能不是通过 Worker 打开的）');
          err.kind = 'relay'; err.code = 'RELAY_UNAVAILABLE'; err.unavailable = true;
          throw err;
        }
      } else {
        resp = await fetch(url, { method, headers: opts.headers, body: opts.body, signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
      }
      clearTimeout(timer);
      resp.zcRoute = route;
      return resp;
    } catch (e) {
      clearTimeout(timer);
      if (ext && ext.aborted) throw abortError();
      if (timedOut) { const t = new Error('等待服务端响应超过 ' + Math.round(timeoutMs / 1000) + ' 秒'); t.kind = 'timeout'; throw t; }
      if (!e.kind) e.kind = 'network';
      throw e;
    }
  },

  /* 单次请求：按连接方式选择路线，直连失败自动改走站内代理 */
  async request(url, opts) {
    const timeoutMs = opts.timeoutMs || 120000;
    const mode = opts.route || 'auto';
    const host = this._host(url);
    let order;
    if (mode === 'direct') order = ['direct'];
    else if (mode === 'relay') order = ['relay'];
    else if (this.isPrivateHost(url)) order = ['direct'];
    else if (/^http:/i.test(url) && location.protocol === 'https:') order = ['relay', 'direct'];
    else order = this._preferred(host) === 'relay' ? ['relay', 'direct'] : ['direct', 'relay'];

    const attempts = [];
    for (let i = 0; i < order.length; i++) {
      const route = order[i];
      try {
        const resp = await this._send(route, url, opts, timeoutMs, opts.signal);
        if (mode === 'auto') this._remember(host, route);
        return resp;
      } catch (e) {
        if (e.kind === 'abort') throw e;
        attempts.push({ route, message: e.message || String(e), kind: e.kind, code: e.code });
        if (e.kind === 'timeout' && route === 'direct' && order.length > 1) { /* 直连超时也尝试代理 */ }
        if (e.fatal) break;
      }
    }
    const last = attempts[attempts.length - 1] || {};
    const err = new Error(last.message || '网络请求失败');
    err.kind = attempts.some((a) => a.kind === 'timeout') ? 'timeout' : (attempts.length && attempts.every((a) => a.kind === 'relay') ? 'relay' : 'network');
    err.attempts = attempts;
    err.url = url;
    throw err;
  },
  _host(u) { try { return new URL(u).host; } catch (e) { return String(u); } },

  /* 带重试：429 / 5xx / 超时 / 网络错误 指数退避；尊重 Retry-After */
  async call(url, opts) {
    const retries = opts.retries != null ? opts.retries : 2;
    let n = 0;
    for (;;) {
      try {
        const resp = await this.request(url, opts);
        if (resp.status >= 400 && this.classify(resp.status).retry && n < retries) {
          const wait = this.retryAfter(resp) || this.backoff(n + 1);
          try { await resp.body.cancel(); } catch (e) { /* ignore */ }
          n++;
          if (opts.onRetry) opts.onRetry(n, 'HTTP ' + resp.status, wait);
          await sleep(wait, opts.signal);
          continue;
        }
        return resp;
      } catch (e) {
        if (e.kind === 'abort' || n >= retries || e.fatal || (e.attempts && e.attempts.some((a) => a.code && /FORBIDDEN|BAD_|BLOCKED|NOT_ALLOWED|TOO_LARGE/.test(a.code)))) throw e;
        const wait = this.backoff(n + 1);
        n++;
        if (opts.onRetry) opts.onRetry(n, e.message, wait);
        await sleep(wait, opts.signal);
      }
    }
  },

  /* 把网络层异常转换为面向用户的说明 */
  explain(err, url) {
    if (!err) return '未知错误';
    const parts = [];
    const at = err.attempts || [];
    const relayDown = at.some((a) => a.code === 'RELAY_UNAVAILABLE');
    if (err.kind === 'timeout') {
      parts.push('请求超时：服务端长时间没有响应。深度思考、图片或长上下文可能需要更久，可在 设置 → 对话 中调大超时时间。');
    } else if (this.isPrivateHost(url || err.url || '')) {
      parts.push('无法连接到本机/内网地址。请确认服务已启动；若是 Ollama，需设置环境变量 OLLAMA_ORIGINS="*" 后重启，并允许浏览器访问本地网络。');
    } else if (relayDown) {
      parts.push('浏览器直连被拦截（多为跨域 CORS 限制），且当前页面无法使用站内代理。请通过部署好的 Worker 地址打开本页面。');
    } else {
      parts.push('无法连接到 API 服务：浏览器直连与站内代理均失败。');
    }
    at.forEach((a) => { parts.push((a.route === 'direct' ? '· 直连：' : '· 代理：') + (a.route === 'direct' && a.kind === 'network' ? '被浏览器拦截或网络不通（CORS / 网络）' : a.message)); });
    if (err.kind !== 'timeout') parts.push('排查：检查地址拼写与协议、Key 是否有效、目标服务是否可从公网访问。');
    return parts.join(NL);
  }
};

/* ---------- 参数兼容性自学习 ---------- */
const Quirks = {
  key(api) { return (api.id || api.url) + '|' + api.model; },
  get(api) { const all = Store.get('quirks', {}) || {}; return Object.assign({}, all[this.key(api)] || {}); },
  save(api, flags) {
    const all = Store.get('quirks', {}) || {};
    const keys = Object.keys(all);
    if (keys.length > 80) delete all[keys[0]];
    all[this.key(api)] = flags;
    Store.set('quirks', all, true);
  },
  /* 根据 400/422 错误文本推断需要调整的参数；返回是否已调整 */
  adapt(status, text, flags, st) {
    if (status !== 400 && status !== 422 && status !== 500) return false;
    const t = String(text || '').toLowerCase();
    if (!t) return false;
    if (t.indexOf('max_completion_tokens') >= 0 && !flags.mct) { flags.mct = true; return true; }
    if (t.indexOf('stream_options') >= 0 && !flags.noStreamOpts) { flags.noStreamOpts = true; return true; }
    if (t.indexOf('temperature') >= 0 && !flags.noTemp) { flags.noTemp = true; return true; }
    if (/(max_tokens|maximum context|max_output|output tokens|maxoutputtokens)/.test(t) && /(at most|maximum|max |limit|less than or equal|up to|exceed)/.test(t)) {
      const nums = (t.match(/\d{3,6}/g) || []).map(Number).filter((n) => n >= 256 && n <= 300000);
      if (nums.length) {
        const cap = Math.min.apply(null, nums);
        if (!flags.maxCap || cap < flags.maxCap) { flags.maxCap = cap; return true; }
      }
    }
    if (/stream/.test(t) && /(not support|unsupported|must be false|does not support|not allowed|only supports)/.test(t) && !flags.noStream) { flags.noStream = true; return true; }
    if (st.deep && st.stage < 2 && /(reasoning|thinking|budget_tokens|thinkingconfig|thinking_budget|unknown parameter|unsupported parameter|unrecognized|additional properties|not allowed|unexpected field|extra_forbidden|invalid parameter|invalid_request|think)/.test(t)) { st.stage++; return true; }
    return false;
  }
};


/* ==========================================================================
 * 03 Markdown 渲染与轻量代码高亮（无外部依赖，所有文本先转义，天然防 XSS）
 * ========================================================================== */
const Hl = (function () {
  const BT = '\\x60';
  const KW = 'function const let var return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this super null true false undefined void delete yield static public private protected interface type enum implements package def lambda pass None True False and or not is elif with as raise global nonlocal fn mut impl struct trait use pub match loop func go chan defer select range map nil int string bool float double char long short byte namespace using template typename echo fi then done esac readonly abstract final override virtual extern unsigned signed sizeof typedef union goto volatile inline where let rec val fun object companion when init constructor get set';
  const SQL = 'select from where insert into values update set delete join left right inner outer on group by order having limit offset create table alter drop index view primary key foreign references null not and or as distinct union all case when then else end like in is between exists count sum avg min max asc desc';
  const kwRe = '\\b(?:' + KW.split(' ').join('|') + ')\\b';
  const sqlRe = '\\b(?:' + SQL.split(' ').join('|') + ')\\b';
  const strRe = '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|' + BT + '(?:\\\\.|[^' + BT + '\\\\])*' + BT;
  const numRe = '\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[0-9a-f]+\\b';
  const slash = '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)';
  const hash = '#[^\\n]*';
  const dash = '--[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)';
  const HASH = ' python py bash sh shell zsh yaml yml toml ruby rb r perl pl ini conf dockerfile makefile powershell ps1 nginx ';
  const SLASH = ' js javascript ts typescript jsx tsx java c cpp c++ h hpp cs csharp go golang rust rs swift kotlin kt php scala dart css scss less json json5 jsonc vue svelte objc ';
  const cache = {};
  function build(lang) {
    if (cache[lang]) return cache[lang];
    let src, kinds;
    if (lang === 'sql') { src = '(' + dash + ')|(' + strRe + ')|(' + numRe + ')|(' + sqlRe + ')'; kinds = ['c', 's', 'n', 'k']; return (cache[lang] = { re: new RegExp(src, 'gi'), kinds }); }
    const com = HASH.indexOf(' ' + lang + ' ') >= 0 ? hash : slash;
    src = '(' + com + ')|(' + strRe + ')|(' + numRe + ')|(' + kwRe + ')'; kinds = ['c', 's', 'n', 'k'];
    return (cache[lang] = { re: new RegExp(src, 'g'), kinds });
  }
  const markupRe = new RegExp('(<!\\x2d\\x2d[\\s\\S]*?(?:\\x2d\\x2d>|$))|(<\\/?[A-Za-z][\\w:.-]*)|("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')|(\\b[\\w:-]+(?==))', 'g');
  function run(code, re, kinds) {
    let out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(code.slice(last, m.index));
      let k = 0;
      for (let i = 1; i <= kinds.length; i++) if (m[i] !== undefined) { k = i - 1; break; }
      out += '<span class="tk-' + kinds[k] + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }
  return function highlight(code, lang) {
    lang = String(lang || '').toLowerCase();
    if (code.length > 60000) return esc(code);
    if (/^(html|xml|svg|htm|xhtml)$/.test(lang)) return run(code, markupRe, ['c', 't', 's', 'a']);
    if (HASH.indexOf(' ' + lang + ' ') >= 0 || SLASH.indexOf(' ' + lang + ' ') >= 0 || lang === 'sql') {
      const b = build(lang);
      return run(code, b.re, b.kinds);
    }
    return esc(code);
  };
})();

const Md = (function () {
  let fileCount = 0, live = false, hasGen = false;
  const FENCE = /^\s{0,3}([\x60~]{3,})\s*([^\s\x60]*)([^\n]*)$/;
  const HEAD = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const LI = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TSEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  const SAFE_IMG = /^(?:https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,|blob:)/i;
  const IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^\s]*)?$/i;

  function indentOf(s) { return s.replace(/\t/g, '    ').length; }

  function inline(src) {
    const hold = [];
    const put = (html) => { hold.push(html); return '\u0000' + (hold.length - 1) + '\u0000'; };
    let s = String(src);
    s = s.replace(/\\([\\\x60*_{}\[\]()#+\-.!|~>])/g, (m, c) => put(esc(c)));
    s = s.replace(/(\x60+)([\s\S]*?[^\x60])\1(?!\x60)/g, (m, a, b) => put('<code class="ic-code">' + esc(b.replace(/^\s(.*)\s$/, '$1')) + '</code>'));
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\s*\)/g, (m, alt, url) => {
      url = url.replace(/&amp;/g, '&');
      if (!SAFE_IMG.test(url)) return m;
      return put('<img src="' + esc(url) + '" alt="' + alt + '" loading="lazy" data-zoom="1">');
    });
    s = s.replace(/\[([^\]]+)\]\(\s*((?:https?:\/\/|mailto:)[^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\s*\)/g, (m, text, url) => {
      return put('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + inline2(text) + '</a>');
    });
    s = s.replace(/(^|[\s(（>])(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)）\]，。；：！？])/g, (m, pre, url) => {
      const raw = url.replace(/&amp;/g, '&');
      if (IMG_EXT.test(raw)) return pre + put('<img src="' + url + '" alt="图片" loading="lazy" data-zoom="1">');
      return pre + put('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
    });
    s = inline2(s);
    s = s.replace(/\n/g, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => hold[+i]);
    function inline2(t) {
      return t
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
        .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>');
    }
  }

  function splitRow(line) {
    let t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|' && t.charAt(t.length - 2) !== '\\') t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function codeBlock(code, lang, info, closed) {
    const f = FileGen.info(lang, info, code);
    if (f.named) {
      const gen = live && !closed;
      if (gen) hasGen = true; else fileCount++;
      return FileGen.card(f, code, gen);
    }
    return '<div class="code"><div class="code-h"><span>' + esc(f.lang || 'text') + '</span><span class="code-act"><button type="button" data-dl="' + esc(f.name) + '"><svg class="ic sm"><use href="#i-download"/></svg><span>下载</span></button><button type="button" data-copy="1"><svg class="ic sm"><use href="#i-copy"/></svg><span>复制</span></button></span></div><pre><code>' + Hl(code, f.lang) + '</code></pre></div>';
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    const n = lines.length;
    const isBlank = (l) => !l || !l.trim();
    const startsBlock = (l, next) => FENCE.test(l) || HEAD.test(l) || HR.test(l) || /^\s{0,3}>/.test(l) || (l.indexOf('|') >= 0 && next !== undefined && TSEP.test(next) && next.indexOf('-') >= 0 && l.trim().length > 0 && (next.indexOf('|') >= 0 || l.indexOf('|') >= 0));
    while (i < n) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      let m = FENCE.exec(line);
      if (m) {
        const fence = m[1], ch = fence.charAt(0), lang = m[2], info = m[3];
        const body = [];
        let closed = false;
        i++;
        while (i < n) {
          const t = lines[i].trim();
          if (t.length >= fence.length && t.charAt(0) === ch && new RegExp('^' + (ch === '~' ? '~' : '\\x60') + '{' + fence.length + ',}$').test(t)) { i++; closed = true; break; }
          body.push(lines[i]); i++;
        }
        out.push(codeBlock(body.join('\n'), lang, info, closed));
        continue;
      }
      if ((m = HEAD.exec(line))) { out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
      if (HR.test(line) && !LI.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        const q = [];
        while (i < n && /^\s{0,3}>/.test(lines[i])) { q.push(lines[i].replace(/^\s{0,3}> ?/, '')); i++; }
        out.push('<blockquote>' + blocks(q) + '</blockquote>');
        continue;
      }
      if (line.indexOf('|') >= 0 && i + 1 < n && TSEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0 && (lines[i + 1].indexOf('|') >= 0 || line.indexOf('|') >= 0)) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
        i += 2;
        const rows = [];
        while (i < n && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++; }
        const al = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
        let h = '<div class="tbl"><table><thead><tr>' + head.map((c, k) => '<th' + al(k) + '>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
        rows.forEach((r) => { h += '<tr>' + head.map((c, k) => '<td' + al(k) + '>' + inline(r[k] || '') + '</td>').join('') + '</tr>'; });
        out.push(h + '</tbody></table></div>');
        continue;
      }
      if ((m = LI.exec(line))) {
        const base = indentOf(m[1]);
        const ordered = /\d/.test(m[2].charAt(0));
        const start = ordered ? parseInt(m[2], 10) : 1;
        const items = [];
        let cur = null;
        while (i < n) {
          const l = lines[i];
          if (isBlank(l)) {
            let j = i + 1;
            while (j < n && isBlank(lines[j])) j++;
            if (j < n && (indentOf(lines[j].match(/^\s*/)[0]) > base || (LI.test(lines[j]) && indentOf(LI.exec(lines[j])[1]) >= base && /\d/.test(LI.exec(lines[j])[2].charAt(0)) === ordered))) { if (cur) cur.lines.push(''); i++; continue; }
            break;
          }
          const lm = LI.exec(l);
          const ind = indentOf(l.match(/^\s*/)[0]);
          if (lm && ind <= base + 1) {
            if (ind < base || /\d/.test(lm[2].charAt(0)) !== ordered) break;
            cur = { lines: [lm[3]], col: l.length - lm[3].length }; items.push(cur); i++; continue;
          }
          if (ind < base + 1 && !cur) break;
          if (cur && (ind > base || !startsBlock(l))) { cur.lines.push(l.replace(new RegExp('^\\s{0,' + cur.col + '}'), '')); i++; continue; }
          break;
        }
        const tag = ordered ? 'ol' : 'ul';
        let h = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>';
        items.forEach((it) => {
          let first = it.lines[0], task = '';
          const tm = /^\[([ xX])\]\s+/.exec(first);
          if (tm) { task = '<input type="checkbox" disabled' + (tm[1] !== ' ' ? ' checked' : '') + '>'; it.lines[0] = first.slice(tm[0].length); }
          let inner = blocks(it.lines);
          if (/^<p>[\s\S]*<\/p>$/.test(inner) && inner.indexOf('<p>', 3) < 0) inner = inner.slice(3, -4);
          h += '<li' + (tm ? ' class="task"' : '') + '>' + task + inner + '</li>';
        });
        out.push(h + '</' + tag + '>');
        continue;
      }
      const para = [];
      while (i < n && !isBlank(lines[i]) && !(para.length && (startsBlock(lines[i], lines[i + 1]) || LI.test(lines[i])))) {
        para.push(lines[i]); i++;
      }
      if (!para.length) { para.push(lines[i]); i++; }
      out.push('<p>' + inline(para.join('\n')) + '</p>');
    }
    return out.join('');
  }

  return {
    render(text, lv) { fileCount = 0; hasGen = false; live = !!lv; const h = blocks(String(text || '').replace(/\r\n?/g, '\n').split('\n')); return h + FileGen.footer(hasGen ? 0 : fileCount); },
    inline
  };
})();

/* <think>…</think> 拆分（部分模型把推理直接写在正文里） */
function splitThink(text) {
  const t = String(text || '');
  const m = /^\s*<think(?:ing)?>([\s\S]*?)(<\/think(?:ing)?>|$)/i.exec(t);
  if (!m) return { reasoning: '', content: t, open: false };
  return { reasoning: m[1].trim(), content: t.slice(m[0].length).replace(/^\s+/, ''), open: !m[2] };
}


/* ==========================================================================
 * 04 状态：设置、API 配置、深度思考、用量统计、会话
 * ========================================================================== */
const DEFAULTS = { theme: 'auto', fontSize: 'medium', ctx: 30, temp: 0.7, maxTokens: 0, timeout: 120, stream: true, showThink: true, fileGen: true };

const Settings = {
  d: Object.assign({}, DEFAULTS),
  init() {
    const saved = Store.get('settings', null);
    if (isObj(saved)) this.d = Object.assign({}, DEFAULTS, saved);
    else {
      // 兼容旧版：夜间模式 / 字号
      if (Store.get('dark_mode', false) === true) this.d.theme = 'dark';
      const fs = Store.get('font_size', 'medium');
      if (fs === 'small' || fs === 'large') this.d.fontSize = fs;
    }
    this.apply();
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const fn = () => { if (this.d.theme === 'auto') this.apply(); };
      if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
    } catch (e) { /* ignore */ }
  },
  get(k) { return this.d[k]; },
  set(k, v) { this.d[k] = v; Store.set('settings', this.d); },
  resolvedTheme() {
    if (this.d.theme === 'light' || this.d.theme === 'dark') return this.d.theme;
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  },
  apply() {
    const root = document.documentElement;
    const t = this.resolvedTheme();
    root.setAttribute('data-theme', t);
    root.classList.remove('fs-small', 'fs-large');
    if (this.d.fontSize === 'small') root.classList.add('fs-small');
    if (this.d.fontSize === 'large') root.classList.add('fs-large');
    const use = $('#themeUse');
    if (use) use.setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  }
};

const Api = {
  list: [], idx: 0, detected: [],
  init() {
    const raw = Store.get('apis', []);
    this.list = Array.isArray(raw) ? raw.filter(isObj) : [];
    let dirty = false;
    this.list.forEach((a) => {
      if (!a.id) { a.id = uid(); dirty = true; }
      if (!a.format) { a.format = Format.guess(a.url); dirty = true; }
      if (!a.route) { a.route = 'auto'; dirty = true; }
    });
    const i = Store.get('current_api', 0);
    this.idx = typeof i === 'number' && i >= 0 && i < this.list.length ? i : 0;
    const d = Store.get('detected_models', []);
    this.detected = Array.isArray(d) ? d : [];
    if (dirty) this.save();
  },
  save() { Store.set('apis', this.list); Store.set('current_api', this.idx); },
  current() { return this.list[this.idx] || null; },
  ready() { const a = this.current(); return !!(a && a.url && a.model); },
  add(cfg) { const a = Object.assign({ id: uid(), name: '未命名 API', url: '', key: '', model: '', format: 'openai', route: 'auto', headers: '' }, cfg); this.list.push(a); this.idx = this.list.length - 1; this.save(); return a; },
  update(i, cfg) { Object.assign(this.list[i], cfg); this.save(); },
  remove(i) { this.list.splice(i, 1); if (this.idx >= this.list.length) this.idx = Math.max(0, this.list.length - 1); this.save(); },
  use(i) { if (i >= 0 && i < this.list.length) { this.idx = i; this.save(); } },
  setDetected(models) { this.detected = models; Store.set('detected_models', models); }
};

const Deep = {
  on: false, level: 'medium',
  init() {
    const v = Store.get('deep_think', false);
    this.on = v === true || v === 'true';
    const l = Store.get('deep_think_level', 'medium');
    this.level = Format.LEVELS[l] ? l : 'medium';
  },
  set(on, level) {
    this.on = !!on;
    if (level && Format.LEVELS[level]) this.level = level;
    Store.set('deep_think', this.on); Store.set('deep_think_level', this.level);
  },
  maxTokens() { return Format.LEVELS[this.level].max; }
};

const Token = {
  s: { total: 0, input: 0, output: 0, cost: 0 },
  init() { const v = Store.get('token_stats', null); if (isObj(v)) this.s = Object.assign(this.s, v); },
  add(u, model) {
    if (!u) return;
    const i = u.prompt_tokens || 0, o = u.completion_tokens || 0, t = u.total_tokens || i + o;
    this.s.input += i; this.s.output += o; this.s.total += t;
    const m = String(model || '').toLowerCase();
    let pi = 0.000001, po = 0.000002;
    if (/gpt-4|claude-3|claude-(opus|sonnet)|o1|o3|gpt-5/.test(m)) { pi = 0.000005; po = 0.000015; }
    else if (/gpt-3\.5|haiku|mini|flash|deepseek|qwen/.test(m)) { pi = 0.0000005; po = 0.0000015; }
    this.s.cost += i * pi + o * po;
    Store.set('token_stats', this.s, true);
  },
  estimate(text) { return Math.ceil(String(text || '').length / (/[\u4e00-\u9fff]/.test(text) ? 1.6 : 4)); },
  reset() { this.s = { total: 0, input: 0, output: 0, cost: 0 }; Store.set('token_stats', this.s); }
};

/* ---------- 会话 ---------- */
const Sessions = {
  list: [], curId: null,
  init() {
    const raw = Store.get('sessions', []);
    this.list = Array.isArray(raw) ? raw.filter((s) => isObj(s) && s.id) : [];
    this.list.forEach((s) => {
      if (!Array.isArray(s.messages)) s.messages = [];
      s.messages = s.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
      s.messages.forEach((m) => { if (!m.id) m.id = uid(); });
      if (!s.createdAt) s.createdAt = Date.now();
    });
    const cur = Store.get('current_session', null);
    if (cur && this.list.some((s) => s.id === cur)) this.curId = cur;
    else if (this.list.length) this.curId = this.sorted()[0].id;
    else this.create(true);
  },
  sorted() { return this.list.slice().sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)); },
  cur() { return this.list.filter((s) => s.id === this.curId)[0] || null; },
  msgs() { const c = this.cur(); return c ? c.messages : []; },
  create(silent) {
    const s = { id: uid(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [], model: (Api.current() || {}).model || '' };
    this.list.push(s); this.curId = s.id;
    if (!silent) this.save();
    return s;
  },
  switchTo(id) { if (this.list.some((s) => s.id === id)) { this.curId = id; Store.set('current_session', id); } },
  remove(id) {
    const i = this.list.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.list.splice(i, 1);
    Sync.tombstone(id);
    if (!this.list.length) this.create(true);
    else if (this.curId === id) this.curId = this.sorted()[0].id;
    this.save();
  },
  rename(id, title) {
    const s = this.list.filter((x) => x.id === id)[0];
    if (!s) return;
    s.title = String(title || '').trim().slice(0, 80) || '新对话'; s.titleLocked = true; this.save();
  },
  clearAll() { this.list.forEach((s) => Sync.tombstone(s.id)); this.list = []; this.create(true); this.save(); },
  textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
    return '';
  },
  autoTitle(s) {
    if (s.titleLocked) return;
    const u = s.messages.filter((m) => m.role === 'user')[0];
    if (!u) { s.title = '新对话'; return; }
    let t = this.textOf(u.content).replace(/上传文件内容:[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
    if (!t) t = Array.isArray(u.content) ? '图片 / 文件消息' : '新对话';
    s.title = t.length > 30 ? t.slice(0, 30) + '…' : t;
  },
  add(role, content, meta) {
    const s = this.cur();
    const m = { id: uid(), role, content, meta: meta || null, ts: Date.now() };
    s.messages.push(m);
    s.updatedAt = Date.now(); s.model = (Api.current() || {}).model || s.model;
    this.autoTitle(s); this.later();
    return m;
  },
  touch() { const s = this.cur(); if (s) { s.updatedAt = Date.now(); this.autoTitle(s); this.later(); } },
  later: debounce(function () { Sessions.save(); }, 400),
  save() {
    let r = Store.set('sessions', Sessions.list);
    if (!r.ok) {
      const freed = r.quota ? Sessions.pruneImages() : false;
      if (freed) r = Store.set('sessions', Sessions.list);
      if (!r.ok) Toast.err('本地存储空间已满，最新消息可能未保存。请导出备份或删除旧会话。');
      else Toast.info('存储空间不足，已自动清理旧会话中的图片（文字均已保留）');
    }
    Store.set('current_session', Sessions.curId, true);
    if (typeof View !== 'undefined' && View.renderSessions) View.renderSessions();
  },
  flush() { this.later.flush(); },
  pruneImages() {
    let any = false;
    const TH = 2000;
    const order = this.list.slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    order.forEach((s) => {
      const isCur = s.id === this.curId;
      s.messages.forEach((m, idx) => {
        if (isCur && idx >= s.messages.length - 2) return;
        if (Array.isArray(m.content)) {
          m.content.forEach((p) => {
            if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string' && p.image_url.url.indexOf('data:image') === 0 && p.image_url.url.length > TH) { p.image_url.url = ''; p.image_url.pruned = true; any = true; }
          });
        } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 50000 && m.content.indexOf('](data:image') > 0) {
          m.content = m.content.replace(/!\[([^\]]*)\]\(data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=\s]{2000,}\)/g, '*[图片已清理以释放存储空间]*'); any = true;
        }
      });
    });
    return any;
  },
  /* 发送给模型的上下文：跳过失败/空回复，从 user 开始 */
  context(limit) {
    let ms = this.msgs().filter((m) => !(m.role === 'assistant' && (!m.content || (m.meta && m.meta.error))));
    ms = ms.slice(-Math.max(1, limit || 30));
    while (ms.length && ms[0].role !== 'user') ms.shift();
    return ms.map((m) => ({ role: m.role, content: m.content }));
  }
};

const SystemPrompt = {
  get() { const v = Store.get('system_prompt', ''); return v == null ? '' : String(v); },
  set(v) { Store.set('system_prompt', String(v || '')); },
  build(deep) {
    const p = this.get().trim();
    const base = p || '你是一个专业、可靠的智能助手，请用清晰、准确、简洁的方式回答用户的问题。';
    const out = deep ? base + '\n\n请在内部对问题进行充分、细致的分步推理后再作答；正文中直接给出清晰完整的最终结论，不必再书写“思考：”“回答：”之类的标签，也不要重复推理过程。' : base;
    return out + FileGen.prompt();
  }
};


/* ==========================================================================
 * 05 视图：侧栏、消息渲染、流式绘制、浮层菜单、顶部栏
 * ========================================================================== */
const View = {
  chat: null, thread: null, stage: null, stick: true, sessQuery: '',

  init() {
    this.chat = $('#chat'); this.thread = $('#thread'); this.stage = $('#stage');
    this.chat.addEventListener('scroll', () => {
      const d = this.chat.scrollHeight - this.chat.scrollTop - this.chat.clientHeight;
      this.stick = d < 90;
      $('#toBottom').hidden = this.stick || !Sessions.msgs().length;
    }, { passive: true });
    $('#toBottom').addEventListener('click', () => { this.stick = true; this.scroll(true); });

    // 消息区事件委托：复制代码 / 放大图片 / 消息操作
    this.thread.addEventListener('click', (e) => {
      const t = e.target;
      const cp = t.closest && t.closest('button[data-copy]');
      if (cp) {
        const pre = cp.closest('.code, .fcard').querySelector('pre');
        copyText(pre ? pre.textContent : '').then((ok) => {
          const sp = cp.querySelector('span'); if (!sp) return;
          sp.textContent = ok ? '已复制' : '复制失败'; setTimeout(() => { sp.textContent = '复制'; }, 1500);
        });
        return;
      }
      const dl = t.closest && t.closest('button[data-dl]');
      if (dl) {
        const pre = dl.closest('.code, .fcard').querySelector('pre');
        FileGen.save(dl.getAttribute('data-dl'), pre ? pre.textContent : '');
        const sp = dl.querySelector('span'); if (sp) { sp.textContent = '已下载'; setTimeout(() => { sp.textContent = '下载'; }, 1500); }
        return;
      }
      const dla = t.closest && t.closest('button[data-dlall]');
      if (dla) { FileGen.saveAll(dla.closest('.md') || dla.parentNode); return; }
      const fh = t.closest && t.closest('.fc-h');
      if (fh && fh.closest('.fcard')) { FileGen.toggle(fh.closest('.fcard')); return; }
      const img = t.closest && t.closest('img[data-zoom], img.att-img');
      if (img) { this.lightbox(img.src); return; }
      const act = t.closest && t.closest('[data-act]');
      if (act) { const msg = act.closest('.msg'); Chat.action(act.getAttribute('data-act'), msg ? msg.getAttribute('data-id') : null, act); }
    });

    $('#sessionSearch').addEventListener('input', debounce((e) => { this.sessQuery = e.target.value.trim().toLowerCase(); this.renderSessions(); }, 150));
    $('#sessionList').addEventListener('click', (e) => {
      const a = e.target.closest('[data-sact]');
      const row = e.target.closest('.sess');
      if (!row) return;
      const id = row.getAttribute('data-id');
      if (a) { e.stopPropagation(); Chat.sessionAction(a.getAttribute('data-sact'), id); return; }
      Chat.openSession(id);
    });
    $('#sessionList').addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('sess')) { e.preventDefault(); Chat.openSession(e.target.getAttribute('data-id')); }
    });
  },

  /* ---------- 滚动 ---------- */
  scroll(force) {
    if (!force && !this.stick) return;
    this.chat.scrollTop = this.chat.scrollHeight;
  },
  lightbox(src) {
    const lb = el('div', { class: 'lightbox', onclick: () => lb.remove() }, el('img', { src }));
    document.body.appendChild(lb);
  },

  /* ---------- 顶部栏 / 首屏 ---------- */
  updateHeader() {
    const a = Api.current();
    const ok = Api.ready();
    $('#modelLabel').textContent = a ? ((a.name && a.name !== '未命名 API' ? a.name + ' · ' : '') + (a.model || '未设置模型')) : '未配置 API';
    $('#apiDot').className = 'dot' + (ok ? ' ok' : ' warn');
    $('#heroDot').className = 'dot' + (ok ? ' ok' : ' warn');
    $('#heroStatusText').textContent = ok ? ('已连接：' + (a.name || 'API') + ' · ' + a.model) : '尚未配置 API，点击此处开始设置';
    $('#input').placeholder = $('#btnDraw').classList.contains('on') ? '描述想要生成的图片' : (Composer.agentMode ? ('描述想让 Agent 在 ' + (AgentFS.rootName || '项目') + ' 中完成的任务') : '给 ZC-GURA 发送消息');
  },
  updateEmpty() {
    const empty = Sessions.msgs().length === 0;
    this.stage.classList.toggle('empty', empty);
    if (empty) $('#toBottom').hidden = true;
  },

  /* ---------- 会话列表 ---------- */
  renderSessions() {
    const box = $('#sessionList');
    if (!box) return;
    box.textContent = '';
    let list = Sessions.sorted();
    const q = this.sessQuery;
    if (q) {
      list = list.filter((s) => (s.title || '').toLowerCase().indexOf(q) >= 0 || s.messages.some((m) => Sessions.textOf(m.content).toLowerCase().indexOf(q) >= 0));
    }
    if (!list.length) { box.appendChild(el('div', { class: 'empty-list', text: q ? '没有匹配的对话' : '暂无对话' })); return; }
    let grp = '';
    list.forEach((s) => {
      const g = timeGroup(s.updatedAt || s.createdAt);
      if (g !== grp) { grp = g; box.appendChild(el('div', { class: 'grp', text: g })); }
      const row = el('div', { class: 'sess' + (s.id === Sessions.curId ? ' active' : ''), 'data-id': s.id, role: 'button', tabindex: '0', title: s.title },
        el('span', { class: 't', text: s.title || '新对话' }),
        el('span', { class: 'acts' },
          el('button', { type: 'button', 'data-sact': 'rename', title: '重命名', 'aria-label': '重命名' }, icon('edit')),
          el('button', { type: 'button', 'data-sact': 'delete', title: '删除', 'aria-label': '删除' }, icon('trash'))));
      box.appendChild(row);
    });
  },

  /* ---------- 消息渲染 ---------- */
  renderThread() {
    this.thread.textContent = '';
    const ms = Sessions.msgs();
    ms.forEach((m, i) => { const n = this.msgNode(m, i === ms.length - 1); if (n) this.thread.appendChild(n); });
    this.updateEmpty();
    this.stick = true; this.scroll(true);
  },
  msgNode(m, isLast) {
    return m.role === 'user' ? this.userNode(m) : this.aiNode(m, isLast);
  },
  userNode(m) {
    const bubble = el('div', { class: 'bubble' });
    const c = m.content;
    if (typeof c === 'string') bubble.textContent = c;
    else if (Array.isArray(c)) {
      const texts = [];
      c.forEach((p) => {
        if (!p) return;
        if (p.type === 'image_url' && p.image_url) {
          if (p.image_url.url) bubble.appendChild(el('img', { class: 'att-img', src: p.image_url.url, alt: '图片' }));
          else bubble.appendChild(el('span', { class: 'pruned', text: '图片已清理' }));
        } else if (p.type === 'text' && p.text) {
          if (p.zcFile) bubble.appendChild(el('span', { class: 'att-file' }, icon('file', 'sm'), el('span', { text: p.zcFile.name }), el('span', { class: 'sz', text: p.zcFile.size ? fmtSize(p.zcFile.size) : '' })));
          else if (/^(上传文件内容|已上传文件)/.test(p.text)) bubble.appendChild(el('span', { class: 'att-file' }, icon('file', 'sm'), el('span', { text: '文件' })));
          else texts.push(p.text);
        }
      });
      if (texts.length) bubble.appendChild(el('div', { text: texts.join('\n\n') }));
    }
    const acts = el('div', { class: 'actions' },
      el('button', { class: 'act', type: 'button', 'data-act': 'copy', title: '复制' }, icon('copy')),
      el('button', { class: 'act', type: 'button', 'data-act': 'edit', title: '编辑并重新发送' }, icon('edit')));
    const tag = (m.meta && m.meta.agent) ? el('div', { class: 'agent-tag' }, icon('agent', 'sm'), 'Agent 任务') : null;
    return el('div', { class: 'msg user', 'data-id': m.id }, tag, bubble, acts);
  },
  aiHead(model, extra) {
    return el('div', { class: 'head' }, icon('logo'), el('span', { class: 'who', text: model || 'AI' }), extra ? el('span', { class: 'mt', text: extra }) : null);
  },
  aiNode(m, isLast) {
    const meta = m.meta || {};
    const root = el('div', { class: 'msg ai' + (meta.error ? ' err' : '') + (isLast ? ' last' : ''), 'data-id': m.id });
    let extra = '';
    if (meta.usage && meta.usage.total_tokens) extra = fmtNum(meta.usage.total_tokens) + ' tokens';
    root.appendChild(this.aiHead(meta.model, extra));
    const body = el('div', { class: 'body md' });
    if (meta.reasoning && Settings.get('showThink')) root.appendChild(this.thinkNode(meta.reasoning, false, meta.thinkSec, true));
    if (meta.agent && meta.steps && meta.steps.length) root.appendChild(Agent.renderStepsSummary(meta.steps, meta.dir));
    if (meta.error) {
      body.appendChild(el('div', { style: { whiteSpace: 'pre-wrap' }, text: m.content }));
    } else if (meta.stopped && !m.content) {
      body.appendChild(el('span', { style: { color: 'var(--text-3)' }, text: '已停止生成' }));
    } else body.innerHTML = Md.render(m.content);
    root.appendChild(body);
    root.appendChild(this.aiActions(m, isLast));
    return root;
  },
  aiActions(m, isLast) {
    const meta = m.meta || {};
    const acts = el('div', { class: 'actions' });
    if (!meta.error && m.content) acts.appendChild(el('button', { class: 'act', type: 'button', 'data-act': 'copy', title: '复制' }, icon('copy')));
    if (isLast) {
      acts.appendChild(el('button', { class: 'act', type: 'button', 'data-act': 'regen', title: meta.error ? '重试' : '重新生成' }, icon('refresh'), el('span', { text: meta.error ? '重试' : '' })));
      if (!meta.error && !meta.agent && (meta.truncated || meta.stopped) && m.content) {
        const why = meta.cut === 'length' ? '已达到输出长度上限，点击从断点处无缝续写' : (meta.cut === 'network' ? '连接中断，点击从断点处续传' : (meta.cut === 'stopped' ? '已停止生成，点击从断点处继续' : '继续生成'));
        acts.appendChild(el('button', { class: 'act', type: 'button', 'data-act': 'continue', title: why }, icon('down'), el('span', { text: '继续生成' })));
      }
      if (meta.error) acts.appendChild(el('button', { class: 'act', type: 'button', 'data-act': 'settings', title: '打开设置' }, icon('settings'), el('span', { text: '检查设置' })));
    }
    return acts;
  },
  thinkNode(text, active, sec, collapsed) {
    const box = el('div', { class: 'think' + (active ? ' active' : '') + (collapsed ? ' collapsed' : '') });
    const h = el('button', { class: 'think-h', type: 'button', 'aria-expanded': collapsed ? 'false' : 'true' }, icon('chev', 'sm'), el('span', { class: 'tl', text: active ? '正在思考…' : (sec ? '已思考 ' + sec + ' 秒' : '已思考') }));
    h.addEventListener('click', () => { const c = box.classList.toggle('collapsed'); h.setAttribute('aria-expanded', c ? 'false' : 'true'); box.setAttribute('data-user', '1'); });
    box.appendChild(h);
    box.appendChild(el('div', { class: 'think-b', text: text }));
    return box;
  },
  noteNode(text) { return el('div', { class: 'sys-note', text }); },

  /* ---------- 流式消息 ---------- */
  createStream(model) {
    const root = el('div', { class: 'msg ai last' });
    root.appendChild(this.aiHead(model, ''));
    const body = el('div', { class: 'body md' }, el('span', { class: 'typing' }, el('i'), el('i'), el('i')));
    root.appendChild(body);
    this.thread.appendChild(root);
    this.updateEmpty();
    const h = { root, body, think: null, raf: 0, last: 0, pending: null, html: '' };
    return h;
  },
  paint(h, st) {
    h.pending = st;
    if (h.raf) return;
    const run = () => {
      h.raf = 0; h.last = performance.now();
      const s = h.pending; if (!s) return;
      if (s.reasoning && Settings.get('showThink')) {
        if (!h.think) {
          h.think = this.thinkNode(s.reasoning, true, 0, false);
          h.root.insertBefore(h.think, h.body);
        }
        const tb = h.think.querySelector('.think-b');
        if (tb.textContent !== s.reasoning) { tb.textContent = s.reasoning; if (!h.think.classList.contains('collapsed')) tb.scrollTop = tb.scrollHeight; }
        h.think.classList.toggle('active', !!s.thinking);
        h.think.querySelector('.tl').textContent = s.thinking ? '正在思考…' + (s.sec ? '（' + s.sec + ' 秒）' : '') : (s.sec ? '已思考 ' + s.sec + ' 秒' : '已思考');
        if (!s.thinking && !h.think.getAttribute('data-user') && !h.autoCollapsed) { h.think.classList.add('collapsed'); h.autoCollapsed = true; }
      }
      if (s.content) {
        const html = Md.render(s.content, true);
        if (html !== h.html) { h.body.innerHTML = html; h.html = html; }
        h.body.classList.add('cursor');
      }
      this.scroll();
    };
    const wait = 60 - (performance.now() - h.last);
    if (wait <= 0) h.raf = requestAnimationFrame(run); else h.raf = setTimeout(run, wait);
  },
  finishStream(h) {
    if (h.raf) { clearTimeout(h.raf); cancelAnimationFrame(h.raf); h.raf = 0; }
    h.body.classList.remove('cursor');
  },

  /* ---------- 菜单 ---------- */
  modelMenu(anchor) {
    if (Pop.isOpenFor(anchor)) return Pop.close();
    const box = el('div');
    box.appendChild(el('div', { class: 'cap', text: '接口' }));
    if (!Api.list.length) box.appendChild(el('div', { class: 'cap', text: '还没有配置任何 API' }));
    Api.list.forEach((a, i) => {
      box.appendChild(Pop.item(null, a.name || '未命名 API', () => { Api.use(i); this.updateHeader(); Toast.info('已切换到 ' + (a.name || 'API')); }, { sub: a.model, sel: i === Api.idx }));
    });
    const cur = Api.current();
    if (cur && Api.detected.length) {
      box.appendChild(el('div', { class: 'sep' }));
      box.appendChild(el('div', { class: 'cap', text: '当前接口的模型' }));
      const sel = el('select', { 'aria-label': '选择模型' });
      const models = Api.detected.slice().sort();
      if (models.indexOf(cur.model) < 0) models.unshift(cur.model);
      models.forEach((m) => sel.appendChild(el('option', { value: m, text: m, selected: m === cur.model ? true : null })));
      sel.addEventListener('change', () => { Api.update(Api.idx, { model: sel.value }); this.updateHeader(); Pop.close(); Toast.info('模型已切换为 ' + sel.value); });
      box.appendChild(sel);
    }
    box.appendChild(el('div', { class: 'sep' }));
    box.appendChild(Pop.item('settings', '管理 API…', () => Settings2.open('api')));
    Pop.open(anchor, box);
  },
  /* 思考强度：滑动分段控件（弹性滑块 + 说明文字淡入），选择后按钮上的档位计逐格点亮 */
  DEEP_OPTS: [
    { k: 'off', t: '关闭', d: '不启用推理，响应最快，适合简单问答。' },
    { k: 'low', t: '低', d: '轻量推理，速度与质量兼顾，适合日常问题。' },
    { k: 'medium', t: '中', d: '均衡推理，多数任务的推荐档位。' },
    { k: 'high', t: '高', d: '深入推理，适合复杂分析、代码与数学。' },
    { k: 'max', t: '最高', d: '最大推理预算，回答最慢、用量也最高。' }
  ],
  deepIndex() { return Deep.on ? this.DEEP_OPTS.map((o) => o.k).indexOf(Deep.level) : 0; },
  deepMenu(anchor) {
    if (Pop.isOpenFor(anchor)) return Pop.close();
    const opts = this.DEEP_OPTS;
    let idx = this.deepIndex(), closeT = 0;
    const box = el('div', { class: 'deep-pop' });
    const val = el('span', { class: 'dp-val', text: opts[idx].t });
    box.appendChild(el('div', { class: 'dp-title' }, el('span', { text: '思考强度' }), val));
    const seg = el('div', { class: 'dseg', role: 'radiogroup', 'aria-label': '思考强度' });
    const thumb = el('i', { class: 'dthumb' });
    seg.appendChild(thumb);
    const btns = opts.map((o, i) => {
      const b = el('button', { type: 'button', class: 'dopt' + (i === idx ? ' on' : ''), role: 'radio', 'aria-checked': i === idx ? 'true' : 'false', text: o.t, onclick: () => choose(i, true) });
      seg.appendChild(b);
      return b;
    });
    box.appendChild(seg);
    const desc = el('div', { class: 'dp-desc', text: opts[idx].d });
    box.appendChild(desc);
    const place = () => { thumb.style.transform = 'translateX(' + idx * 100 + '%)'; };
    place();
    const choose = (i, autoClose) => {
      i = clamp(i, 0, opts.length - 1);
      const changed = i !== idx;
      idx = i; place();
      btns.forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-checked', k === i ? 'true' : 'false'); });
      if (changed) {
        val.textContent = opts[i].t;
        desc.textContent = opts[i].d; desc.classList.remove('swap'); void desc.offsetWidth; desc.classList.add('swap');
        if (i === 0) Deep.set(false); else Deep.set(true, opts[i].k);
        this.updateDeep(true);
      }
      clearTimeout(closeT);
      if (autoClose) closeT = setTimeout(() => { if (Pop.node === box) Pop.close(); }, changed ? 460 : 180);
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); choose(idx + 1); btns[idx].focus(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); choose(idx - 1); btns[idx].focus(); }
    });
    Pop.open(anchor, box, { up: true });
    btns[idx].focus({ preventScroll: true });
  },
  updateDeep(animate) {
    const b = $('#btnDeep');
    const lv = Deep.on ? this.deepIndex() : 0;
    const prev = +(b.getAttribute('data-lv') || 0);
    b.classList.toggle('on', Deep.on);
    b.setAttribute('data-lv', String(lv));
    $$('#deepMeter rect').forEach((r, i) => r.classList.toggle('on', i < lv));
    if (animate && prev !== lv) { b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
    const text = Deep.on ? '思考 · ' + Format.LEVELS[Deep.level].text : '深度思考';
    const wrap = $('#deepLabelWrap');
    // 若上一次切换动画还没结束，先直接落定，避免连续点击时丢失文字
    wrap.querySelectorAll('.lblout').forEach((n) => n.remove());
    wrap.querySelectorAll('.in').forEach((n) => { n.className = 'lblcur'; n.id = 'deepLabel'; });
    const cur = wrap.querySelector('.lblcur');
    if (!cur) return;
    if (cur.textContent === text) { wrap.style.width = ''; return; }
    if (!animate) { cur.textContent = text; wrap.style.width = ''; return; }
    // 文字上下滑动切换，宽度平滑过渡
    const goingUp = lv >= prev;
    wrap.style.width = cur.offsetWidth + 'px';
    const next = el('span', { class: 'in' + (goingUp ? '' : ' from-top'), text });
    wrap.appendChild(next);
    const w = next.offsetWidth;
    cur.className = 'lblout'; cur.removeAttribute('id');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wrap.style.width = w + 'px';
      next.classList.add('go');
      cur.classList.add(goingUp ? 'go-up' : 'go-down');
    }));
    setTimeout(() => {
      if (!next.isConnected || next.className.indexOf('in') < 0) return;
      cur.remove(); next.className = 'lblcur'; next.id = 'deepLabel'; wrap.style.width = '';
    }, 340);
  },
  attachMenu(anchor) {
    if (Pop.isOpenFor(anchor)) return Pop.close();
    const box = el('div');
    box.appendChild(Pop.item('image', '添加图片', () => $('#fileImg').click()));
    box.appendChild(Pop.item('file', '添加文件（文本 / 代码）', () => $('#fileDoc').click()));
    Pop.open(anchor, box, { up: true });
  },
  moreMenu(anchor) {
    if (Pop.isOpenFor(anchor)) return Pop.close();
    const box = el('div');
    box.appendChild(Pop.item('download', '导出当前对话', () => Chat.exportCurrent()));
    box.appendChild(Pop.item('trash', '清空当前对话', () => Chat.clearCurrent()));
    box.appendChild(el('div', { class: 'sep' }));
    box.appendChild(Pop.item('settings', '设置', () => Settings2.open('api')));
    Pop.open(anchor, box, { alignRight: true });
  }
};

/* ---------- 输入区 ---------- */
const Composer = {
  images: [], files: [], drawMode: false, agentMode: false,
  init() {
    const ta = $('#input');
    ta.addEventListener('input', () => { this.autosize(); this.refresh(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (Chat.busy) Toast.info('正在生成中，可点击右侧按钮停止'); else Chat.send(); }
    });
    ta.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const imgs = [];
      for (let i = 0; i < items.length; i++) if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) imgs.push(items[i].getAsFile());
      if (imgs.length) { e.preventDefault(); imgs.forEach((f) => this.addFile(f)); }
    });
    $('#btnSend').addEventListener('click', () => Chat.sendOrStop());
    $('#btnAttach').addEventListener('click', (e) => View.attachMenu(e.currentTarget));
    $('#btnDeep').addEventListener('click', (e) => View.deepMenu(e.currentTarget));
    $('#btnDraw').addEventListener('click', () => this.toggleDraw());
    $('#fileImg').addEventListener('change', (e) => { Array.prototype.forEach.call(e.target.files, (f) => this.addFile(f)); e.target.value = ''; });
    $('#fileDoc').addEventListener('change', (e) => { Array.prototype.forEach.call(e.target.files, (f) => this.addFile(f)); e.target.value = ''; });

    // 拖拽上传
    let depth = 0;
    const ov = el('div', { class: 'drop', hidden: true }, el('div', { text: '松开以添加图片或文件' }));
    document.body.appendChild(ov);
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; ov.hidden = false; } });
    document.addEventListener('dragleave', (e) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) ov.hidden = true; } });
    document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; ov.hidden = true;
      Array.prototype.forEach.call(e.dataTransfer.files, (f) => this.addFile(f));
    });
    this.autosize(); this.refresh();
  },
  autosize() { const ta = $('#input'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; },
  value() { return $('#input').value; },
  setValue(v) { const ta = $('#input'); ta.value = v; this.autosize(); this.refresh(); ta.focus(); },
  focus() { $('#input').focus(); },
  refresh() {
    const has = $('#input').value.trim() || this.images.length || this.files.length;
    const btn = $('#btnSend');
    if (Chat.busy) { btn.disabled = false; btn.title = '停止生成'; $('#sendIcon').firstElementChild.setAttribute('href', '#i-stop'); }
    else { btn.disabled = !has; btn.title = '发送'; $('#sendIcon').firstElementChild.setAttribute('href', '#i-up'); }
  },
  toggleDraw(on) {
    this.drawMode = on == null ? !this.drawMode : !!on;
    $('#btnDraw').classList.toggle('on', this.drawMode);
    if (this.drawMode && this.agentMode) Agent.exitMode();
    View.updateHeader();
    if (this.drawMode && !Draw.ready()) Toast.info('请先在 设置 → 图像生成 中配置画图 API');
  },
  clear() { this.images = []; this.files = []; $('#input').value = ''; this.autosize(); this.renderChips(); this.refresh(); },
  renderChips() {
    const box = $('#chips'); box.textContent = '';
    this.images.forEach((im, i) => box.appendChild(el('div', { class: 'chip-att' }, el('img', { src: im.dataUrl, alt: '' }), el('span', { class: 'nm', text: im.name }), el('button', { class: 'rm', type: 'button', 'aria-label': '移除', onclick: () => { this.images.splice(i, 1); this.renderChips(); this.refresh(); } }, icon('x', 'sm')))));
    this.files.forEach((f, i) => box.appendChild(el('div', { class: 'chip-att' }, icon('file'), el('span', { class: 'nm', text: f.name }), el('span', { class: 'sz', text: fmtSize(f.size) }), el('button', { class: 'rm', type: 'button', 'aria-label': '移除', onclick: () => { this.files.splice(i, 1); this.renderChips(); this.refresh(); } }, icon('x', 'sm')))));
  },
  TEXT_EXT: /\.(txt|md|markdown|json|jsonl|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|kt|scala|dart|lua|r|sh|bash|zsh|ps1|bat|sql|log|ini|cfg|conf|env|yaml|yml|toml|csv|tsv|tex|srt|diff|patch|gradle|properties|dockerfile|makefile)$/i,
  async addFile(file) {
    if (!file) return;
    if (file.type.indexOf('image/') === 0) {
      if (this.images.length >= 6) return Toast.err('单条消息最多附加 6 张图片');
      if (file.size > 20 * 1024 * 1024) return Toast.err('图片过大（超过 20MB）：' + file.name);
      try {
        const dataUrl = await this.readImage(file);
        this.images.push({ name: file.name || '粘贴的图片', dataUrl, size: file.size });
        this.renderChips(); this.refresh();
      } catch (e) { Toast.err('图片读取失败：' + file.name); }
      return;
    }
    if (this.files.length >= 4) return Toast.err('单条消息最多附加 4 个文件');
    if (file.size > 20 * 1024 * 1024) return Toast.err('文件过大（超过 20MB）：' + file.name);
    try {
      const buf = await file.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let binary = false;
      if (!this.TEXT_EXT.test(file.name) && file.type.indexOf('text/') !== 0) {
        for (let i = 0; i < Math.min(u8.length, 4096); i++) if (u8[i] === 0) { binary = true; break; }
      }
      if (binary) {
        this.files.push({ name: file.name, size: file.size, type: file.type || 'application/octet-stream', text: null });
        Toast.info('该格式暂不支持解析，仅会把文件名告知模型：' + file.name);
      } else {
        let text = new TextDecoder('utf-8').decode(u8);
        let truncated = false;
        if (text.length > 300000) { text = text.slice(0, 300000); truncated = true; }
        this.files.push({ name: file.name, size: file.size, type: file.type || 'text/plain', text, truncated });
        if (truncated) Toast.info('文件较大，已截取前 30 万字符：' + file.name);
      }
      this.renderChips(); this.refresh();
    } catch (e) { Toast.err('文件读取失败：' + file.name); }
  },
  readImage(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => {
        const url = fr.result;
        if (file.type === 'image/gif' || file.type === 'image/svg+xml' || (file.size < 1.2 * 1024 * 1024)) {
          // 小图直接使用；仍需限制像素过大的情况
          const im0 = new Image();
          im0.onload = () => { if (Math.max(im0.width, im0.height) <= 2600) resolve(url); else this._shrink(im0, resolve, file.type); };
          im0.onerror = () => resolve(url);
          im0.src = url; return;
        }
        const im = new Image();
        im.onload = () => this._shrink(im, resolve, file.type);
        im.onerror = () => resolve(url);
        im.src = url;
      };
      fr.readAsDataURL(file);
    });
  },
  _shrink(im, resolve, type) {
    const max = 2048; let w = im.width, h = im.height;
    const k = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    if (type !== 'image/png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(im, 0, 0, w, h);
    resolve(type === 'image/png' && w * h < 1500000 ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.86));
  }
};


/* ==========================================================================
 * 06 对话核心：发送 / 流式接收 / 重试 / 续写 / 重新生成 / 编辑 / 会话操作 / 图片生成
 * ========================================================================== */
const FENCE4 = '\x60\x60\x60\x60';

function mergeUsage(a, b) {
  if (!b) return a;
  if (!a) return Object.assign({}, b);
  const p = Math.max(a.prompt_tokens || 0, b.prompt_tokens || 0), c = Math.max(a.completion_tokens || 0, b.completion_tokens || 0);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: Math.max(a.total_tokens || 0, b.total_tokens || 0, p + c) };
}

/* 有原生思考内容时，去掉正文里回声式的“思考：…回答：”前缀 */
function stripEchoedThinking(text, hasNative) {
  if (!hasNative || !text) return text;
  const m = /^\s*(?:[#*\s]*)(?:思考|推理)\s*[:：][\s\S]*?\n\s*\n\s*(?:[#*\s]*)(?:最终)?(?:回答|结论|答案)\s*[:：]\s*/.exec(text);
  return m && m[0].length < text.length ? text.slice(m[0].length) : text;
}

function httpError(status, text) {
  const e = new Error('HTTP ' + status);
  e.status = status; e.detail = extractErrorText(text);
  return e;
}

/* ==========================================================================
 * 续写引擎 Continuer（重写）
 *  参考三家官方做法：
 *   · Claude —— 触达长度上限只是“暂停”，回复 Continue 即从断点接着写；API 层官方做法是 assistant 预填（prefill）。
 *     Claude 4.6+ 已不再支持预填（返回 400），此时自动降级并记住。
 *   · DeepSeek —— Chat Prefix Completion（Beta）：末尾 assistant 消息加 prefix:true 并走 /beta 端点，模型直接从前缀往下写。
 *   · Codex —— 会话游标式断点续传：已生成的内容永不丢弃，只在游标（当前末尾）之后追加。
 *  实现：能原生续写的接口走 prefix；其余（OpenAI 兼容 / Gemini / Ollama / Claude 4.6+）走 prompt ——
 *  回退到最近的完整句/行 + 锚点指令。两种方式最终都会对接缝去重（前言 / 尾部重叠 / 整段复述）。
 * ========================================================================== */
const FENCE3 = '\x60\x60\x60';
const Continuer = {
  WIN: 600,
  CUE: /^\s*(?:继续|接着|继续写|接着写|继续生成|续写|继续说|go on|continue|keep going)\s*[。.!！…]*\s*$/i,
  PRE: /^\s*(?:(?:好的|好|当然|没问题|明白了?|收到|以下是|下面是|接下来|接着|继续|Sure|Certainly|Of course|Okay|OK|Continuing|Continue|Here(?:'s| is)|Resuming)[^\n]{0,50}?(?:继续|接着|接上|上文|中断|截断|断点|剩余|余下|continu|resum|left off|remaining|rest of)[^\n]{0,40}|(?:继续|接着|Continuing|Continue)[^\n]{0,20}[：:])\s*\n+/i,

  /* 用户直接输入“继续 / continue”时，等同于点击“继续生成”（与 Claude 官网的用法一致） */
  isCue(t) { return this.CUE.test(String(t || '')); },

  /* 选择续写方式：prefix = 接口原生续写；prompt = 指令续写 */
  pick(api, fmt, flags) {
    if (flags && flags.noPrefix) return 'prompt';
    if (fmt === 'anthropic') return 'prefix';
    if (fmt === 'openai' && /^https?:\/\/api\.deepseek\.com(?:[\/:?#]|$)/i.test(String(api.url || '').trim())) return 'prefix';
    return 'prompt';
  },

  /* 把已生成内容拆成：base（发给模型）/ glue（base 与后续之间的空白）/ frag（回退掉、待重写的残句） */
  seed(orig, mode) {
    const s = String(orig || '');
    const body = s.replace(/\s+$/, '');
    let cut = body.length;
    if (mode === 'prompt') { const c = this.boundary(s, body); if (c > 0 && c < body.length) cut = c; }
    const head = body.slice(0, cut), base = head.replace(/\s+$/, '');
    return { orig: s, base, glue: head.slice(base.length) || (cut === body.length ? s.slice(body.length) : ''), frag: body.slice(cut) };
  },

  /* 指令续写时，先回退到最近的完整行 / 句，避免把词从中间切开 */
  boundary(s, body) {
    if (body.length < 160 || /\n[ \t]*$/.test(s)) return body.length;
    const nl = body.lastIndexOf('\n'), line = body.slice(nl + 1);
    if (/[。！？!?…；;：:.)）\]】」』”"'\x60]$/.test(line)) return body.length;
    if (line.length <= 240 && nl >= 0) return nl + 1;
    const re = /[。！？!?；;]+[”」』）)"']*\s*|\.\s+/g;
    let m, end = 0;
    while ((m = re.exec(line))) end = m.index + m[0].length;
    return end > 0 && end < line.length ? nl + 1 + end : body.length;
  },

  prompt(sd) {
    const open = (sd.base.match(/^[ \t]*\x60\x60\x60/gm) || []).length % 2 === 1;
    const at = sd.frag
      ? '被截断处的最后一段（可能不完整）是：\n<<<\n' + sd.frag + '\n>>>\n请从这一段的开头重新写起，把它补全，然后继续写完剩余内容。'
      : '被截断处的结尾是：\n<<<\n' + sd.base.slice(-80) + '\n>>>\n请紧接着这个位置继续往下写。';
    return '你上一条回复因长度或连接限制被截断了。' + at + '\n要求：不要重复这一段之前已经输出过的内容；保持原有的语言、格式与 Markdown 结构' +
      (open ? '（当前位于代码块内，请直接接着写代码，不要重新输出开头的 ' + FENCE3 + ' 标记）' : '') +
      '；不要道歉、不要回顾或总结前文，也不要加“好的”“继续”之类的说明，直接输出正文。';
  },

  /* 生成本次续写的完整消息序列 */
  plan(cont, ctx, sys, api, fmt, flags, force) {
    const mode = force || this.pick(api, fmt, flags);
    const sd = this.seed(cont.content, mode);
    const list = ctx.slice(), last = list[list.length - 1];
    if (last && last.role === 'assistant' && last.content === cont.content) list.pop();
    const messages = [sys].concat(list);
    if (sd.base) messages.push({ role: 'assistant', content: sd.base });
    if (mode === 'prompt') messages.push({ role: 'user', content: this.prompt(sd) });
    return { mode, seed: sd, messages };
  },

  /* 原生续写需要对请求体做的补充（DeepSeek：prefix:true + /beta 端点） */
  patch(req, plan) {
    if (plan.mode !== 'prefix' || req.format !== 'openai') return req;
    const ms = req.body && req.body.messages, last = ms && ms[ms.length - 1];
    if (!last || last.role !== 'assistant') return req;
    last.prefix = true;
    req.url = String(req.url).replace(/^(https?:\/\/api\.deepseek\.com)(?:\/(?:v1|beta))?(\/chat\/completions)/i, '$1/beta$2');
    return req;
  },

  /* 服务端不接受原生续写（如 Claude 4.6+ 的 assistant 预填）→ 降级为指令续写，并记住 */
  adapt(status, plan, flags) {
    if (!plan || plan.mode !== 'prefix' || [400, 404, 405, 415, 422].indexOf(status) < 0) return false;
    flags.noPrefix = true;
    return true;
  },

  /* 接缝：返回 { cut } 需丢弃的开头字符数，或 { all, from }（模型把全文重写了一遍） */
  cut(a, sd) {
    let n = 0;
    const pm = this.PRE.exec(a);
    if (pm) n = pm[0].length;
    const s = a.slice(n), b = sd.base;
    if (b.length >= 40) {
      const t = s.replace(/^\s+/, ''), lead = s.length - t.length;
      if (t.length >= 40 && t.slice(0, 40) === b.slice(0, 40)) {
        let i = 0;
        while (i < t.length && i < b.length && t.charCodeAt(i) === b.charCodeAt(i)) i++;
        return i >= b.length ? { cut: n + lead + i } : { all: true, from: n + lead };
      }
    }
    const tail = b.slice(-this.WIN), max = Math.min(tail.length, s.length);
    for (let k = max; k >= 4; k--) {
      const o = s.slice(0, k);
      if (k < 8 && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(o)) break;
      if (tail.endsWith(o)) return { cut: n + k };
    }
    return { cut: n };
  },
  glue(plan, add) {
    const sd = plan.seed;
    if (/^\s/.test(add)) return '';
    if (sd.glue) return sd.glue;
    return plan.mode === 'prompt' && /[.!?;,:]$/.test(sd.base) && /^[A-Za-z0-9]/.test(add) ? ' ' : '';
  },

  /* 把模型本次输出接到已有内容之后（流式重绘与最终落盘共用；memo 只用来缓存接缝位置） */
  join(plan, raw, memo) {
    const sd = plan.seed;
    if (!raw || !raw.trim()) return sd.orig;
    let r = memo && memo.r;
    if (!r) { r = this.cut(raw, sd); if (memo && raw.length >= this.WIN + 100) memo.r = r; }
    if (r.all) { const full = raw.slice(r.from); return full.length >= sd.base.length ? full : sd.orig; }
    const add = raw.slice(r.cut);
    if (!add.trim()) return sd.orig;
    // 指令续写回退过残句：若模型没有从残句开头重写、而是直接接在它后面，就保留残句
    if (sd.frag && !this.rewrote(sd, add)) return sd.base + sd.glue + sd.frag + add;
    return sd.base + this.glue(plan, add) + add;
  },
  rewrote(sd, add) {
    const strip = (x) => x.replace(/^[\s>*+#\-]*(?:\d+[.)]\s*)?/, '');
    const a = strip(add), p = strip(sd.frag).slice(0, 3);
    return !a || !p || a.indexOf(p) === 0 || p.indexOf(a) === 0;
  },

  usage(a, b) {
    if (!a || !b) return b || a || null;
    return { prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0), completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0), total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0) };
  }
};

const Chat = {
  busy: false, ctrl: null,

  setBusy(b) {
    this.busy = b;
    Composer.refresh();
    $('#btnSend').classList.toggle('busy', b);
  },
  stop() { if (this.ctrl) this.ctrl.abort(); },
  sendOrStop() { if (this.busy) this.stop(); else this.send(); },

  /* ---------- 发送 ---------- */
  buildContent(text, images, files) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    images.forEach((im) => parts.push({ type: 'image_url', image_url: { url: im.dataUrl, detail: 'auto' } }));
    files.forEach((f) => {
      if (f.text != null) {
        parts.push({ type: 'text', text: '【文件：' + f.name + '】\n' + FENCE4 + '\n' + f.text + '\n' + FENCE4 + (f.truncated ? '\n（文件较大，内容已截断）' : ''), zcFile: { name: f.name, size: f.size } });
      } else {
        parts.push({ type: 'text', text: '已上传文件：' + f.name + '（' + fmtSize(f.size) + '，类型：' + f.type + '）\n无法直接读取该文件内容，请根据文件名和类型提供帮助。', zcFile: { name: f.name, size: f.size } });
      }
    });
    if (parts.length === 1 && parts[0].type === 'text' && !parts[0].zcFile) return parts[0].text;
    return parts;
  },
  async send() {
    if (this.busy) return;
    const text = Composer.value().trim();
    const imgs = Composer.images.slice(), files = Composer.files.slice();
    if (!text && !imgs.length && !files.length) return;

    const dm = /^\s*[\/／](?:画图|绘图|draw|image)\s+([\s\S]+)$/i.exec(text);
    if (dm || Composer.drawMode) {
      const prompt = (dm ? dm[1] : text).trim();
      if (!prompt) return;
      if (!Draw.ready()) { Toast.err('请先配置画图 API'); Settings2.open('draw'); return; }
      Composer.clear();
      return Draw.generate(prompt);
    }
    if (Composer.agentMode) {
      if (!text) return;
      if (!Api.ready()) { Toast.err('请先配置 API 地址和模型'); Settings2.open('api'); return; }
      if (!AgentFS.root) { Toast.err('请先选择一个项目目录'); Agent.openPanel(); return; }
      Composer.clear();
      return Agent.send(text);
    }
    if (!Api.ready()) { Toast.err('请先配置 API 地址和模型'); Settings2.open('api'); return; }

    // 上一条回复被截断时，直接输入“继续 / continue”等同于点击“继续生成”：在原消息后无缝续写，不新增一轮对话
    if (!imgs.length && !files.length && Continuer.isCue(text)) {
      const ms = Sessions.msgs(), last = ms[ms.length - 1], lm = last && last.meta;
      if (last && last.role === 'assistant' && last.content && lm && !lm.error && !lm.agent && (lm.truncated || lm.stopped)) {
        Composer.clear();
        return this.run({ cont: last });
      }
    }

    const content = this.buildContent(text, imgs, files);
    Composer.clear();
    const msg = Sessions.add('user', content);
    View.thread.appendChild(View.userNode(msg));
    View.updateEmpty(); View.stick = true; View.scroll(true);
    await this.run();
  },

  /* ---------- 生成 ---------- */
  async run(opts) {
    opts = opts || {};
    const api = Api.current();
    const fmt = Format.of(api);
    const cont = opts.cont || null;
    const deep = Deep.on && !cont;   // 续写不再重新深度思考：Claude 的预填与思考互斥，也避免预算再次被思考耗尽
    const memo = {};
    this.setBusy(true);
    this.refreshActions();
    const h = View.createStream(api.model);
    if (cont) { const old = View.thread.querySelector('[data-id="' + cont.id + '"]'); if (old) old.style.display = 'none'; }
    View.stick = true; View.scroll(true);
    const ctrl = new AbortController();
    this.ctrl = ctrl;

    const flags = Quirks.get(api);
    const flags0 = JSON.stringify(flags);
    const st = { deep, stage: 0 };
    const sys = { role: 'system', content: SystemPrompt.build(deep) };
    const ctx = Sessions.context(Settings.get('ctx'));
    let cplan = cont ? Continuer.plan(cont, ctx, sys, api, fmt, flags) : null;
    let messages = cplan ? cplan.messages : [sys].concat(ctx);
    const temperature = deep ? Math.min(Settings.get('temp'), 0.5) : Settings.get('temp');
    let maxTokens = Settings.get('maxTokens') || 0;
    if (deep) maxTokens = Math.max(maxTokens, Deep.maxTokens()); else if (!maxTokens) maxTokens = 8192;

    const S = { content: '', reasoning: '', usage: null, finish: null, ended: false, thinkStart: 0, thinkEnd: 0, error: '', aborted: false, idle: false, interrupted: false };
    let route = '', error = null, triedNonStream = false, forceNonStream = false;

    const repaint = () => {
      const sp = splitThink(S.content);
      const reasoning = ((S.reasoning || '') + (sp.reasoning ? (S.reasoning ? '\n' : '') + sp.reasoning : '')).trim();
      const content = cplan ? Continuer.join(cplan, sp.content, memo) : sp.content;
      const thinking = !!reasoning && (sp.open || !sp.content.trim());
      const end = S.thinkEnd || (thinking ? Date.now() : 0) || Date.now();
      View.paint(h, { reasoning, content, thinking, sec: S.thinkStart ? Math.round((end - S.thinkStart) / 1000) : 0 });
    };

    try {
      for (let round = 0; round < 8; round++) {
        const wantStream = Settings.get('stream') && !flags.noStream && !forceNonStream;
        const req = Format.request(api, { messages, stream: wantStream, temperature, maxTokens, extra: deep ? Format.reasoning(fmt, Deep.level, st.stage) : null, flags });
        if (cplan) Continuer.patch(req, cplan);
        const resp = await Net.call(req.url, {
          method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal,
          timeoutMs: Settings.get('timeout') * 1000, retries: 2, route: api.route,
          onRetry: (n, why, wait) => Toast.info('连接不稳定，' + Math.max(1, Math.round(wait / 1000)) + ' 秒后自动重试（第 ' + n + ' 次）')
        });
        route = resp.zcRoute || '';
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          if (Quirks.adapt(resp.status, t, flags, st)) continue;
          if (cplan && Continuer.adapt(resp.status, cplan, flags)) { cplan = Continuer.plan(cont, ctx, sys, api, fmt, flags, 'prompt'); messages = cplan.messages; memo.r = null; continue; }
          throw httpError(resp.status, t);
        }
        S.content = ''; S.reasoning = ''; S.finish = null; S.ended = false; S.error = ''; S.thinkStart = 0; S.thinkEnd = 0; S.interrupted = false; S.idle = false;
        await this.consume(resp, fmt, S, repaint, ctrl, wantStream, deep ? 180000 : 90000);
        if (ctrl.signal.aborted) S.aborted = true;
        if (S.error && !S.content && !S.reasoning) {
          if (Quirks.adapt(400, S.error, flags, st)) continue;
          if (cplan && Continuer.adapt(400, cplan, flags)) { cplan = Continuer.plan(cont, ctx, sys, api, fmt, flags, 'prompt'); messages = cplan.messages; memo.r = null; continue; }
          throw httpError(400, S.error);
        }
        if (!S.content.trim() && !S.reasoning && !S.aborted && wantStream && !triedNonStream) { triedNonStream = true; forceNonStream = true; continue; }
        break;
      }
      if (JSON.stringify(flags) !== flags0) Quirks.save(api, flags);
    } catch (e) {
      error = e;
    }

    View.finishStream(h);
    const aborted = ctrl.signal.aborted || (error && error.kind === 'abort');
    const sp = splitThink(S.content);
    const reasoning = ((S.reasoning || '') + (sp.reasoning ? (S.reasoning ? '\n' : '') + sp.reasoning : '')).trim();
    let text = sp.content;
    if (reasoning && text) text = stripEchoedThinking(text, true);
    const model = api.model;
    let newMsg = null, target = cont;

    try {
      if (error && !aborted && !text) {
        const msg = this.errorText(error, api);
        h.root.remove();
        if (cont) { Toast.err(msg.split('\n')[0]); }
        else newMsg = Sessions.add('assistant', msg, { error: true, model });
      } else {
        const complete = S.ended || !!S.finish;
        let truncated = Format.isLength(fmt, S.finish) || (!aborted && !error && !complete && !!text) || (!!error && !aborted && !!text);
        let out = text;
        if (!out && reasoning && !aborted && !cont) {
          out = '模型把输出预算全部用在了思考上，没有生成最终回答。可以在 设置 → 对话 中调大“最大输出 Token”，或降低深度思考强度后重新生成。';
        }
        const meta = { model, ts: Date.now(), route };
        if (reasoning) { meta.reasoning = reasoning.slice(0, 30000); if (S.thinkStart) meta.thinkSec = Math.round(((S.thinkEnd || Date.now()) - S.thinkStart) / 1000); }
        if (S.usage) meta.usage = S.usage;
        const why = aborted ? 'stopped' : (Format.isLength(fmt, S.finish) ? 'length' : 'network');
        if (truncated) meta.truncated = true;
        if (aborted) meta.stopped = true;
        if (truncated || aborted) meta.cut = why;
        if (cont) {
          // 续写：在断点（游标）之后追加，接缝去重；已生成的内容永不缩水
          const before = cont.content || '';
          const merged = out.trim() ? Continuer.join(cplan, out, {}) : before;
          const grew = merged.length > before.length;
          if (grew) cont.content = merged;
          if (!grew && !aborted && !error) {
            if (Format.isLength(fmt, S.finish)) Toast.err('本次续写没有产出新的正文（输出预算已用完），可在 设置 → 对话 中调大“最大输出 Token”后重试');
            else { truncated = false; Toast.info('模型认为内容已经完整，没有更多可续写的内容'); }
          }
          const om = cont.meta || {}, nm = Object.assign({}, om, { route });
          nm.truncated = truncated || undefined; nm.stopped = aborted || undefined; nm.cut = (truncated || aborted) ? why : undefined;
          const uu = Continuer.usage(om.usage, meta.usage); if (uu) nm.usage = uu;
          if (reasoning) { nm.reasoning = ((om.reasoning ? om.reasoning + '\n\n' : '') + reasoning).slice(0, 30000); nm.thinkSec = (om.thinkSec || 0) + (meta.thinkSec || 0); }
          if (!truncated && !aborted) { delete nm.truncated; delete nm.stopped; delete nm.cut; }
          cont.meta = nm;
          Sessions.touch(); newMsg = cont;
          h.root.remove();
        } else if (out || aborted) {
          newMsg = Sessions.add('assistant', out, meta);
        } else {
          h.root.remove();
          newMsg = Sessions.add('assistant', '服务器没有返回任何有效内容。请检查模型名称“' + model + '”是否被当前接口支持，或在 设置 → 模型与 API 中点击“测试连接”。', { error: true, model });
        }
        if (aborted && !out) Toast.info('已停止生成');
        if (error && !aborted && out) Toast.err('连接中断，已保留已生成的内容，可点击“继续生成”');
        // 用量
        const u = S.usage || { prompt_tokens: messages.reduce((n, m) => n + Token.estimate(Sessions.textOf(m.content)), 0), completion_tokens: Token.estimate(out) };
        Token.add(u, model);
      }
    } catch (e) { console.error(e); }

    if (newMsg) {
      const node = View.aiNode(newMsg, true);
      if (cont) { const old = View.thread.querySelector('.msg[data-id="' + cont.id + '"]'); if (old) old.replaceWith(node); else View.thread.appendChild(node); }
      else if (h.root.parentNode) h.root.replaceWith(node);
      else View.thread.appendChild(node);
    } else if (cont) {
      const old = View.thread.querySelector('.msg[data-id="' + cont.id + '"]');
      if (old) old.style.display = '';
    }
    this.ctrl = null;
    this.setBusy(false);
    this.refreshActions();
    Sessions.later.flush();
    View.renderSessions();
    View.scroll();
    Composer.focus();
  },

  /* 读取响应：流式 SSE / NDJSON，或一次性 JSON */
  async consume(resp, fmt, S, repaint, ctrl, wantStream, idleMs) {
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const isStream = ct.indexOf('event-stream') >= 0 || ct.indexOf('ndjson') >= 0;
    if (isStream && resp.body) {
      const reader = resp.body.getReader(), dec = new TextDecoder();
      let buf = '', timer = null;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { S.idle = true; try { reader.cancel(); } catch (e) { /* ignore */ } }, idleMs); };
      arm();
      try {
        for (;;) {
          let r;
          try { r = await reader.read(); } catch (e) { if (ctrl.signal.aborted) S.aborted = true; else S.interrupted = true; break; }
          if (r.done) break;
          arm();
          buf += dec.decode(r.value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { this.feed(buf.slice(0, i), fmt, S); buf = buf.slice(i + 1); }
          repaint();
        }
        buf += dec.decode();
        if (buf.trim()) this.feed(buf, fmt, S);
      } finally { clearTimeout(timer); }
      if (S.idle && !S.content) S.error = '连接长时间无响应，已自动停止等待（可能是模型思考过久或上游中断）。';
      if (!S.ended && !S.finish && !S.aborted && (S.content || S.reasoning)) S.interrupted = true;
      repaint();
      return;
    }
    // 非流式 JSON（或忽略了 stream 参数的网关）
    const raw = await resp.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { /* 可能是 NDJSON / SSE 文本 */ }
    if (json) {
      const err = Format.streamError(json);
      const c = Format.content(fmt, json);
      if (err && !c) { S.error = err; return; }
      S.content = c; S.reasoning = Format.reasoningContent(fmt, json);
      S.usage = Format.usage(fmt, json); S.finish = Format.finishReason(fmt, json) || 'stop'; S.ended = true;
      if (!c && !S.reasoning) S.error = '服务器返回：' + raw.slice(0, 400);
    } else if (/^\s*(data:|\{)/.test(raw)) {
      raw.split('\n').forEach((l) => this.feed(l, fmt, S));
      S.ended = S.ended || !!S.finish;
    } else {
      S.error = extractErrorText(raw) || '服务器返回了无法识别的内容';
    }
    repaint();
  },
  feed(line, fmt, S) {
    line = line.trim();
    if (!line || line.charAt(0) === ':' || /^(event|id|retry):/.test(line)) return;
    if (line.indexOf('data:') === 0) line = line.slice(5).trim();
    if (line === '[DONE]') { S.ended = true; return; }
    const c = line.charAt(0);
    if (c !== '{' && c !== '[') return;
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    if (Array.isArray(j)) { j.forEach((x) => this.applyJson(x, fmt, S)); return; }
    this.applyJson(j, fmt, S);
  },
  applyJson(j, fmt, S) {
    const err = Format.streamError(j);
    if (err) { if (!S.content && !S.reasoning) S.error = err; return; }
    const u = Format.streamUsage(fmt, j); if (u) S.usage = mergeUsage(S.usage, u);
    const fr = Format.streamFinish(fmt, j); if (fr) S.finish = fr;
    if (Format.streamEnded(fmt, j)) S.ended = true;
    const rd = Format.reasoningDelta(fmt, j);
    if (rd && typeof rd === 'string') { if (!S.thinkStart) S.thinkStart = Date.now(); S.reasoning += rd; }
    const d = Format.delta(fmt, j);
    if (d && typeof d === 'string') { if (S.thinkStart && !S.thinkEnd && d.trim()) S.thinkEnd = Date.now(); S.content += d; }
  },

  errorText(e, api) {
    const where = '\n\n当前接口：' + (api.name || '未命名') + ' · ' + api.model;
    if (e.status) {
      const f = Net.friendly(e.status);
      return '请求失败（HTTP ' + e.status + '）' + (f ? '：' + f : '') + (e.detail ? '\n服务端返回：' + e.detail : '') + where;
    }
    return Net.explain(e, api.url) + where;
  },

  /* ---------- 消息操作 ---------- */
  findMsg(id) { return Sessions.msgs().filter((m) => m.id === id)[0] || null; },
  userText(m) {
    if (typeof m.content === 'string') return m.content;
    return (m.content || []).filter((p) => p && p.type === 'text' && p.text && !p.zcFile && !/^(上传文件内容|已上传文件)/.test(p.text)).map((p) => p.text).join('\n\n');
  },
  async action(act, id, btn) {
    const m = id ? this.findMsg(id) : null;
    if (act === 'settings') return Settings2.open('api');
    if (!m) return;
    if (act === 'copy') {
      const ok = await copyText(m.role === 'user' ? this.userText(m) : m.content);
      const use = btn.querySelector('use');
      if (use) { const old = use.getAttribute('href'); use.setAttribute('href', ok ? '#i-check' : '#i-x'); btn.classList.toggle('ok', ok); setTimeout(() => { use.setAttribute('href', old); btn.classList.remove('ok'); }, 1300); }
      return;
    }
    if (this.busy) return Toast.info('请先等待当前回复完成，或点击停止');
    if (act === 'regen') {
      const ms = Sessions.msgs();
      if (ms[ms.length - 1] !== m || m.role !== 'assistant') return;
      if (m.meta && m.meta.agent) {
        const idx = ms.indexOf(m), prevUser = idx > 0 ? ms[idx - 1] : null;
        const taskText = prevUser && prevUser.role === 'user' ? this.userText(prevUser) : '';
        if (!taskText) return;
        if (!AgentFS.root) return Toast.err('请先在 Agent 模式中选择项目目录');
        if (!Composer.agentMode) { Composer.agentMode = true; $('#btnAgent').classList.add('agent-on'); $('#agentBar').hidden = false; Agent.updateNames(); Agent.openPanel(); }
        ms.pop(); Sessions.touch();
        const n = View.thread.querySelector('.msg[data-id="' + m.id + '"]'); if (n) n.remove();
        await Agent.run(taskText);
        return;
      }
      ms.pop(); Sessions.touch();
      const n = View.thread.querySelector('.msg[data-id="' + m.id + '"]'); if (n) n.remove();
      await this.run();
    } else if (act === 'continue') {
      await this.run({ cont: m });
    } else if (act === 'edit') {
      this.beginEdit(m);
    }
  },
  refreshActions() {
    const ms = Sessions.msgs();
    $$('.msg.ai[data-id]', View.thread).forEach((n) => {
      const m = ms.filter((x) => x.id === n.getAttribute('data-id'))[0];
      if (!m) return;
      const isLast = ms[ms.length - 1] === m && !this.busy;
      n.classList.toggle('last', isLast);
      const old = n.querySelector('.actions');
      const fresh = View.aiActions(m, isLast);
      if (old) old.replaceWith(fresh); else n.appendChild(fresh);
    });
  },
  beginEdit(m) {
    const node = View.thread.querySelector('.msg.user[data-id="' + m.id + '"]');
    if (!node || node.querySelector('.edit-box')) return;
    const bubble = node.querySelector('.bubble'), acts = node.querySelector('.actions');
    const ta = el('textarea', { 'aria-label': '编辑消息' }); ta.value = this.userText(m);
    const box = el('div', { class: 'edit-box' }, ta,
      el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', onclick: () => { box.remove(); bubble.hidden = false; acts.hidden = false; } }, '取消'),
        el('button', { class: 'btn sm primary', type: 'button', onclick: () => this.applyEdit(m, ta.value) }, '保存并重新生成')));
    bubble.hidden = true; acts.hidden = true;
    node.insertBefore(box, bubble);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  },
  async applyEdit(m, newText) {
    newText = newText.trim();
    const ms = Sessions.msgs(), i = ms.indexOf(m);
    if (i < 0) return;
    const others = Array.isArray(m.content) ? m.content.filter((p) => p && !(p.type === 'text' && !p.zcFile && !/^(上传文件内容|已上传文件)/.test(p.text || ''))) : [];
    if (!newText && !others.length) return Toast.err('消息内容不能为空');
    ms.splice(i + 1);
    if (others.length) m.content = (newText ? [{ type: 'text', text: newText }] : []).concat(others);
    else m.content = newText;
    Sessions.touch();
    View.renderThread();
    await this.run();
  },

  /* ---------- 会话 ---------- */
  newChat() {
    if (this.busy) return Toast.info('请先等待当前回复完成，或点击停止');
    if (!Sessions.msgs().length) { Composer.focus(); return; }
    Sessions.create(); Sessions.save();
    View.renderThread(); View.renderSessions(); Composer.clear(); Composer.focus();
    App.closeDrawer();
  },
  openSession(id) {
    if (this.busy) return Toast.info('请先等待当前回复完成，或点击停止');
    if (id === Sessions.curId) { App.closeDrawer(); return; }
    Sessions.later.flush(); Sessions.switchTo(id);
    View.renderThread(); View.renderSessions(); App.closeDrawer(); Composer.focus();
  },
  async sessionAction(act, id) {
    const s = Sessions.list.filter((x) => x.id === id)[0];
    if (!s) return;
    if (act === 'rename') {
      const t = await Dialog.prompt('重命名对话', s.title);
      if (t != null) { Sessions.rename(id, t); }
    } else if (act === 'delete') {
      if (this.busy && id === Sessions.curId) return Toast.info('请先停止当前生成');
      if (await Dialog.confirm('删除对话', '将删除“' + s.title + '”，此操作无法撤销。', '删除', true)) {
        const wasCur = id === Sessions.curId;
        Sessions.remove(id);
        if (wasCur) View.renderThread();
        View.renderSessions();
      }
    }
  },
  async clearCurrent() {
    if (this.busy) return Toast.info('请先停止当前生成');
    if (!Sessions.msgs().length) return Toast.info('当前对话已经是空的');
    if (!(await Dialog.confirm('清空当前对话', '将清除这个对话中的所有消息，并重置模型看到的上下文。', '清空', true))) return;
    const s = Sessions.cur(); s.messages = []; s.titleLocked = false; Sessions.autoTitle(s); Sessions.save();
    View.renderThread(); View.renderSessions();
  },
  exportMarkdown(s) {
    const L = ['# ' + (s.title || '对话'), '', '> 导出时间：' + new Date().toLocaleString(), ''];
    s.messages.forEach((m) => {
      if (m.role === 'user') L.push('## 用户', '', Chat.userText(m) || '（附件消息）', '');
      else { L.push('## ' + ((m.meta && m.meta.model) || 'AI'), ''); if (m.meta && m.meta.reasoning) L.push('<details><summary>思考过程</summary>', '', m.meta.reasoning, '', '</details>', ''); L.push(m.content || '', ''); }
    });
    return L.join('\n');
  },
  exportCurrent() {
    const s = Sessions.cur();
    if (!s || !s.messages.length) return Toast.err('当前没有可导出的对话');
    downloadBlob('ZC-GURA_' + (s.title || '对话').replace(/[\\\/:*?"<>|]/g, '_').slice(0, 30) + '_' + new Date().toISOString().slice(0, 10) + '.md', this.exportMarkdown(s), 'text/markdown;charset=utf-8');
    Toast.ok('对话已导出');
  }
};

/* ==========================================================================
 * 图片生成（独立于对话 API）
 * ========================================================================== */
const Draw = {
  cfg: { url: '', key: '', model: '', size: '1024x1024', format: 'openai' },
  busy: false,
  init() { const v = Store.get('draw_api', null); if (isObj(v)) this.cfg = Object.assign(this.cfg, v); },
  ready() { return !!(this.cfg.url && this.cfg.model); },
  save(c) { this.cfg = Object.assign(this.cfg, c); Store.set('draw_api', this.cfg); },
  endpoint() {
    const u = Format.trim(this.cfg.url);
    if (this.cfg.format === 'gemini') {
      if (u.indexOf(':predict') >= 0) return u;
      if (u.indexOf('/models/') >= 0) return u + ':predict';
      return Format.root(u) + '/v1beta/models/' + (this.cfg.model || 'imagen-3.0-generate-001') + ':predict';
    }
    if (u.indexOf('/images/generations') >= 0) return u;
    if (u.indexOf('/chat/completions') >= 0) return u.replace(/\/chat\/completions$/, '/images/generations');
    if (/\/v\d+[a-z]*$/i.test(u)) return u + '/images/generations';
    return Format.root(u) + '/v1/images/generations';
  },
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.cfg.format === 'gemini') { if (this.cfg.key) h['x-goog-api-key'] = this.cfg.key; }
    else if (this.cfg.key) h.Authorization = 'Bearer ' + this.cfg.key;
    return h;
  },
  body(prompt, noRF, mini) {
    if (this.cfg.format === 'gemini') return { instances: [{ prompt }], parameters: { sampleCount: 1 } };
    if (mini) return { model: this.cfg.model, prompt };   // 最精简参数：只留模型与提示词，绕开个别对 size / n / response_format 处理有问题的网关
    const b = { model: this.cfg.model, prompt, n: 1, size: this.cfg.size || '1024x1024' };
    if (!noRF) b.response_format = 'b64_json';
    return b;
  },
  extract(j) {
    const out = [];
    const arr = j && (j.data || j.predictions || j.images);
    if (Array.isArray(arr)) arr.forEach((it) => {
      if (!it) return;
      if (typeof it === 'string') out.push({ b64: it });
      else if (it.b64_json) out.push({ b64: it.b64_json });
      else if (it.bytesBase64Encoded) out.push({ b64: it.bytesBase64Encoded, mime: it.mimeType });
      else if (it.url) out.push({ url: it.url });
    });
    return out;
  },
  /* Cloudflare 52x / 网关 5xx 的通俗解释（这类错误发生在画图接口所在的服务器一侧） */
  hint(status) {
    return {
      520: '画图接口所在的服务器返回了无效响应或中途断开连接（Cloudflare 520）。常见原因：生成耗时过长、返回的图片数据过大，或上游模型 / 网关暂时不稳定。这是接口服务端的问题，不是本页面的问题。',
      521: '画图接口所在的服务器拒绝了连接（Cloudflare 521），服务可能已宕机或正在重启。',
      522: '连接画图接口所在的服务器超时（Cloudflare 522）。',
      523: '无法到达画图接口所在的服务器（Cloudflare 523）。',
      524: '画图接口所在的服务器响应超时（Cloudflare 524），多为图片生成耗时过长。',
      525: '与画图接口所在的服务器 SSL 握手失败（Cloudflare 525）。',
      526: '画图接口所在服务器的 SSL 证书无效（Cloudflare 526）。'
    }[status] || '';
  },
  /* 图片链接常有有效期 / 防盗链：尽量转存为本地 data URL（失败则保留原链接） */
  async keep(im, signal) {
    if (!im.url || /^data:/i.test(im.url)) return im;
    try {
      const r = await Net.call(im.url, { method: 'GET', headers: {}, signal, timeoutMs: 30000, retries: 0, route: 'auto' });
      if (!r.ok) return im;
      const blob = await r.blob();
      if (!blob.size || blob.size > 6 * 1048576 || !/^image\//i.test(blob.type || '')) return im;
      const du = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
      const ci = du.indexOf(',');
      return ci > 0 ? { b64: du.slice(ci + 1), mime: blob.type } : im;
    } catch (e) {
      if (e && e.kind === 'abort') throw e;
      return im;
    }
  },
  async generate(prompt) {
    if (this.busy || Chat.busy) return Toast.info('请等待当前任务完成');
    this.busy = true; Chat.setBusy(true);
    const um = Sessions.add('user', '🎨 ' + prompt);
    View.thread.appendChild(View.userNode(um)); View.updateEmpty(); View.stick = true; View.scroll(true);
    const h = View.createStream(this.cfg.model); View.scroll(true);
    const ctrl = new AbortController(); Chat.ctrl = ctrl;
    let msg = null;
    try {
      /* 请求策略（针对 HTTP 520 / 5xx / 断连 / 返回体不完整）：
       *   第 1 次：完整参数；第 2 次：去掉 response_format（返回体更小、兼容性更好）；
       *   第 3 次：最精简参数，并改走另一条线路（直连 ↔ 站内代理）。仅对可重试的错误降级，4xx 等明确错误立即报告。 */
      const ep = this.endpoint(), MAX = 3, gem = this.cfg.format === 'gemini';
      let noRF = false, mini = false, downgraded = false, useRoute = 'auto', probing = false, tries = 0, lastRoute = '', bad = null, json = null;
      while (!json) {
        try {
          const resp = await Net.call(ep, { method: 'POST', headers: this.headers(), body: JSON.stringify(this.body(prompt, noRF, mini)), signal: ctrl.signal, timeoutMs: 180000, retries: 0, route: useRoute });
          lastRoute = resp.zcRoute || lastRoute;
          if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            if (!noRF && !gem && /response_format/i.test(t)) { noRF = true; downgraded = true; continue; }
            const he = httpError(resp.status, t); he.wait = Net.retryAfter(resp); he.route = resp.zcRoute || '';
            throw he;
          }
          const raw = await resp.text();
          try { json = JSON.parse(raw); } catch (pe) {
            const be = new Error('接口返回的内容不完整或不是 JSON'); be.kind = 'badbody'; be.detail = extractErrorText(raw.slice(0, 600));
            throw be;
          }
        } catch (e) {
          if (ctrl.signal.aborted || e.kind === 'abort') throw e;
          if (probing && !e.status && e.kind !== 'badbody') { probing = false; useRoute = 'auto'; continue; }   // 换线路根本连不上（如 CORS / 无站内代理）：不算一次重试，退回原线路
          const fatal = e.fatal || (e.attempts && e.attempts.some((a) => a.code && /FORBIDDEN|BAD_|BLOCKED|NOT_ALLOWED|TOO_LARGE/.test(a.code)));
          const retry = !fatal && (e.status ? Net.classify(e.status).retry : (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'relay' || e.kind === 'badbody'));
          if (retry && (e.status || !bad)) bad = e;
          const n = ++tries;
          if (!retry || n >= MAX) {
            const f = ((!retry || !e.status) && bad) ? bad : e;   // 降级后的参数若引发别的错误，仍报告最初的服务端错误
            f.tries = n; throw f;
          }
          if (!gem) {
            if (n === 1) { noRF = true; downgraded = true; }
            else { noRF = true; mini = true; downgraded = true; }
          }
          if (n === 2) {
            const alt = lastRoute === 'direct' ? 'relay' : (lastRoute === 'relay' ? 'direct' : '');
            if (alt) { useRoute = alt; probing = true; }
          }
          Toast.info((e.status ? '画图接口返回 HTTP ' + e.status : '画图接口连接失败') + '，正在自动重试（第 ' + (n + 1) + '/' + MAX + ' 次）');
          await sleep(Math.max(e.wait || 0, 2000 * n), ctrl.signal);
        }
      }
      let imgs = this.extract(json);
      if (!imgs.length) {
        const em = Format.streamError(json);
        throw new Error(em ? '画图接口返回错误：' + em : '接口没有返回可识别的图片数据，请检查画图 API 的地址、模型和接口格式。');
      }
      if (downgraded) imgs = await Promise.all(imgs.map((im) => this.keep(im, ctrl.signal)));
      const md = imgs.map((im) => '![生成的图片](' + (im.url ? im.url : 'data:' + (im.mime || 'image/png') + ';base64,' + im.b64) + ')').join('\n\n');
      msg = Sessions.add('assistant', md, { model: this.cfg.model, draw: true });
      Toast.ok(downgraded && tries ? '图片已生成（已自动切换为兼容参数重试）' : '图片已生成');
    } catch (e) {
      const aborted = ctrl.signal.aborted || e.kind === 'abort';
      let text;
      if (aborted) text = '已取消图片生成。';
      else if (e.status) {
        text = '图片生成失败（HTTP ' + e.status + '）：' + (this.hint(e.status) || Net.friendly(e.status) || '') + (e.detail ? '\n' + e.detail : '');
        if (e.tries > 1) text += '\n\n已自动尝试 ' + e.tries + ' 次（完整参数 → 去掉 response_format → 最精简参数并换线路），仍未成功。可以稍后再试，或在 设置 → 图像生成 中调小尺寸、更换画图模型 / 接口。';
      } else if (e.kind === 'badbody') text = '图片生成失败：' + e.message + (e.detail ? '\n' + e.detail : '') + (e.tries > 1 ? '\n\n已自动尝试 ' + e.tries + ' 次。' : '');
      else text = '图片生成失败：' + (e.kind ? Net.explain(e, this.cfg.url) : (e.message || String(e)));
      msg = Sessions.add('assistant', text, { error: !aborted, stopped: aborted, model: this.cfg.model });
    }

    View.finishStream(h);
    const node = View.aiNode(msg, true);
    if (h.root.parentNode) h.root.replaceWith(node); else View.thread.appendChild(node);
    Chat.ctrl = null; this.busy = false; Chat.setBusy(false);
    Chat.refreshActions(); Sessions.later.flush(); View.renderSessions(); View.scroll();
  }
};

/* ==========================================================================
 * 06b Coding Agent：目录授权（File System Access API）/ 安全路径校验 /
 *      真实文件工具 / 多 Provider 工具调用 / Agent 循环（最多 20 步，可停止）/
 *      文件树与操作日志 UI / Diff 确认
 * -------------------------------------------------------------------------
 *  全部在浏览器本地运行，不经过 Worker：Worker 不存储、不代理、也看不到任何
 *  本地文件内容，只负责转发到 AI API 的请求（与普通对话共用同一条 relay 通道）。
 *  仅 Chromium 内核的桌面浏览器（Chrome / Edge 等 86+）支持 showDirectoryPicker；
 *  Firefox、Safari 及所有移动端浏览器均不支持（两家均明确拒绝了该提案），
 *  这是浏览器自身能力的边界，无法在页面里模拟出来。
 * ========================================================================== */

/* ---- IndexedDB：持久化目录句柄（FileSystemHandle 不是 JSON，无法存进 localStorage） ---- */
const AgentDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    if (!window.indexedDB) return Promise.reject(new Error('浏览器不支持 IndexedDB'));
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('zc_gura_agent', 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { try { req.result.createObjectStore('handles'); } catch (e) { /* 已存在 */ } };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(key);
      req.onsuccess = () => resolve(req.result == null ? null : req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
};

/* ---- 文件系统封装：目录授权、权限、路径安全校验、真实读写 ---- */
const AgentFS = {
  root: null,
  rootName: '',
  IGNORE_DIR: /^(node_modules|\.git|\.svn|\.hg|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|env|__pycache__|\.idea|\.vscode|\.DS_Store)$/i,
  IGNORE_FILE: /^\.env(\..*)?$/i,

  supported() {
    try { return 'showDirectoryPicker' in window && window.isSecureContext && window.self === window.top; }
    catch (e) { return false; }
  },
  ignored(name, isDir) { return isDir ? this.IGNORE_DIR.test(name) : this.IGNORE_FILE.test(name); },

  /* 路径安全校验：拒绝 ../、绝对路径（/ 开头）、Windows 盘符、反斜杠、空字节；
   * 返回安全的分段数组。就算校验有疏漏，getDirectoryHandle/getFileHandle 本身
   * 也只接受单个名字（不接受 . / .. / 路径分隔符），双重保险。 */
  sanitize(p) {
    let s = String(p == null ? '' : p).trim();
    if (!s || s === '.' || s === './') return [];
    if (s.indexOf('\\') >= 0) throw new Error('路径不允许包含反斜杠：' + p);
    if (/^[a-zA-Z]:/.test(s)) throw new Error('不允许使用盘符路径：' + p);
    if (/^[a-zA-Z]+:\/\//.test(s)) throw new Error('不允许使用带协议的路径：' + p);
    if (s.indexOf('\x00') >= 0) throw new Error('路径包含非法字符');
    if (s.charAt(0) === '/') s = s.slice(1);
    const parts = s.split('/').map((x) => x.trim()).filter((x) => x !== '' && x !== '.');
    parts.forEach((seg) => {
      if (seg === '..') throw new Error('路径不允许包含 ..（不能越权访问项目目录之外）：' + p);
      if (/[\x00-\x1f]/.test(seg)) throw new Error('路径包含非法字符：' + p);
    });
    return parts;
  },

  async ensurePermission(mode) {
    if (!this.root) return false;
    try { return (await this.root.queryPermission({ mode: mode || 'readwrite' })) === 'granted'; }
    catch (e) { return false; }
  },
  async requestPermission(mode) {
    if (!this.root) return false;
    const opts = { mode: mode || 'readwrite' };
    try { if ((await this.root.queryPermission(opts)) === 'granted') return true; } catch (e) { /* 继续尝试请求 */ }
    try { return (await this.root.requestPermission(opts)) === 'granted'; }
    catch (e) { return false; }
  },

  async pick() {
    if (!this.supported()) throw new Error('当前浏览器不支持本地目录访问（File System Access API）。请使用桌面版 Chrome / Edge 打开本页面。');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    this.root = handle; this.rootName = handle.name;
    try { await AgentDB.set('rootDir', handle); } catch (e) { /* 持久化失败不影响本次会话使用 */ }
    return handle;
  },
  /* 页面加载时静默尝试恢复：只 queryPermission（不弹窗），需要真正的用户手势时
   * 由 Agent.toggleMode() 里的 requestPermission 来完成（点击“Agent”按钮本身就是手势）。 */
  async restore() {
    try {
      const handle = await AgentDB.get('rootDir');
      if (!handle) return 'none';
      this.root = handle; this.rootName = handle.name;
      return (await this.ensurePermission('readwrite')) ? 'granted' : 'needs-permission';
    } catch (e) { return 'none'; }
  },
  async forget() {
    this.root = null; this.rootName = '';
    try { await AgentDB.del('rootDir'); } catch (e) { /* ignore */ }
  },

  async _walkDir(parts, create) {
    let dir = this.root;
    for (let i = 0; i < parts.length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    return dir;
  },
  async _kindOf(dir, name) {
    try { await dir.getFileHandle(name); return 'file'; } catch (e) { /* 不是文件 */ }
    try { await dir.getDirectoryHandle(name); return 'dir'; } catch (e) { /* 也不是目录 */ }
    return null;
  },

  async listDir(relPath) {
    if (!this.root) throw new Error('尚未选择项目目录');
    const parts = this.sanitize(relPath);
    const dir = await this._walkDir(parts, false);
    const out = [];
    for await (const entry of dir.values()) {
      if (this.ignored(entry.name, entry.kind === 'directory')) continue;
      const item = { name: entry.name, kind: entry.kind === 'directory' ? 'dir' : 'file', path: parts.concat([entry.name]).join('/') };
      if (entry.kind === 'file') { try { item.size = (await entry.getFile()).size; } catch (e) { /* ignore */ } }
      out.push(item);
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'dir' ? -1 : 1)));
    return out;
  },

  isBinary(u8) {
    const n = Math.min(u8.length, 4096);
    for (let i = 0; i < n; i++) if (u8[i] === 0) return true;
    return false;
  },
  MAX_READ: 220000,
  async readFile(relPath) {
    const parts = this.sanitize(relPath);
    if (!parts.length) throw new Error('缺少文件路径');
    const dir = await this._walkDir(parts.slice(0, -1), false);
    const name = parts[parts.length - 1];
    const kind = await this._kindOf(dir, name);
    if (kind === 'dir') throw new Error(relPath + ' 是一个目录，请使用 list_files 查看，而不是 read_file');
    if (kind !== 'file') throw new Error('文件不存在：' + relPath);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (this.isBinary(u8)) return { binary: true, size: file.size };
    let text = new TextDecoder('utf-8').decode(u8);
    let truncated = false;
    if (text.length > this.MAX_READ) { text = text.slice(0, this.MAX_READ); truncated = true; }
    return { binary: false, text, size: file.size, truncated };
  },

  async createFile(relPath, content) {
    const parts = this.sanitize(relPath);
    if (!parts.length) throw new Error('缺少文件路径');
    const dir = await this._walkDir(parts.slice(0, -1), true);
    const name = parts[parts.length - 1];
    const kind = await this._kindOf(dir, name);
    if (kind) throw new Error('创建失败，路径已存在：' + relPath);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content == null ? '' : String(content));
    await w.close();
  },
  async writeFile(relPath, content) {
    const parts = this.sanitize(relPath);
    if (!parts.length) throw new Error('缺少文件路径');
    const dir = await this._walkDir(parts.slice(0, -1), false);
    const name = parts[parts.length - 1];
    const kind = await this._kindOf(dir, name);
    if (kind === 'dir') throw new Error(relPath + ' 是一个目录，无法作为文件写入');
    if (kind !== 'file') throw new Error('文件不存在，无法修改：' + relPath + '（如需新建请使用 create_file）');
    const fh = await dir.getFileHandle(name);
    const w = await fh.createWritable();
    await w.write(content == null ? '' : String(content));
    await w.close();
  },
  async createDirectory(relPath) {
    const parts = this.sanitize(relPath);
    if (!parts.length) throw new Error('缺少目录路径');
    await this._walkDir(parts, true);
  },
  async deleteFile(relPath) {
    const parts = this.sanitize(relPath);
    if (!parts.length) throw new Error('缺少文件路径');
    const dir = await this._walkDir(parts.slice(0, -1), false);
    const name = parts[parts.length - 1];
    const kind = await this._kindOf(dir, name);
    if (kind === 'dir') throw new Error('delete_file 仅支持删除单个文件，' + relPath + ' 是一个目录，出于安全考虑不支持整目录删除');
    if (kind !== 'file') throw new Error('要删除的文件不存在：' + relPath);
    await dir.removeEntry(name, { recursive: false });
  },

  /* 递归搜索文件名 / 文件内容，带遍历上限，避免超大仓库卡死页面 */
  async search(query, opts) {
    opts = opts || {};
    const startParts = this.sanitize(opts.path || '');
    const root = await this._walkDir(startParts, false);
    const q = String(query || '').toLowerCase();
    const byContent = opts.mode === 'content';
    const results = [];
    let visited = 0, truncated = false;
    const LIMIT = 2500, MAXDEPTH = 14, MAXHITS = 60;
    const walk = async (dir, prefix, depth) => {
      if (truncated || results.length >= MAXHITS) return;
      if (depth > MAXDEPTH) { truncated = true; return; }
      for await (const entry of dir.values()) {
        if (truncated || results.length >= MAXHITS) return;
        if (this.ignored(entry.name, entry.kind === 'directory')) continue;
        visited++;
        if (visited > LIMIT) { truncated = true; return; }
        const relName = prefix.concat([entry.name]).join('/');
        if (entry.kind === 'directory') { await walk(entry, prefix.concat([entry.name]), depth + 1); continue; }
        if (!byContent) { if (entry.name.toLowerCase().indexOf(q) >= 0) results.push({ path: relName }); continue; }
        try {
          const file = await entry.getFile();
          if (file.size > 400000) continue;
          const u8 = new Uint8Array(await file.arrayBuffer());
          if (this.isBinary(u8)) continue;
          const text = new TextDecoder('utf-8').decode(u8);
          const idx = text.toLowerCase().indexOf(q);
          if (idx >= 0) {
            const lineNo = text.slice(0, idx).split('\n').length;
            results.push({ path: relName, line: lineNo, snippet: text.split('\n')[lineNo - 1].trim().slice(0, 160) });
          }
        } catch (e) { /* 跳过读取失败的文件 */ }
      }
    };
    await walk(root, startParts, 0);
    return { results, truncated };
  }
};

/* ---- 工具定义（JSON Schema，四家 Provider 通用）与真实执行 ---- */
const AgentTools = {
  MUTATING: { create_file: 1, write_file: 1, delete_file: 1 },
  LIST: [
    { name: 'list_files', description: '列出项目目录下某个目录中的文件和子目录（已自动排除 node_modules/.git/dist/build/.cache 等）。用于按需探索项目结构，不要一次性递归整个项目。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根目录的目录路径；留空或 "." 表示项目根目录' }, recursive: { type: 'boolean', description: '是否递归列出所有子目录下的文件，默认 false（默认只列出这一层）' } } } },
    { name: 'read_file', description: '读取项目目录中某个文本文件的完整内容。单次最多返回约 22 万字符，超出部分会被截断并提示。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对项目根目录的文件路径' } }, required: ['path'] } },
    { name: 'search_files', description: '在项目目录中按文件名或文件内容搜索关键字，用于定位相关代码，避免逐个读取文件。', parameters: { type: 'object', properties: { query: { type: 'string', description: '要搜索的关键字' }, path: { type: 'string', description: '限定搜索范围的相对目录，默认整个项目' }, mode: { type: 'string', enum: ['name', 'content'], description: '"name" 按文件名匹配（默认），"content" 按文件内容全文匹配' } }, required: ['query'] } },
    { name: 'create_file', description: '在项目目录中创建一个新文件并写入完整内容。如果文件已存在会失败，请改用 write_file。执行前会向用户展示内容预览并等待确认，用户可能拒绝。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要创建的新文件的相对路径' }, content: { type: 'string', description: '文件的完整内容' } }, required: ['path', 'content'] } },
    { name: 'write_file', description: '覆盖写入项目目录中一个已存在文件的完整内容（需要提供整份新内容，不是增量修改）。如果文件不存在会失败，请改用 create_file。执行前会向用户展示 Diff 并等待确认，用户可能拒绝。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要修改的已存在文件的相对路径' }, content: { type: 'string', description: '替换后的文件完整内容' } }, required: ['path', 'content'] } },
    { name: 'create_directory', description: '在项目目录中创建一个新目录（自动创建必要的中间目录）。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要创建的目录相对路径' } }, required: ['path'] } },
    { name: 'delete_file', description: '删除项目目录中的一个文件（仅限单个文件，不支持删除整个目录）。默认禁止自动执行，每次都需要用户手动确认，请谨慎使用。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要删除的文件相对路径' } }, required: ['path'] } }
  ],
  find(name) { return this.LIST.filter((t) => t.name === name)[0] || null; },

  fmtEntries(list) {
    if (!list.length) return '（空目录）';
    return list.map((e) => (e.kind === 'dir' ? '[DIR]  ' + e.path + '/' : '[FILE] ' + e.path + '  (' + fmtSize(e.size || 0) + ')')).join('\n');
  },
  async listRecursive(path, cap) {
    const out = [];
    const walk = async (p) => {
      if (out.length >= cap) return;
      const entries = await AgentFS.listDir(p);
      for (let i = 0; i < entries.length; i++) {
        if (out.length >= cap) return;
        out.push(entries[i]);
        if (entries[i].kind === 'dir') await walk(entries[i].path);
      }
    };
    await walk(path);
    return out;
  },

  /* 只读 / 低风险工具：直接执行，返回喂给模型的文本结果 */
  async runReadOnly(name, args) {
    if (name === 'list_files') {
      let entries;
      if (args.recursive) {
        entries = await this.listRecursive(args.path || '', 400);
        if (entries.length >= 400) entries.push({ kind: 'file', path: '…（已达到 400 项上限，未列出全部，请缩小范围或分批查看）', size: 0 });
      } else entries = await AgentFS.listDir(args.path || '');
      return { text: this.fmtEntries(entries) };
    }
    if (name === 'read_file') {
      const r = await AgentFS.readFile(args.path);
      if (r.binary) return { text: '该文件是二进制文件（' + fmtSize(r.size) + '），无法以文本方式读取。' };
      return { text: r.text + (r.truncated ? '\n\n…（文件较大，已截断，仅显示前约 22 万字符）' : '') };
    }
    if (name === 'search_files') {
      const r = await AgentFS.search(args.query, { path: args.path, mode: args.mode });
      if (!r.results.length) return { text: '未找到匹配 "' + args.query + '" 的' + (args.mode === 'content' ? '文件内容' : '文件名') + '。' };
      const lines = r.results.map((it) => (it.line ? (it.path + ':' + it.line + ': ' + it.snippet) : it.path));
      return { text: lines.join('\n') + (r.truncated ? '\n\n…（结果或遍历范围已达到上限，未必完整，请缩小搜索范围）' : '') };
    }
    if (name === 'create_directory') { await AgentFS.createDirectory(args.path); return { text: '目录已创建：' + args.path }; }
    throw new Error('unreachable');
  },

  /* 变更类工具：先给出 Diff 预览，由 Agent 编排层弹窗确认后再 commit() 真正执行 */
  async preview(name, args) {
    if (name === 'create_file') {
      let exists = true;
      try { await AgentFS.readFile(args.path); } catch (e) { exists = false; }
      return { kind: 'create', path: args.path, before: '', after: String(args.content == null ? '' : args.content), willFail: exists };
    }
    if (name === 'write_file') {
      const cur = await AgentFS.readFile(args.path);
      return { kind: 'modify', path: args.path, before: cur.binary ? '' : cur.text, beforeBinary: cur.binary, after: String(args.content == null ? '' : args.content) };
    }
    if (name === 'delete_file') {
      const cur = await AgentFS.readFile(args.path);
      return { kind: 'delete', path: args.path, before: cur.binary ? '' : cur.text, beforeBinary: cur.binary, after: '' };
    }
    throw new Error('unreachable');
  },
  async commit(name, args) {
    if (name === 'create_file') { await AgentFS.createFile(args.path, args.content); return '文件已创建：' + args.path; }
    if (name === 'write_file') { await AgentFS.writeFile(args.path, args.content); return '文件已写入：' + args.path; }
    if (name === 'delete_file') { await AgentFS.deleteFile(args.path); return '文件已删除：' + args.path; }
    throw new Error('unreachable');
  }
};

/* ---- 多 Provider 工具调用：请求体拼装 + 响应解析（OpenAI / Anthropic / Gemini / Ollama） ----
 * 文本与推理增量继续复用 Format.delta / Format.reasoningDelta 等既有解析（那些函数只认
 * 特定字段，遇到工具调用相关的分片会自然返回空字符串，不会互相干扰）。这里只新增“工具调用”
 * 这一条通道的抽取与累积。 */
const AgentFormat = {
  tools(fmt) {
    fmt = Format.normalize(fmt);
    const defs = AgentTools.LIST;
    if (fmt === 'anthropic') return defs.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (fmt === 'gemini') return [{ functionDeclarations: defs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    return defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  },

  body(cfg, o) {
    const fmt = Format.of(cfg);
    const f = o.flags || {};
    const maxT = (f.maxCap && o.maxTokens > f.maxCap) ? f.maxCap : (o.maxTokens || 4096);
    const temp = o.temperature != null ? o.temperature : 0.4;
    if (fmt === 'anthropic') {
      const b = { model: cfg.model, system: o.system, messages: this._anthropicMsgs(o.history), max_tokens: maxT, stream: !!o.stream, tools: this.tools(fmt) };
      if (!f.noTemp) b.temperature = Math.min(1, temp);
      return b;
    }
    if (fmt === 'gemini') {
      const gc = { maxOutputTokens: maxT };
      if (!f.noTemp) gc.temperature = Math.min(2, temp);
      return { contents: this._geminiContents(o.history), systemInstruction: o.system ? { parts: [{ text: o.system }] } : undefined, tools: this.tools(fmt), generationConfig: gc };
    }
    if (fmt === 'ollama') {
      const msgs = [{ role: 'system', content: o.system || '' }].concat(this._ollamaMsgs(o.history));
      const opts = {}; if (!f.noTemp) opts.temperature = temp;
      return { model: cfg.model, messages: msgs, stream: !!o.stream, tools: this.tools(fmt), options: opts };
    }
    const msgs = [{ role: 'system', content: o.system || '' }].concat(this._openaiMsgs(o.history));
    const b = { model: cfg.model, messages: msgs, stream: !!o.stream, tools: this.tools(fmt), tool_choice: 'auto' };
    if (!f.noTemp) b.temperature = temp;
    b[f.mct ? 'max_completion_tokens' : 'max_tokens'] = maxT;
    if (o.stream && !f.noStreamOpts) b.stream_options = { include_usage: true };
    return b;
  },

  _openaiMsgs(history) {
    const out = [];
    history.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', content: m.text || '' });
      else if (m.role === 'assistant') {
        const am = { role: 'assistant', content: m.text || null };
        if (m.toolCalls && m.toolCalls.length) am.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.rawArgs != null ? tc.rawArgs : JSON.stringify(tc.args || {}) } }));
        out.push(am);
      } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.text });
    });
    return out;
  },
  _anthropicMsgs(history) {
    const out = [];
    history.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', content: [{ type: 'text', text: m.text || '(空)' }] });
      else if (m.role === 'assistant') {
        const blocks = [];
        if (m.text) blocks.push({ type: 'text', text: m.text });
        (m.toolCalls || []).forEach((tc) => blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} }));
        if (!blocks.length) blocks.push({ type: 'text', text: '(空)' });
        out.push({ role: 'assistant', content: blocks });
      } else if (m.role === 'tool') {
        const last = out[out.length - 1];
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.text };
        if (last && last.role === 'user' && last._trg) last.content.push(block);
        else out.push({ role: 'user', content: [block], _trg: true });
      }
    });
    out.forEach((o) => { delete o._trg; });
    return out;
  },
  _geminiContents(history) {
    const out = [];
    history.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', parts: [{ text: m.text || '(空)' }] });
      else if (m.role === 'assistant') {
        const parts = [];
        if (m.text) parts.push({ text: m.text });
        (m.toolCalls || []).forEach((tc) => parts.push({ functionCall: { name: tc.name, args: tc.args || {} } }));
        if (!parts.length) parts.push({ text: '(空)' });
        out.push({ role: 'model', parts });
      } else if (m.role === 'tool') {
        const last = out[out.length - 1];
        const part = { functionResponse: { name: m.name, response: { result: m.text } } };
        if (last && last.role === 'user' && last._trg) last.parts.push(part);
        else out.push({ role: 'user', parts: [part], _trg: true });
      }
    });
    out.forEach((o) => { delete o._trg; });
    return out;
  },
  _ollamaMsgs(history) {
    const out = [];
    history.forEach((m) => {
      if (m.role === 'user') out.push({ role: 'user', content: m.text || '' });
      else if (m.role === 'assistant') {
        const am = { role: 'assistant', content: m.text || '' };
        if (m.toolCalls && m.toolCalls.length) am.tool_calls = m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args || {} } }));
        out.push(am);
      } else if (m.role === 'tool') out.push({ role: 'tool', tool_name: m.name, content: m.text });
    });
    return out;
  },

  /* 流式：只处理“工具调用”这条通道的增量累积 */
  feedToolDelta(fmt, S, j) {
    fmt = Format.normalize(fmt);
    if (!j) return;
    if (fmt === 'openai') {
      const ch = j.choices && j.choices[0];
      const arr = ch && ch.delta && ch.delta.tool_calls;
      if (Array.isArray(arr)) arr.forEach((tc) => {
        const i = tc.index != null ? tc.index : 0;
        const cur = S.toolCalls[i] || (S.toolCalls[i] = { id: '', name: '', args: '' });
        if (tc.id) cur.id = tc.id;
        if (tc.function) {
          if (tc.function.name) cur.name = cur.name || tc.function.name;
          if (typeof tc.function.arguments === 'string') cur.args += tc.function.arguments;
        }
      });
      return;
    }
    if (fmt === 'anthropic') {
      if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') { S.toolCalls[j.index] = { id: j.content_block.id, name: j.content_block.name, args: '' }; return; }
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'input_json_delta') { const cur = S.toolCalls[j.index]; if (cur) cur.args += j.delta.partial_json || ''; return; }
      return;
    }
    if (fmt === 'gemini') {
      const c = j.candidates && j.candidates[0];
      ((c && c.content && c.content.parts) || []).forEach((p) => { if (p && p.functionCall) S.toolCalls.push({ id: 'call_' + S.toolCalls.length + '_' + Math.random().toString(36).slice(2, 8), name: p.functionCall.name, args: p.functionCall.args || {}, parsed: true }); });
      return;
    }
    if (fmt === 'ollama') {
      const arr = j.message && j.message.tool_calls;
      if (Array.isArray(arr)) arr.forEach((tc) => S.toolCalls.push({ id: 'call_' + S.toolCalls.length + '_' + Math.random().toString(36).slice(2, 8), name: tc.function && tc.function.name, args: (tc.function && tc.function.arguments) || {}, parsed: true }));
      return;
    }
  },
  /* 非流式：一次性抽取工具调用（参数原本就是字符串的在这里统一 JSON.parse） */
  extractToolCalls(fmt, json) {
    fmt = Format.normalize(fmt);
    const out = [];
    if (!json) return out;
    if (fmt === 'anthropic') { (json.content || []).forEach((b) => { if (b && b.type === 'tool_use') out.push({ id: b.id, name: b.name, args: b.input || {} }); }); return out; }
    if (fmt === 'gemini') { const c = json.candidates && json.candidates[0]; ((c && c.content && c.content.parts) || []).forEach((p) => { if (p && p.functionCall) out.push({ id: 'call_' + out.length + '_' + Math.random().toString(36).slice(2, 8), name: p.functionCall.name, args: p.functionCall.args || {} }); }); return out; }
    if (fmt === 'ollama') { const arr = json.message && json.message.tool_calls; if (Array.isArray(arr)) arr.forEach((tc) => out.push({ id: 'call_' + out.length + '_' + Math.random().toString(36).slice(2, 8), name: tc.function && tc.function.name, args: (tc.function && tc.function.arguments) || {} })); return out; }
    const ch = json.choices && json.choices[0], msg = ch && ch.message, arr = msg && msg.tool_calls;
    if (Array.isArray(arr)) arr.forEach((tc) => {
      let args = {}; try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { args = { __parse_error__: true, raw: tc.function && tc.function.arguments }; }
      out.push({ id: tc.id, name: tc.function && tc.function.name, args: args });
    });
    return out;
  },
  /* 流式累积完毕后，把字符串形式的参数统一 JSON.parse（Gemini / Ollama 本来就是对象，跳过） */
  finalizeStreamed(S) {
    S.toolCalls = (S.toolCalls || []).filter(Boolean).map((tc) => {
      if (tc.parsed) return tc;
      let args = {}; try { args = JSON.parse(tc.args || '{}'); } catch (e) { args = { __parse_error__: true, raw: tc.args }; }
      return { id: tc.id, name: tc.name, args: args };
    });
    return S.toolCalls;
  }
};

/* ---- 简单按行 Diff（Myers/LCS，无外部依赖）；超大文件跳过逐行对比 ---- */
function lineDiff(oldText, newText) {
  const a = oldText ? String(oldText).split('\n') : [];
  const b = newText ? String(newText).split('\n') : [];
  if (a.length > 2500 || b.length > 2500) return { tooLarge: true, oldLines: a.length, newLines: b.length };
  const n = a.length, m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: a[i] }); i++; }
    else { out.push({ t: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ t: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ t: 'add', text: b[j] }); j++; }
  return { tooLarge: false, lines: out };
}

/* ---- Agent 编排：任务循环、文件树、操作日志、Diff 确认弹窗 ----
 * 与 Draw 一样是“挂在共用 Net / Format 基础设施上的独立能力”：复用 Chat.busy /
 * Chat.ctrl 驱动发送区的“发送⇄停止”按钮和 Esc 停止快捷键，不重复实现一套忙碌状态。 */
const Agent = {
  MAX_STEPS: 20,
  curTab: 'tree',
  previewPath: null,
  runSteps: [],
  _diffResolve: null,
  STATUS_MAP: { run: ['run', '执行中'], wait: ['wait', '待确认'], ok: ['ok', '完成'], err: ['err', '失败'], skip: ['skip', '已拒绝'] },
  ICON_MAP: { list_files: 'folder', read_file: 'file', search_files: 'search', create_file: 'diff', write_file: 'diff', create_directory: 'folder', delete_file: 'trash' },

  async init() {
    $('#btnAgent').addEventListener('click', () => this.toggleMode());
    $('#agentPanelClose').addEventListener('click', () => this.closePanel());
    $('#agScrim').addEventListener('click', () => this.closePanel());
    $('#agentBarExit').addEventListener('click', () => this.exitMode());
    $('#agentBarTree').addEventListener('click', () => { this.openPanel(); this.showTab('tree'); });
    $('#agentBarLog').addEventListener('click', () => { this.openPanel(); this.showTab('log'); });
    $$('#agTabs button').forEach((b) => b.addEventListener('click', () => this.showTab(b.getAttribute('data-agtab'))));
    $('#agChangeDir').addEventListener('click', () => {
      if (Chat.busy) return Toast.info('请先等待当前 Agent 任务完成，或点击停止');
      this.pickDirectory().then((ok) => { if (ok) { this.updateNames(); this.previewPath = null; $('#agPreview').hidden = true; this.renderTree(); } });
    });
    $('#agForgetDir').addEventListener('click', async () => {
      if (Chat.busy) return Toast.info('请先等待当前 Agent 任务完成，或点击停止');
      if (!(await Dialog.confirm('忘记该目录', '将清除本地保存的目录访问引用，下次使用 Agent 需要重新选择目录；不会删除或修改任何实际文件。', '忘记', true))) return;
      await AgentFS.forget();
      this.exitMode(); this.updateNames(); this.renderTree();
    });
    $('#agPvClose').addEventListener('click', () => { $('#agPreview').hidden = true; this.previewPath = null; });
    $('#agdApprove').addEventListener('click', () => this.closeDiff(true));
    $('#agdReject').addEventListener('click', () => this.closeDiff(false));
    $('#agentDiffOv').addEventListener('mousedown', (e) => { if (e.target.id === 'agentDiffOv') this.closeDiff(false); });

    if (AgentFS.supported()) { try { await AgentFS.restore(); } catch (e) { /* ignore */ } }
  },

  showUnsupported() {
    Dialog.alert('当前浏览器不支持 Coding Agent', 'Coding Agent 需要浏览器的 File System Access API 来直接读写本地文件，目前只有桌面版 Chrome / Edge 等 Chromium 内核浏览器支持这项能力，Firefox、Safari 以及所有移动端浏览器都不支持。请使用桌面版 Chrome 或 Edge 打开本页面后再试。');
  },
  async pickDirectory() {
    try { await AgentFS.pick(); Toast.ok('已授权目录：' + AgentFS.rootName); return true; }
    catch (e) {
      if (e && e.name === 'AbortError') return false;
      Toast.err('选择目录失败：' + (e && e.message ? e.message : String(e)));
      return false;
    }
  },
  updateNames() {
    const nm = AgentFS.rootName || '';
    const bar = $('#agentBarName'); if (bar) bar.textContent = nm;
    const head = $('#agHeadName'); if (head) head.textContent = nm ? ('Coding Agent · ' + nm) : 'Coding Agent';
  },

  async toggleMode() {
    if (Composer.agentMode) { this.exitMode(); return; }
    if (!AgentFS.supported()) { this.showUnsupported(); return; }
    if (Chat.busy) { Toast.info('请先等待当前任务完成，或点击停止'); return; }
    Composer.toggleDraw(false);
    if (!AgentFS.root) { if (!(await this.pickDirectory())) return; }
    else {
      const ok = await AgentFS.requestPermission('readwrite');
      if (!ok) { Toast.err('未获得该目录的访问权限'); return; }
    }
    Composer.agentMode = true;
    $('#btnAgent').classList.add('agent-on');
    $('#agentBar').hidden = false;
    this.updateNames();
    View.updateHeader();
    this.openPanel(); this.renderTree();
    Composer.focus();
  },
  exitMode() {
    Composer.agentMode = false;
    $('#btnAgent').classList.remove('agent-on');
    $('#agentBar').hidden = true;
    View.updateHeader();
    this.closePanel();
  },

  openPanel() { const app = $('#app'); app.classList.add(App.isMobile() ? 'agentDrawer' : 'agentOpen'); },
  closePanel() { $('#app').classList.remove('agentDrawer', 'agentOpen'); },
  showTab(tab) {
    this.curTab = tab;
    $$('#agTabs button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-agtab') === tab));
    $$('.ag-pane').forEach((p) => p.classList.toggle('on', p.getAttribute('data-agpane') === tab));
  },

  /* ---------- 文件树 ---------- */
  renderTree() {
    this.updateNames();
    const box = $('#agTreeBox'); if (!box) return;
    box.textContent = '';
    if (!AgentFS.root) {
      box.appendChild(el('div', { class: 'ag-empty' }, '尚未选择项目目录'));
      box.appendChild(el('button', { class: 'ag-dirbtn', type: 'button', onclick: () => this.pickDirectory().then((ok) => { if (ok) { this.updateNames(); this.renderTree(); } }) }, icon('folder-open'), '选择项目目录'));
      $('#agFoot').hidden = true;
      return;
    }
    $('#agFoot').hidden = false;
    this._loadLevel('', box, 0);
  },
  _loadLevel(path, container, depth) {
    return AgentFS.listDir(path).then((entries) => {
      if (!entries.length) { if (depth === 0) container.appendChild(el('div', { class: 'ag-empty', text: '（空目录）' })); return; }
      entries.forEach((entry) => {
        const row = el('div', { class: 'tree-row', style: { paddingLeft: (depth * 14 + 6) + 'px' } },
          entry.kind === 'dir' ? icon('chev', 'sm tw') : el('span', { class: 'tw' }),
          icon(entry.kind === 'dir' ? 'folder' : 'file'),
          el('span', { class: 'nm', text: entry.name }));
        container.appendChild(row);
        if (entry.kind === 'dir') {
          const kids = el('div', { class: 'tree-kids' }); kids.hidden = true;
          container.appendChild(kids);
          let loaded = false;
          row.addEventListener('click', () => {
            const open = row.classList.toggle('open');
            kids.hidden = !open;
            if (open && !loaded) { loaded = true; this._loadLevel(entry.path, kids, depth + 1); }
          });
        } else {
          row.addEventListener('click', () => this.previewFile(entry.path, row));
        }
      });
    }).catch((e) => { container.appendChild(el('div', { class: 'ag-empty', text: '读取失败：' + e.message })); });
  },
  async previewFile(path, rowNode) {
    $$('.tree-row.active', $('#agTreeBox')).forEach((n) => n.classList.remove('active'));
    if (rowNode) rowNode.classList.add('active');
    this.previewPath = path;
    $('#agPreview').hidden = false;
    $('#agPvName').textContent = path;
    const code = $('#agPvCode');
    code.textContent = '加载中…';
    try {
      const r = await AgentFS.readFile(path);
      if (r.binary) { code.textContent = '（二进制文件，' + fmtSize(r.size) + '，无法预览）'; return; }
      const ext = path.indexOf('.') >= 0 ? path.split('.').pop() : '';
      code.innerHTML = Hl(r.text, ext) + (r.truncated ? '\n\n…（文件较大，仅预览前一部分）' : '');
    } catch (e) { code.textContent = '读取失败：' + e.message; }
  },

  /* ---------- Diff 确认弹窗 ---------- */
  confirmChange(preview) {
    return new Promise((resolve) => {
      this._diffResolve = resolve;
      this.renderDiffModal(preview);
      $('#agentDiffOv').hidden = false;
    });
  },
  closeDiff(result) {
    $('#agentDiffOv').hidden = true;
    const r = this._diffResolve; this._diffResolve = null;
    if (r) r(!!result);
  },
  renderDiffModal(preview) {
    const KIND = { create: ['新建文件', 'new', 'NEW'], modify: ['修改文件', 'mod', 'MODIFY'], delete: ['删除文件', 'del', 'DELETE'] };
    const info = KIND[preview.kind] || ['变更', 'mod', 'MODIFY'];
    $('#agdTitle').textContent = info[0] + '确认';
    const okBtn = $('#agdApprove');
    okBtn.textContent = preview.kind === 'delete' ? '确认删除' : '确认执行';
    okBtn.className = 'btn ' + (preview.kind === 'delete' ? 'danger fill' : 'primary');
    const body = $('#agdBody'); body.textContent = '';
    const wrap = el('div', { class: 'diffwrap' });
    wrap.appendChild(el('div', { class: 'diff-file' }, el('span', { class: 'tag ' + info[1], text: info[2] }), el('span', { text: preview.path })));
    const dbody = el('div', { class: 'diff-body' });
    if (preview.beforeBinary) {
      dbody.appendChild(el('div', { class: 'dline big', text: '这是一个二进制文件，无法显示文本差异。' }));
    } else {
      const d = lineDiff(preview.before || '', preview.after || '');
      if (d.tooLarge) {
        dbody.appendChild(el('div', { class: 'dline big', text: '文件较大（' + d.oldLines + ' → ' + d.newLines + ' 行），未生成逐行 Diff，请确认改动符合预期后再执行。' }));
      } else {
        const CTX = 3;
        let shown = 0;
        d.lines.forEach((ln, i) => {
          if (ln.t === 'ctx') {
            let near = false;
            for (let k = Math.max(0, i - CTX); k <= Math.min(d.lines.length - 1, i + CTX); k++) if (d.lines[k].t !== 'ctx') { near = true; break; }
            if (!near) return;
          }
          shown++;
          if (shown > 1400) return;
          dbody.appendChild(el('div', { class: 'dline ' + (ln.t === 'add' ? 'add' : ln.t === 'del' ? 'del' : '') },
            el('span', { class: 'gut', text: ln.t === 'add' ? '+' : ln.t === 'del' ? '-' : ' ' }),
            el('span', { class: 'tx', text: ln.text })));
        });
        if (shown > 1400) dbody.appendChild(el('div', { class: 'dline big', text: '（差异过多，仅显示部分）' }));
      }
    }
    wrap.appendChild(dbody);
    body.appendChild(wrap);
    if (preview.kind === 'delete') body.appendChild(el('div', { class: 'agent-danger' }, icon('alert'), el('span', { text: '此操作将从磁盘上永久删除该文件，无法通过本应用撤销，请确认后再继续。' })));
  },

  /* ---------- 操作日志（当前这次运行的实时视图） ---------- */
  cap(s) { s = String(s == null ? '' : s); return s.length > 3000 ? s.slice(0, 3000) + '\n…（日志展示已截断，完整内容已提供给模型）' : s; },
  summarize(name, args) {
    const p = args && args.path;
    const map = { list_files: '列出目录', read_file: '读取文件', search_files: '搜索 "' + ((args && args.query) || '') + '"', create_file: '创建文件', write_file: '修改文件', create_directory: '创建目录', delete_file: '删除文件' };
    return (map[name] || name) + (p ? '：' + p : '');
  },
  logNote(text) {
    const box = $('#agLogBox'); if (!box) return;
    box.appendChild(el('div', { class: 'astep', style: { background: 'transparent', border: '0', marginBottom: '6px' } },
      el('div', { class: 'astep-h', style: { cursor: 'default' } }, icon('chat'), el('span', { class: 'tt', style: { whiteSpace: 'normal', fontFamily: 'var(--font)' }, text: text }))));
    if (this.curTab === 'log') box.scrollTop = box.scrollHeight;
  },
  renderStep(step) {
    const box = $('#agLogBox'); if (!box) return;
    const st = this.STATUS_MAP[step.status] || ['run', ''];
    if (!step._node) {
      const h = el('div', { class: 'astep-h', onclick: () => step._node.classList.toggle('open') },
        icon(this.ICON_MAP[step.tool] || 'agent'), el('span', { class: 'tt' }), el('span', { class: 'st' }));
      const b = el('div', { class: 'astep-b' });
      step._node = el('div', { class: 'astep' }, h, b);
      step._tt = h.querySelector('.tt'); step._badge = h.querySelector('.st'); step._body = b;
      box.appendChild(step._node);
    }
    step._tt.textContent = step.summary;
    step._badge.className = 'st ' + st[0]; step._badge.textContent = st[1];
    step._body.textContent = '';
    if (step.detail) step._body.appendChild(el('pre', { text: step.detail }));
    if (this.curTab === 'log') box.scrollTop = box.scrollHeight;
  },

  /* ---------- 执行单次工具调用（含变更类确认流程） ---------- */
  async runOneTool(tc) {
    const name = tc.name, args = isObj(tc.args) ? tc.args : {};
    const step = { id: uid(), tool: name, summary: this.summarize(name, args), status: 'run', detail: '' };
    this.runSteps.push(step); this.renderStep(step);
    if (args.__parse_error__) { step.status = 'err'; step.detail = '模型返回的参数不是合法 JSON'; this.renderStep(step); return '工具调用参数不是合法的 JSON，请重新生成这次工具调用，并确保参数是合法 JSON 对象。'; }
    const def = AgentTools.find(name);
    if (!def) { step.status = 'err'; step.detail = '不存在的工具'; this.renderStep(step); return '不存在名为 "' + name + '" 的工具。可用工具：' + AgentTools.LIST.map((t) => t.name).join(', '); }
    const missing = (def.parameters.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) { step.status = 'err'; step.detail = '缺少必填参数：' + missing.join(', '); this.renderStep(step); return '调用 ' + name + ' 缺少必填参数：' + missing.join(', ') + '。'; }
    try {
      if (AgentTools.MUTATING[name]) {
        const preview = await AgentTools.preview(name, args);
        if (preview.willFail) { step.status = 'err'; step.detail = '文件已存在：' + args.path; this.renderStep(step); return '创建失败：文件已存在 "' + args.path + '"。如需修改该文件，请改用 write_file。'; }
        step.status = 'wait'; this.renderStep(step);
        const ok = await this.confirmChange(preview);
        if (!ok) { step.status = 'skip'; step.detail = '用户拒绝了该操作'; this.renderStep(step); return '用户拒绝了这次' + (name === 'delete_file' ? '删除' : '文件修改') + '操作（' + args.path + '）。请根据情况调整方案，不要重复请求同一个改动。'; }
        step.status = 'run'; this.renderStep(step);
        const okText = await AgentTools.commit(name, args);
        step.status = 'ok'; step.detail = okText; this.renderStep(step);
        this.renderTree();
        if (this.previewPath === args.path) this.previewFile(args.path);
        return okText;
      }
      const r = await AgentTools.runReadOnly(name, args);
      step.status = 'ok'; step.detail = this.cap(r.text); this.renderStep(step);
      if (name === 'create_directory') this.renderTree();
      return r.text;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      step.status = 'err'; step.detail = msg; this.renderStep(step);
      return '执行失败：' + msg;
    }
  },

  /* ---------- 流式 / 非流式响应消费：文本沿用 Format 既有解析，工具调用走 AgentFormat ---------- */
  paintCommentary(h, S) {
    const text = splitThink(S.content).content || '';
    if (!text) return;
    const html = Md.render(text, true);
    if (html !== h.html) { h.body.innerHTML = html; h.html = html; }
  },
  feedLine(line, fmt, S) {
    line = line.trim();
    if (!line || line.charAt(0) === ':' || /^(event|id|retry):/.test(line)) return;
    if (line.indexOf('data:') === 0) line = line.slice(5).trim();
    if (line === '[DONE]') { S.ended = true; return; }
    const c = line.charAt(0);
    if (c !== '{' && c !== '[') return;
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    const apply = (x) => {
      const d = Format.delta(fmt, x); if (d) S.content += d;
      AgentFormat.feedToolDelta(fmt, S, x);
      const u = Format.streamUsage(fmt, x); if (u) S.usage = mergeUsage(S.usage, u);
      const fr = Format.streamFinish(fmt, x); if (fr) S.finish = fr;
    };
    if (Array.isArray(j)) j.forEach(apply); else apply(j);
  },
  async consume(resp, fmt, S, onDelta, ctrl) {
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const isStream = ct.indexOf('event-stream') >= 0 || ct.indexOf('ndjson') >= 0;
    if (isStream && resp.body) {
      const reader = resp.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        let r;
        try { r = await reader.read(); } catch (e) { break; }
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { this.feedLine(buf.slice(0, i), fmt, S); buf = buf.slice(i + 1); }
        onDelta();
      }
      buf += dec.decode();
      if (buf.trim()) this.feedLine(buf, fmt, S);
      onDelta();
      return;
    }
    const raw = await resp.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { /* ignore */ }
    if (json) {
      S.content = Format.content(fmt, json) || '';
      S.toolCalls = AgentFormat.extractToolCalls(fmt, json).map((tc) => { tc.parsed = true; return tc; });
      S.finish = Format.finishReason(fmt, json);
      S.usage = Format.usage(fmt, json);
      S.ended = true;
    }
    onDelta();
  },

  sysPrompt() {
    return '你是一个可以直接操作本地项目文件的 Coding Agent。项目根目录名为 "' + AgentFS.rootName + '"，你只能通过提供的工具读写这个目录内部的文件，无法访问该目录之外的任何位置，也没有终端命令、网络访问等其它能力。' +
      'node_modules、.git、dist、build、.cache 等构建产物 / 依赖目录，以及 .env 等敏感文件已被自动排除，不会出现在 list_files / search_files 的结果里，不需要关心它们。' +
      '工作方式：先用 list_files / search_files 了解相关结构，再用 read_file 查看要修改的文件，避免凭空猜测内容；修改已存在文件用 write_file（需提供整份新内容），新建文件用 create_file。create_file / write_file / delete_file 执行前都会向用户展示预览并等待确认，用户可能拒绝，如果被拒绝，请根据情况调整方案，不要重复请求同一个改动。' +
      '每次只做少量、聚焦的操作；回复中不要输出大段内部推理过程，只需要简要说明在做什么、以及任务完成后的简明总结。';
  },

  async send(text) {
    const msg = Sessions.add('user', text, { agent: true });
    View.thread.appendChild(View.userNode(msg));
    View.updateEmpty(); View.stick = true; View.scroll(true);
    await this.run(text);
  },

  async run(taskText) {
    if (Chat.busy) return;
    const api = Api.current();
    this.runSteps = [];
    const logBox = $('#agLogBox'); if (logBox) logBox.textContent = '';
    this.showTab('log'); this.openPanel();

    const ctrl = new AbortController();
    ctrl.signal.addEventListener('abort', () => this.closeDiff(false));
    Chat.ctrl = ctrl; Chat.setBusy(true);

    const flags = Quirks.get(api), flags0 = JSON.stringify(flags);
    const history = [{ role: 'user', text: taskText }];
    const priorCtx = Sessions.context(Math.min(Settings.get('ctx'), 16));
    const bg = priorCtx.slice(0, -1).map((m) => (m.role === 'user' ? '用户：' : '助手：') + Sessions.textOf(m.content)).filter(Boolean).slice(-10).join('\n');
    const system = this.sysPrompt() + (bg ? ('\n\n以下是此前的对话背景，仅供参考：\n' + bg) : '');

    const h = View.createStream(api.model);
    View.stick = true; View.scroll(true);

    let finalText = '', stopped = false, errorMsg = '';
    for (let step = 0; step < this.MAX_STEPS; step++) {
      if (ctrl.signal.aborted) { stopped = true; break; }
      let S = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const fmt = Format.of(api);
        const wantStream = Settings.get('stream') && !flags.noStream;
        const body = AgentFormat.body(api, { system: system, history: history, temperature: 0.4, maxTokens: Settings.get('maxTokens') || 8192, stream: wantStream, flags: flags });
        let resp;
        try {
          resp = await Net.call(Format.endpoint(fmt, api, wantStream), {
            method: 'POST', headers: Format.headers(fmt, api, wantStream), body: JSON.stringify(body),
            signal: ctrl.signal, timeoutMs: Settings.get('timeout') * 1000, retries: 2, route: api.route
          });
        } catch (e) {
          if (ctrl.signal.aborted || (e && e.kind === 'abort')) { stopped = true; } else { errorMsg = Chat.errorText(e, api); }
          break;
        }
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          if (Quirks.adapt(resp.status, t, flags, { deep: false, stage: 0 }) && attempt < 5) continue;
          errorMsg = Chat.errorText(httpError(resp.status, t), api);
          break;
        }
        S = { content: '', reasoning: '', toolCalls: [], finish: null, ended: false, usage: null };
        await this.consume(resp, fmt, S, () => this.paintCommentary(h, S), ctrl);
        if (ctrl.signal.aborted) stopped = true;
        if (S.usage) Token.add(S.usage, api.model);
        break;
      }
      if (!S || stopped || errorMsg) break;

      const calls = AgentFormat.finalizeStreamed(S);
      const text = (splitThink(S.content).content || S.content || '').trim();
      if (!calls.length) { finalText = text; break; }

      history.push({ role: 'assistant', text: text, toolCalls: calls });
      if (text) this.logNote(text);

      for (let k = 0; k < calls.length; k++) {
        if (ctrl.signal.aborted) { stopped = true; break; }
        const resultText = await this.runOneTool(calls[k]);
        history.push({ role: 'tool', toolCallId: calls[k].id, name: calls[k].name, text: resultText });
      }
      if (stopped) break;
      if (step === this.MAX_STEPS - 1) finalText = '已达到本次任务最多 ' + this.MAX_STEPS + ' 步操作，先在这里停下。如需继续，请再发一条消息接着做。';
    }
    if (JSON.stringify(flags) !== flags0) Quirks.save(api, flags);

    View.finishStream(h);
    h.root.remove();
    const meta = { model: api.model, ts: Date.now(), agent: true, dir: AgentFS.rootName, steps: this.runSteps.map((s) => ({ tool: s.tool, status: s.status, summary: s.summary, detail: s.detail })).slice(0, 200) };
    let content;
    if (errorMsg) { content = errorMsg; meta.error = true; }
    else if (stopped && !finalText) { content = '已停止 Agent。'; meta.stopped = true; }
    else content = finalText || '（没有更多可执行的操作。）';
    const msg = Sessions.add('assistant', content, meta);
    View.thread.appendChild(View.aiNode(msg, true));
    Chat.ctrl = null; Chat.setBusy(false);
    Chat.refreshActions(); Sessions.later.flush(); View.renderSessions(); View.scroll(); Composer.focus();
  },

  /* 供 View.aiNode 调用：把持久化下来的步骤日志渲染成聊天气泡里的折叠摘要 */
  renderStepsSummary(steps, dirName) {
    const box = el('div', { class: 'agent-sum' });
    const okCount = steps.filter((s) => s.status === 'ok').length;
    const h = el('div', { class: 'agent-sum-h', onclick: () => box.classList.toggle('open') },
      icon('agent'), el('b', { text: 'Agent' + (dirName ? '（' + dirName + '）' : '') }), el('span', { class: 'cnt', text: '· ' + steps.length + ' 步操作，' + okCount + ' 项完成' }));
    const body = el('div', { class: 'agent-sum-b' });
    steps.forEach((step) => {
      const st = this.STATUS_MAP[step.status] || ['ok', ''];
      const row = el('div', { class: 'astep' });
      const rh = el('div', { class: 'astep-h', onclick: (e) => { e.stopPropagation(); row.classList.toggle('open'); } },
        icon(this.ICON_MAP[step.tool] || 'agent'), el('span', { class: 'tt', text: step.summary }), el('span', { class: 'st ' + st[0], text: st[1] }));
      const rb = el('div', { class: 'astep-b' });
      if (step.detail) rb.appendChild(el('pre', { text: step.detail }));
      row.appendChild(rh); row.appendChild(rb);
      body.appendChild(row);
    });
    box.appendChild(h); box.appendChild(body);
    return box;
  }
};



/* ==========================================================================
 * 07 设置面板：API 管理 / 连接诊断 / 对话 / 图像生成 / 外观 / 数据
 * ========================================================================== */
const TAB_TITLES = { api: '模型与 API', chat: '对话', draw: '图像生成', look: '外观', data: '数据与同步' };

/* ---------- 温度调节：圆角矩形滑块（拖动时颜色随数值渐变） ---------- */
const TempSlider = {
  // [位置 0~1, 色相, 饱和度%, 亮度%]：冷蓝 → 青绿 → 琥珀 → 红
  STOPS: [[0, 214, 88, 58], [0.35, 158, 56, 42], [0.68, 40, 94, 50], [1, 4, 82, 56]],
  LEVELS: [
    [0.3, '精确', '输出最稳定、可复现，适合代码、翻译与事实问答'],
    [0.9, '均衡', '兼顾准确与自然，适合日常对话（推荐）'],
    [1.4, '灵活', '表达更多样，适合写作与头脑风暴'],
    [99, '发散', '随机性很高，创意十足，但可能偏题或不连贯']
  ],
  color(t) {
    const S = this.STOPS;
    t = clamp(t, 0, 1);
    let i = 0;
    while (i < S.length - 2 && t > S[i + 1][0]) i++;
    const a = S[i], b = S[i + 1], k = (t - a[0]) / (b[0] - a[0]);
    const h = a[1] + (b[1] - a[1]) * k, s = a[2] + (b[2] - a[2]) * k, l = a[3] + (b[3] - a[3]) * k;
    return 'hsl(' + h.toFixed(1) + ',' + s.toFixed(1) + '%,' + l.toFixed(1) + '%)';
  },
  level(v) {
    for (let i = 0; i < this.LEVELS.length; i++) if (v < this.LEVELS[i][0]) return this.LEVELS[i];
    return this.LEVELS[this.LEVELS.length - 1];
  },
  init() {
    const inp = $('#sTemp'), box = $('#tmpBox');
    if (!inp || !box) return;
    const on = () => box.classList.add('drag');
    const off = () => box.classList.remove('drag');
    inp.addEventListener('pointerdown', on);
    inp.addEventListener('blur', off);
    window.addEventListener('pointerup', off, true);
    window.addEventListener('pointercancel', off, true);
    this.sync();
  },
  // 读取 #sTemp 的当前值，刷新填充长度、颜色、数值与档位说明（拖动、键盘、程序赋值后都调用）
  sync() {
    const inp = $('#sTemp'), f = $('#tmpField');
    if (!inp || !f) return;
    const v = clamp(parseFloat(inp.value) || 0, 0, 2), t = v / 2, lv = this.level(v);
    f.style.setProperty('--tp', String(t));
    f.style.setProperty('--tc', this.color(t));
    $('#sTempV').textContent = v.toFixed(1);
    $('#sTempT').textContent = lv[1];
    $('#sTempH').textContent = lv[2];
    inp.setAttribute('aria-valuetext', v.toFixed(1) + '（' + lv[1] + '）');
  }
};

const Settings2 = {
  tab: 'api', editIdx: 0, keyShown: false,

  init() {
    $('#sClose').addEventListener('click', () => this.close());
    $('#settingsOv').addEventListener('mousedown', (e) => { if (e.target.id === 'settingsOv') this.close(); });
    $$('#sNav button').forEach((b) => b.addEventListener('click', () => this.show(b.getAttribute('data-tab'))));

    // API
    $('#apiAdd').addEventListener('click', () => this.newDraft());
    $('#apiSave').addEventListener('click', () => this.saveApi());
    $('#apiUse').addEventListener('click', () => this.useApi());
    $('#apiDel').addEventListener('click', () => this.delApi());
    $('#apiTest').addEventListener('click', () => this.testApi());
    $('#fDetect').addEventListener('click', () => this.detectModels());
    $('#fKeyEye').addEventListener('click', () => { this.keyShown = !this.keyShown; $('#fKey').type = this.keyShown ? 'text' : 'password'; });
    $('#fFormat').addEventListener('change', () => this.onFormat());
    $('#fUrl').addEventListener('change', () => {
      const g = Format.guess($('#fUrl').value);
      if (g !== 'openai' && $('#fFormat').value === 'openai') { $('#fFormat').value = g; this.onFormat(); }
    });

    // 对话
    $('#sSystem').addEventListener('change', () => SystemPrompt.set($('#sSystem').value));
    $('#sCtx').addEventListener('change', (e) => Settings.set('ctx', +e.target.value));
    TempSlider.init();
    $('#sTemp').addEventListener('input', () => TempSlider.sync());
    $('#sTemp').addEventListener('change', (e) => Settings.set('temp', +e.target.value));
    $('#sMax').addEventListener('change', (e) => Settings.set('maxTokens', +e.target.value));
    $('#sTimeout').addEventListener('change', (e) => Settings.set('timeout', +e.target.value));
    $('#sStream').addEventListener('change', (e) => Settings.set('stream', e.target.checked));
    $('#sShowThink').addEventListener('change', (e) => { Settings.set('showThink', e.target.checked); View.renderThread(); });
    $('#sFileGen').addEventListener('change', (e) => Settings.set('fileGen', e.target.checked));

    // 画图
    $('#dSave').addEventListener('click', () => {
      const url = $('#dUrl').value.trim(), model = $('#dModel').value.trim();
      if (!url || !model) return Toast.err('请填写画图 API 地址和模型');
      Draw.save({ url, key: $('#dKey').value.trim(), model, size: $('#dSize').value, format: $('#dFormat').value });
      Toast.ok('画图 API 已保存');
    });

    // 外观
    $$('#segTheme button').forEach((b) => b.addEventListener('click', () => { Settings.set('theme', b.getAttribute('data-v')); Settings.apply(); this.loadLook(); }));
    $$('#segFont button').forEach((b) => b.addEventListener('click', () => { Settings.set('fontSize', b.getAttribute('data-v')); Settings.apply(); this.loadLook(); }));

    // 数据
    $('#dtExportTxt').addEventListener('click', () => Chat.exportCurrent());
    $('#dtBackup').addEventListener('click', () => Backup.exportAll());
    $('#dtRestore').addEventListener('click', () => $('#fileBackup').click());
    $('#fileBackup').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) Backup.restore(f); });
    $('#dtResetStat').addEventListener('click', () => { Token.reset(); this.loadData(); Toast.info('用量统计已重置'); });
    $('#dtClear').addEventListener('click', async () => {
      if (Chat.busy) return Toast.info('请先停止当前生成');
      if (await Dialog.confirm('清除全部会话', '所有对话记录将被永久删除，此操作无法撤销。建议先备份。', '全部清除', true)) {
        Sessions.clearAll(); View.renderThread(); View.renderSessions(); this.loadData(); Toast.info('已清除全部会话');
      }
    });
    $('#syOn').addEventListener('change', (e) => Sync.toggle(e.target.checked));
    $('#syPass').addEventListener('change', (e) => Sync.setPass(e.target.value));
    $('#syGen').addEventListener('click', () => Sync.genPass());
    $('#syKeys').addEventListener('change', (e) => Sync.setKeys(e.target.checked));
    $('#syNow').addEventListener('click', () => Sync.now());
  },

  open(tab) {
    $('#settingsOv').hidden = false;
    this.editIdx = Api.list.length ? Api.idx : -1;
    this.loadAll();
    this.show(tab || this.tab);
    document.addEventListener('keydown', this._esc, true);
  },
  _esc(e) { if (e.key === 'Escape' && $('#dialogOv').hidden && !Pop.node) { e.stopPropagation(); Settings2.close(); } },
  close() {
    $('#settingsOv').hidden = true;
    document.removeEventListener('keydown', this._esc, true);
    View.updateHeader();
  },
  show(tab) {
    this.tab = tab;
    $$('#sNav button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === tab));
    $$('.s-pane').forEach((p) => p.classList.toggle('on', p.getAttribute('data-pane') === tab));
    $('#sTitle').textContent = TAB_TITLES[tab] || '设置';
    if (tab === 'data') this.loadData();
  },
  loadAll() { this.renderApiList(); this.loadForm(); this.loadChat(); this.loadDraw(); this.loadLook(); },

  /* ---------- API ---------- */
  renderApiList() {
    const box = $('#apiList'); box.textContent = '';
    Api.list.forEach((a, i) => {
      const on = i === this.editIdx;
      box.appendChild(el('button', { class: 'pitem' + (on ? ' on' : ''), type: 'button', onclick: () => { this.editIdx = i; this.renderApiList(); this.loadForm(); } },
        el('div', { class: 'tt' }, el('b', { text: a.name || '未命名 API' }), el('span', { text: (a.model || '未设置模型') + ' · ' + Format.short(Format.of(a)) })),
        i === Api.idx ? el('span', { class: 'tag cur', text: '当前' }) : null));
    });
    if (this.editIdx === -1) box.appendChild(el('div', { class: 'pitem on' }, el('div', { class: 'tt' }, el('b', { text: '新的 API' }), el('span', { text: '填写下方信息后保存' }))));
  },
  newDraft() { this.editIdx = -1; this.renderApiList(); this.loadForm(); $('#fName').focus(); },
  loadForm() {
    const a = this.editIdx >= 0 ? Api.list[this.editIdx] : null;
    $('#fName').value = a ? a.name : '';
    $('#fUrl').value = a ? a.url : '';
    $('#fKey').value = a ? a.key : '';
    $('#fFormat').value = a ? Format.of(a) : 'openai';
    $('#fRoute').value = a ? (a.route || 'auto') : 'auto';
    $('#fModel').value = a ? a.model : '';
    $('#fHeaders').value = a && a.headers ? (typeof a.headers === 'string' ? a.headers : JSON.stringify(a.headers)) : '';
    $('#apiDel').hidden = this.editIdx < 0;
    $('#apiUse').hidden = this.editIdx < 0 || this.editIdx === Api.idx;
    $('#apiDiag').hidden = true;
    this.fillModels();
    this.onFormat(true);
  },
  fillModels() {
    const dl = $('#modelOptions'); dl.textContent = '';
    Api.detected.slice().sort().forEach((m) => dl.appendChild(el('option', { value: m })));
    $('#fDetectHint').textContent = Api.detected.length ? '已检测到 ' + Api.detected.length + ' 个模型，点击模型输入框可从列表中选择。' : '点击“检测模型”自动获取可用模型；也可以直接手动填写。';
  },
  onFormat() {
    const f = Format.normalize($('#fFormat').value);
    const tips = {
      openai: ['https://api.openai.com/v1/chat/completions', 'gpt-4o', '支持完整地址，或只填站点根地址 / …/v1。适用于 OpenAI 及绝大多数中转站、DeepSeek、通义、智谱等兼容接口。'],
      anthropic: ['https://api.anthropic.com', 'claude-sonnet-4-5', '填写站点根地址或 …/v1/messages 均可。'],
      gemini: ['https://generativelanguage.googleapis.com', 'gemini-2.5-flash', '填写站点根地址即可，系统会自动拼接 /v1beta/models/模型:generateContent。'],
      ollama: ['http://localhost:11434', 'llama3.1', '本机 Ollama 需设置 OLLAMA_ORIGINS="*" 后由浏览器直连。']
    }[f];
    $('#fUrl').placeholder = tips[0]; $('#fModel').placeholder = tips[1]; $('#fUrlHint').textContent = tips[2];
  },
  readForm() {
    let headers = $('#fHeaders').value.trim();
    if (headers) { try { const o = JSON.parse(headers); if (!isObj(o)) throw 0; } catch (e) { Toast.err('自定义请求头必须是 JSON 对象，例如 {"api-key":"…"}'); return null; } }
    return { name: $('#fName').value.trim() || '未命名 API', url: $('#fUrl').value.trim(), key: $('#fKey').value.trim(), format: Format.normalize($('#fFormat').value), route: $('#fRoute').value, model: $('#fModel').value.trim(), headers };
  },
  validate(c) {
    if (!c.url) { Toast.err('请填写 API 地址'); return false; }
    try { const u = new URL(c.url); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw 0; } catch (e) { Toast.err('API 地址需以 http:// 或 https:// 开头'); return false; }
    return true;
  },
  saveApi() {
    const c = this.readForm(); if (!c || !this.validate(c)) return;
    if (!c.model) return Toast.err('请填写模型名称');
    if (this.editIdx === -1) { Api.add(c); this.editIdx = Api.idx; Toast.ok('已添加并设为当前 API'); }
    else { Api.update(this.editIdx, c); Toast.ok('已保存'); }
    this.renderApiList(); this.loadForm(); View.updateHeader();
  },
  useApi() { if (this.editIdx < 0) return; Api.use(this.editIdx); this.renderApiList(); this.loadForm(); View.updateHeader(); Toast.ok('已设为当前 API'); },
  async delApi() {
    if (this.editIdx < 0) return;
    const a = Api.list[this.editIdx];
    if (!(await Dialog.confirm('删除 API', '将删除“' + (a.name || '未命名') + '”的配置。', '删除', true))) return;
    Api.remove(this.editIdx);
    this.editIdx = Api.list.length ? Api.idx : -1;
    this.renderApiList(); this.loadForm(); View.updateHeader();
  },

  async detectModels() {
    const c = this.readForm(); if (!c || !this.validate(c)) return;
    const btn = $('#fDetect'), hint = $('#fDetectHint');
    btn.disabled = true; btn.textContent = '检测中…'; hint.textContent = '正在获取模型列表…';
    const fmt = c.format;
    const eps = Format.modelEndpoints(fmt, c.url, c.key);
    let models = null, lastStatus = 0, lastErr = null;
    const headers = Format.headers(fmt, c, false); delete headers['Content-Type'];
    for (let i = 0; i < eps.length && !models; i++) {
      try {
        let ep = eps[i];
        const h = Object.assign({}, headers);
        if (fmt === 'gemini' && c.key) ep += (ep.indexOf('?') > 0 ? '&' : '?') + 'key=' + encodeURIComponent(c.key) + '&pageSize=200';
        if (ep.indexOf('/compatible-mode/') >= 0) { delete h['x-api-key']; delete h['anthropic-version']; delete h['anthropic-dangerous-direct-browser-access']; if (c.key) h.Authorization = 'Bearer ' + c.key; }
        const r = await Net.call(ep, { method: 'GET', headers: h, timeoutMs: 12000, retries: 0, route: c.route });
        lastStatus = r.status;
        if (r.ok) { const list = Format.parseModels(fmt, await r.json().catch(() => null)); if (list.length) models = list; }
      } catch (e) { lastErr = e; }
    }
    btn.disabled = false; btn.textContent = '检测模型';
    if (!models) {
      hint.textContent = fmt === 'anthropic' ? '该接入点没有提供模型列表接口（部分网关仅支持对话接口），不影响对话，请直接手动填写模型名称。' : (lastStatus ? '获取失败（HTTP ' + lastStatus + '）：请检查地址与 Key，或直接手动填写模型名称。' : '获取失败：' + (lastErr ? Net.explain(lastErr, c.url).split('\n')[0] : '未知错误'));
      return;
    }
    Api.setDetected(models); this.fillModels();
    if (!$('#fModel').value.trim()) $('#fModel').value = models[0];
    hint.textContent = '已检测到 ' + models.length + ' 个模型，点击模型输入框可从列表中选择。';
    Toast.ok('检测到 ' + models.length + ' 个模型');
  },

  /* 连接诊断：分别测试“浏览器直连”和“站内代理” */
  async testApi() {
    const c = this.readForm(); if (!c || !this.validate(c)) return;
    if (!c.model) return Toast.err('请先填写模型名称再测试');
    const box = $('#apiDiag'); box.hidden = false; box.textContent = '';
    const line = (kind, text, sub) => { const n = el('div', { class: 'ln ' + kind }, icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : 'chev', 'sm'), el('div', null, text, sub ? el('small', { text: sub }) : null)); box.appendChild(n); return n; };
    const btn = $('#apiTest'); btn.disabled = true;
    const flags = Quirks.get(c);
    const probe = async (route) => {
      const t0 = performance.now();
      const st = { deep: false, stage: 0 };
      for (let k = 0; k < 4; k++) {
        const req = Format.request(c, { messages: [{ role: 'user', content: '请只回复 OK' }], stream: false, temperature: 0, maxTokens: 24, flags });
        try {
          const r = await Net.request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), timeoutMs: 25000, route });
          const text = await r.text();
          if (!r.ok && Quirks.adapt(r.status, text, flags, st)) continue;
          return { reach: true, status: r.status, ms: Math.round(performance.now() - t0), text, ok: r.ok, fmt: req.format };
        } catch (e) { return { reach: false, ms: Math.round(performance.now() - t0), err: e }; }
      }
      return { reach: true, status: 400, ms: Math.round(performance.now() - t0), text: '', ok: false };
    };
    const describe = (label, r) => {
      if (!r.reach) return line('bad', label + '：无法连接（' + r.ms + ' ms）', r.err && r.err.kind === 'timeout' ? '请求超时' : (label === '浏览器直连' ? '被浏览器拦截（CORS / 网络 / 混合内容）' : (r.err.message || '')));
      if (r.ok) {
        let reply = ''; try { reply = Format.content(r.fmt, JSON.parse(r.text)); } catch (e) { /* ignore */ }
        return line('ok', label + '：连接成功（' + r.ms + ' ms）', reply ? '模型回复：' + reply.trim().slice(0, 60) : '');
      }
      return line(r.status === 401 || r.status === 403 ? 'bad' : 'info', label + '：服务可达，但返回 HTTP ' + r.status + '（' + r.ms + ' ms）', (Net.friendly(r.status) || '') + ' ' + extractErrorText(r.text));
    };
    line('info', '正在测试 ' + Format.short(c.format) + ' 接口…');
    const priv = Net.isPrivateHost(c.url);
    const d = c.route === 'relay' ? null : await probe('direct');
    let r = null;
    if (c.route !== 'direct' && !priv) r = await probe('relay');
    box.textContent = '';
    if (d) describe('浏览器直连', d);
    if (r) describe('站内代理', r);
    if (priv && c.route !== 'direct') line('info', '站内代理：内网 / 本机地址无法经代理访问，已跳过');
    const dOk = d && d.reach, rOk = r && r.reach;
    let verdict;
    if (dOk) verdict = '结论：浏览器可以直接访问该接口。';
    else if (rOk) verdict = '结论：直连被跨域或网络策略拦截，但站内代理可用。“自动”模式会自动走代理，无需其他操作。';
    else verdict = '结论：两条路线都无法到达该接口。请检查地址拼写、协议（http/https）、目标服务是否在线。';
    line((dOk || rOk) ? 'ok' : 'bad', verdict);
    if ((dOk && d.ok) || (rOk && r.ok)) Quirks.save(c, flags);
    btn.disabled = false;
  },

  /* ---------- 对话 / 画图 / 外观 / 数据 ---------- */
  setSel(id, v) {
    const s = $(id);
    if (!Array.prototype.some.call(s.options, (o) => o.value === String(v))) s.appendChild(el('option', { value: v, text: v }));
    s.value = String(v);
  },
  loadChat() {
    $('#sSystem').value = SystemPrompt.get();
    this.setSel('#sCtx', Settings.get('ctx')); this.setSel('#sMax', Settings.get('maxTokens')); this.setSel('#sTimeout', Settings.get('timeout'));
    $('#sTemp').value = Settings.get('temp'); TempSlider.sync();
    $('#sStream').checked = !!Settings.get('stream'); $('#sShowThink').checked = !!Settings.get('showThink');
    $('#sFileGen').checked = Settings.get('fileGen') !== false;
  },
  loadDraw() {
    $('#dUrl').value = Draw.cfg.url; $('#dKey').value = Draw.cfg.key; $('#dModel').value = Draw.cfg.model;
    this.setSel('#dSize', Draw.cfg.size); $('#dFormat').value = Draw.cfg.format;
  },
  loadLook() {
    $$('#segTheme button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-v') === Settings.get('theme')));
    $$('#segFont button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-v') === Settings.get('fontSize')));
  },
  async loadData() {
    $('#stTotal').textContent = fmtNum(Token.s.total); $('#stIn').textContent = fmtNum(Token.s.input); $('#stOut').textContent = fmtNum(Token.s.output);
    $('#stCost').textContent = '$' + Token.s.cost.toFixed(3);
    $('#dtUsage').textContent = '本地已用存储约 ' + fmtSize(Store.usage()) + '（浏览器通常提供 5–10 MB）。费用为粗略估算，仅供参考。';
    Sync.renderSettings();
    try {
      const r = await fetch('/__zc_health__', { cache: 'no-store' });
      const j = await r.json();
      $('#svcStatus').textContent = 'Worker v' + j.version + ' 运行正常；站内代理 已启用；KV 云同步 ' + (j.kv ? '已绑定' : '未绑定（可选）') + '。';
    } catch (e) { $('#svcStatus').textContent = '未检测到 Worker 服务：当前页面可能不是通过 Worker 打开的，站内代理与云同步不可用。'; }
  }
};


/* ==========================================================================
 * 08 云同步（可选，依赖 Worker 绑定的 KV）与本地备份
 * ========================================================================== */
const SYNC_KEYS = ['apis', 'sessions', 'system_prompt', 'settings', 'draw_api', 'deep_think', 'deep_think_level'];

const Sync = {
  available: false, on: false, pass: '', ns: '', encKey: null, keys: false, applying: false, busy: false, lastMsg: '',
  minPassLen: 12,
  _timer: null,

  // 由同一份「同步密钥」分别派生 ns（云端存储定位用）与 encKey（AES-GCM 加密用），
  // 两者使用不同的 domain-separation 前缀，互不可推导；encKey 缺失时视为不可同步。
  async deriveSecrets(pass) {
    if (String(pass || '').length < this.minPassLen) { this.ns = ''; this.encKey = null; return; }
    this.ns = await sha256hex('zc_gura_sync:' + pass);
    try { this.encKey = await zcDeriveAesKey(pass); } catch (e) { this.encKey = null; }
  },

  async init() {
    this.on = Store.get('sync_on', false) === true;
    this.pass = String(Store.get('sync_pass', '') || '');
    this.keys = Store.get('sync_keys', false) === true;
    this.available = await this.check();
    this.badge();
    if (this.on && this.available && this.pass.length >= this.minPassLen) {
      await this.deriveSecrets(this.pass);
      if (this.ns && this.encKey) await this.now(true);
    }
  },
  async check() {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch('/__zc_kv__/status', { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(t);
      if (!r.ok) return false;
      const j = await r.json(); return !!(j && j.available);
    } catch (e) { return false; }
  },

  touch(k) {
    if (this.applying || !this.on || !this.available || !this.ns || !this.encKey) return;
    if (SYNC_KEYS.indexOf(k) < 0) return;
    Store.set('sync_dirty', Date.now(), true);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.now(true), 3000);
  },
  tombstone(id) {
    const t = Store.get('sync_tomb', []); const a = Array.isArray(t) ? t : [];
    a.push({ id, ts: Date.now() });
    Store.set('sync_tomb', a.slice(-300), true);
  },

  /* 本地 → 载荷（默认不带 Key，图片以占位形式省略以控制体积） */
  collect() {
    const kv = {};
    SYNC_KEYS.forEach((k) => {
      let raw = null;
      try { raw = localStorage.getItem(PFX + k); } catch (e) { /* ignore */ }
      if (raw == null) return;
      let val = raw;
      try {
        if (k === 'apis' && !this.keys) { const a = JSON.parse(raw); a.forEach((x) => { x.key = ''; }); val = JSON.stringify(a); }
        else if (k === 'draw_api' && !this.keys) { const d = JSON.parse(raw); d.key = ''; val = JSON.stringify(d); }
        else if (k === 'sessions') {
          const ss = JSON.parse(raw);
          ss.forEach((s) => (s.messages || []).forEach((m) => {
            if (Array.isArray(m.content)) m.content.forEach((p) => { if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string' && p.image_url.url.length > 2000) { p.image_url.url = ''; p.image_url.pruned = true; } });
            else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20000) m.content = m.content.replace(/\]\(data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=\s]{2000,}\)/g, '](#)');
          }));
          val = JSON.stringify(ss);
        }
      } catch (e) { val = raw; }
      kv[k] = val;
    });
    const tomb = Store.get('sync_tomb', []);
    return { v: 2, ts: Date.now(), kv, tomb: Array.isArray(tomb) ? tomb : [] };
  },
  async pull() {
    const r = await fetch('/__zc_kv__/get', { cache: 'no-store', headers: { 'x-zc-sync-ns': this.ns } });
    if (!r.ok) throw new Error('云端读取失败（HTTP ' + r.status + '）');
    const j = await r.json();
    if (j.value == null) return null;
    let p = null;
    try { p = await zcDecryptJson(j.value, this.encKey); }
    catch (e) { throw new Error('解密失败，同步密钥可能不正确：' + e.message); }
    if (!p) {
      // 不是本方案的加密信封：兼容修复前保存的旧版明文数据，读一次即可，
      // 下次 now() 会以加密格式重新写回，之后云端就不再有明文。
      try { p = JSON.parse(j.value); } catch (e) { throw new Error('云端数据格式无法识别'); }
    }
    if (!p.v) { // 更旧的格式：{ zc_gura_xxx: '字符串' }
      const kv = {}; Object.keys(p).forEach((k) => { if (k.indexOf(PFX) === 0) kv[k.slice(PFX.length)] = p[k]; });
      return { v: 1, ts: 0, kv, tomb: [] };
    }
    return p;
  },
  async push(payload) {
    if (!this.encKey) throw new Error('加密密钥未就绪，无法上传');
    const body = await zcEncryptJson(payload, this.encKey);
    const r = await fetch('/__zc_kv__/set', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', 'x-zc-sync-ns': this.ns }, body });
    if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch (e) { /* ignore */ } throw new Error(m || ('云端写入失败（HTTP ' + r.status + '）')); }
  },

  merge(remote) {
    const localTs = Store.get('sync_ts', 0) || 0;
    const remoteNewer = (remote.ts || 0) > localTs;
    const tomb = {};
    (remote.tomb || []).concat(Store.get('sync_tomb', []) || []).forEach((t) => { if (t && t.id) tomb[t.id] = Math.max(tomb[t.id] || 0, t.ts || 0); });
    let changed = false;
    this.applying = true;
    try {
      Object.keys(remote.kv || {}).forEach((k) => {
        if (SYNC_KEYS.indexOf(k) < 0) return;
        let rv = remote.kv[k], lv = null;
        try { lv = localStorage.getItem(PFX + k); } catch (e) { /* ignore */ }
        let out = null;
        try {
          if (k === 'sessions') {
            const rs = JSON.parse(rv) || [], ls = lv ? JSON.parse(lv) : [];
            const map = {};
            ls.forEach((s) => { map[s.id] = s; });
            rs.forEach((s) => { const l = map[s.id]; if (!l || (s.updatedAt || 0) > (l.updatedAt || 0)) map[s.id] = s; });
            const list = Object.keys(map).map((id) => map[id]).filter((s) => !(tomb[s.id] && tomb[s.id] >= (s.updatedAt || 0)));
            out = JSON.stringify(list);
          } else if (k === 'apis') {
            if (!remoteNewer && lv) return;
            const ra = JSON.parse(rv) || [], la = lv ? JSON.parse(lv) : [];
            ra.forEach((a) => { if (!a.key) { const m = la.filter((x) => x.id && x.id === a.id)[0] || la.filter((x) => x.url === a.url && x.model === a.model)[0]; if (m) a.key = m.key || ''; } });
            out = JSON.stringify(ra);
          } else if (k === 'draw_api') {
            if (!remoteNewer && lv) return;
            const rd = JSON.parse(rv) || {}, ld = lv ? JSON.parse(lv) : {};
            if (!rd.key && ld.key) rd.key = ld.key;
            out = JSON.stringify(rd);
          } else {
            if (!remoteNewer && lv != null) return;
            out = rv;
          }
        } catch (e) { return; }
        if (out !== lv) { try { localStorage.setItem(PFX + k, out); changed = true; } catch (e) { /* 空间不足 */ } }
      });
    } finally { this.applying = false; }
    return changed;
  },

  async now(silent) {
    if (this.busy) return;
    if (!this.available) { if (!silent) Toast.err('云同步不可用：Worker 未绑定 KV（变量名 ZC_KV）'); return; }
    if (this.pass.length < this.minPassLen) { if (!silent) Toast.err('请先设置至少 ' + this.minPassLen + ' 位的同步密钥'); return; }
    if (!this.ns || !this.encKey) await this.deriveSecrets(this.pass);
    if (!this.ns || !this.encKey) { if (!silent) Toast.err('当前浏览器不支持加密同步所需的 WebCrypto'); return; }
    this.busy = true; this.setMsg('同步中…');
    try {
      Sessions.later.flush();
      const remote = await this.pull();
      let changed = false;
      if (remote) changed = this.merge(remote);
      const payload = this.collect();
      await this.push(payload);
      Store.set('sync_ts', payload.ts, true);
      this.setMsg('已同步 ' + new Date().toLocaleTimeString());
      if (changed) this.reloadFromStorage();
      if (!silent) Toast.ok('已同步到云端');
    } catch (e) {
      this.setMsg('同步失败：' + e.message);
      if (!silent) Toast.err('云同步失败：' + e.message);
    } finally { this.busy = false; this.badge(); }
  },
  reloadFromStorage() {
    Api.init(); Deep.init(); Draw.init(); Settings.init();
    const keep = Sessions.curId;
    Sessions.init();
    if (keep && Sessions.list.some((s) => s.id === keep)) Sessions.curId = keep;
    if (!Chat.busy) { View.renderThread(); }
    View.renderSessions(); View.updateHeader(); View.updateDeep();
  },

  async toggle(on) {
    if (on) {
      if (!this.available) { $('#syOn').checked = false; return Toast.err('Worker 未绑定 KV（变量名 ZC_KV），云同步不可用'); }
      if (!window.crypto || !crypto.subtle) { $('#syOn').checked = false; return Toast.err('当前浏览器不支持加密同步所需的 WebCrypto'); }
      const p = $('#syPass').value.trim() || this.pass;
      if (p.length < this.minPassLen) { $('#syOn').checked = false; return Toast.err('请先填写至少 ' + this.minPassLen + ' 位的同步密钥（建议点击"生成随机密钥"）'); }
      this.pass = p; Store.set('sync_pass', p, true);
      await this.deriveSecrets(p);
      if (!this.ns || !this.encKey) { $('#syOn').checked = false; return Toast.err('密钥派生失败，无法开启同步'); }
      this.on = true; Store.set('sync_on', true, true);
      await this.now(false);
    } else { this.on = false; Store.set('sync_on', false, true); this.setMsg('已关闭'); }
    this.badge();
  },
  async setPass(v) {
    v = v.trim(); this.pass = v; Store.set('sync_pass', v, true);
    await this.deriveSecrets(v);
    if (this.on && this.ns && this.encKey) this.now(false);
  },
  genPass() {
    const p = zcRandomPass(24);
    $('#syPass').value = p;
    try { navigator.clipboard.writeText(p); Toast.ok('已生成随机密钥并复制，请粘贴到你的其他设备（不要与他人共用）'); }
    catch (e) { Toast.ok('已生成随机密钥，请手动复制到你的其他设备（不要与他人共用）'); }
    this.setPass(p);
  },
  setKeys(b) { this.keys = b; Store.set('sync_keys', b, true); if (this.on) this.touch('apis'); },
  setMsg(m) { this.lastMsg = m; const s = $('#syStatus'); if (s) s.textContent = m; },
  badge() { const b = $('#syncBadge'); if (b) b.textContent = this.on && this.available ? (this.busy ? '云同步中…' : '云同步已开启') : ''; },
  renderSettings() {
    $('#syAvail').textContent = this.available ? '已检测到 KV，可在多台设备间同步会话与设置' : '未检测到 KV：在 Worker 中绑定名为 ZC_KV 的命名空间后可用';
    $('#syOn').checked = this.on; $('#syOn').disabled = !this.available;
    $('#syPass').value = this.pass; $('#syKeys').checked = this.keys;
    $('#syStatus').textContent = this.lastMsg || '';
  }
};

const Backup = {
  exportAll() {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PFX) === 0 && k !== PFX + 'sync_pass') data[k.slice(PFX.length)] = localStorage.getItem(k);
      }
    } catch (e) { return Toast.err('读取本地数据失败'); }
    downloadBlob('ZC-GURA_备份_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ app: 'zc-gura', v: 2, ts: Date.now(), data }, null, 1), 'application/json');
    Toast.ok('备份已导出（包含 API Key，请妥善保管）');
  },
  async restore(file) {
    try {
      const j = JSON.parse(await file.text());
      let data = j && j.app === 'zc-gura' ? j.data : null;
      if (!data && isObj(j)) { data = {}; Object.keys(j).forEach((k) => { if (k.indexOf(PFX) === 0) data[k.slice(PFX.length)] = j[k]; }); }
      if (!data || !Object.keys(data).length) throw new Error('文件中没有可恢复的数据');
      if (!(await Dialog.confirm('从备份恢复', '将用备份中的 API 配置、会话和设置覆盖当前数据（' + Object.keys(data).length + ' 项），页面会自动刷新。', '恢复', true))) return;
      Object.keys(data).forEach((k) => { if (k !== 'sync_pass') try { localStorage.setItem(PFX + k, typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])); } catch (e) { /* ignore */ } });
      Toast.ok('恢复完成，正在刷新…'); setTimeout(() => location.reload(), 700);
    } catch (e) { Toast.err('恢复失败：' + e.message); }
  }
};


/* ==========================================================================
 * 08b 首页输出式介绍 / 图标触碰反馈
 * ========================================================================== */
// 首页介绍：以“模型流式输出”的方式逐段显示（打字机 + 光标）。
// 整段文字始终占位（未输出部分透明），换行位置固定，输出过程中版面不会抖动。
const HeroType = {
  a: null, b: null, cur: null, full: '', timer: 0, tick: 0, was: false,
  init() {
    const stage = $('#stage'), p = $('#hero p');
    if (!stage || !p) return;
    this.full = p.textContent.replace(/\s+/g, ' ').trim();
    if (!this.full) return;
    p.textContent = '';
    this.a = el('span', { 'aria-hidden': 'true' });
    this.cur = el('span', { class: 'ty-cur off', 'aria-hidden': 'true' });
    this.b = el('span', { class: 'ty-b', 'aria-hidden': 'true', text: this.full });
    p.appendChild(el('span', { class: 'ty-sr', text: this.full }));   // 读屏软件一次读完整句
    p.appendChild(this.a); p.appendChild(this.cur); p.appendChild(this.b);
    this.was = stage.classList.contains('empty');
    if (this.was) this.play(); else this.finish();
    // 每次回到空白首页（新对话 / 清空会话）时重新输出一遍
    new MutationObserver(() => {
      const now = stage.classList.contains('empty');
      if (now === this.was) return;
      this.was = now;
      if (now) this.play(); else this.finish();
    }).observe(stage, { attributes: true, attributeFilter: ['class'] });
  },
  stop() { clearTimeout(this.timer); this.tick++; },
  finish() {
    this.stop();
    this.a.textContent = this.full; this.b.textContent = ''; this.cur.classList.add('off');
  },
  play() {
    this.stop();
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
    if (reduce) { this.finish(); return; }
    const run = this.tick, chars = Array.from(this.full);
    let i = 0;
    this.a.textContent = ''; this.b.textContent = this.full; this.cur.classList.remove('off');
    const step = () => {
      if (run !== this.tick) return;
      if (i >= chars.length) {
        this.timer = setTimeout(() => { if (run === this.tick) this.finish(); }, 1600);   // 光标再闪一会儿后消失
        return;
      }
      const n = 1 + (Math.random() < 0.35 ? 1 : 0) + (Math.random() < 0.1 ? 1 : 0);      // 每次吐出 1~3 个字，像 token 流
      const chunk = chars.slice(i, i + n).join('');
      i += n;
      this.a.appendChild(el('span', { class: 'ty-c', text: chunk }));
      this.b.textContent = chars.slice(i).join('');
      const last = chunk.charAt(chunk.length - 1);
      const wait = /[，。；：、！？,.;:!?]/.test(last) ? 160 + Math.random() * 140 : 32 + Math.random() * 38;
      this.timer = setTimeout(step, wait);
    };
    this.timer = setTimeout(step, 320);
  }
};

// 图标触碰反馈：凡是带图标的按钮，按下时缩小并高亮，松开时弹性回弹，触屏设备再加一下轻微震动。
// 通过事件委托实现，动态生成的图标按钮（消息操作、会话操作、代码块、菜单等）自动生效。
const TouchFx = {
  map: new Map(), spring: false, reduce: false,
  init() {
    try { this.spring = typeof Element.prototype.animate === 'function' && !!(window.CSS && CSS.supports && CSS.supports('scale', '1')); } catch (e) { this.spring = false; }
    try { this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
    const o = { capture: true, passive: true };
    document.addEventListener('pointerdown', (e) => this.down(e), o);
    document.addEventListener('pointerup', (e) => this.up(e, false), o);
    document.addEventListener('pointercancel', (e) => this.up(e, true), o);
    window.addEventListener('blur', () => this.clearAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clearAll(); });
  },
  // 找到被按下的“带图标的可点击控件”；不带图标的按钮 / 行不处理
  find(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return null;
    const t = e.target;
    if (!t || !t.closest) return null;
    const b = t.closest('button, [role="button"], summary');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('data-nofx')) return null;
    let has = !!t.closest('svg');
    for (let i = 0; !has && i < b.children.length; i++) if (b.children[i].tagName.toLowerCase() === 'svg') has = true;
    return has ? b : null;
  },
  down(e) {
    const b = this.find(e);
    if (!b) return;
    this.finishOne(e.pointerId, true);
    const r = b.getBoundingClientRect(), m = Math.max(r.width, r.height);
    const s = m <= 48 ? 0.84 : m <= 160 ? 0.94 : 0.985;      // 越大的控件缩得越少
    const st = { b, s, t: performance.now(), type: e.pointerType, anim: null, guard: 0 };
    b.classList.add('zc-tap');
    if (this.spring && !this.reduce) {
      try { st.anim = b.animate([{ scale: '1' }, { scale: String(s) }], { duration: 110, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }); } catch (err) { st.anim = null; }
    }
    st.guard = setTimeout(() => this.finishOne(e.pointerId, true), 8000);   // 兜底：防止松手事件丢失导致一直处于按下态
    this.map.set(e.pointerId, st);
  },
  up(e, cancelled) {
    const st = this.map.get(e.pointerId);
    if (!st) return;
    this.map.delete(e.pointerId);
    clearTimeout(st.guard);
    if (!cancelled && st.type === 'touch') this.buzz();
    const wait = cancelled ? 0 : Math.max(0, 120 - (performance.now() - st.t));   // 快速点按也至少显示 120ms 的按下态
    if (wait) setTimeout(() => this.end(st, false), wait); else this.end(st, cancelled);
  },
  finishOne(id, quick) {
    const st = this.map.get(id);
    if (!st) return;
    this.map.delete(id); clearTimeout(st.guard); this.end(st, quick);
  },
  clearAll() { Array.from(this.map.keys()).forEach((id) => this.finishOne(id, true)); },
  end(st, quick) {
    st.b.classList.remove('zc-tap');
    if (!st.anim) return;
    try {
      st.anim.cancel();
      st.b.animate([{ scale: String(st.s) }, { scale: '1' }], quick ? { duration: 140, easing: 'ease-out' } : { duration: 340, easing: 'cubic-bezier(.3,1.7,.5,1)' });
    } catch (err) { /* ignore */ }
  },
  buzz() { try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) { /* ignore */ } }
};


/* ==========================================================================
 * 09 启动与全局交互
 * ========================================================================== */
const App = {
  isMobile() { return window.innerWidth <= 820; },
  toggleSide() {
    const app = $('#app');
    if (this.isMobile()) app.classList.toggle('drawer');
    else { app.classList.toggle('collapsed'); Store.set('side_collapsed', app.classList.contains('collapsed'), true); }
  },
  closeDrawer() { $('#app').classList.remove('drawer'); },

  boot() {
    Settings.init(); Api.init(); Deep.init(); Token.init(); Draw.init(); Sessions.init();
    Store.onChange = (k) => Sync.touch(k);
    View.init(); Composer.init(); Settings2.init();
    Agent.init().catch(() => {});

    if (Store.get('side_collapsed', false) === true && !this.isMobile()) $('#app').classList.add('collapsed');
    $('#btnCollapse').addEventListener('click', () => this.toggleSide());
    $('#btnMenu').addEventListener('click', () => this.toggleSide());
    $('#scrim').addEventListener('click', () => this.closeDrawer());
    $('#btnNew').addEventListener('click', () => Chat.newChat());
    $('#btnSettings').addEventListener('click', () => { this.closeDrawer(); Settings2.open('api'); });
    $('#modelBtn').addEventListener('click', (e) => View.modelMenu(e.currentTarget));
    $('#heroStatus').addEventListener('click', () => Settings2.open('api'));
    $('#btnMore').addEventListener('click', (e) => View.moreMenu(e.currentTarget));
    $('#btnTheme').addEventListener('click', () => { Settings.set('theme', Settings.resolvedTheme() === 'dark' ? 'light' : 'dark'); Settings.apply(); });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (!$('#agentDiffOv').hidden) { e.preventDefault(); Agent.closeDiff(false); return; }
        if (!$('#settingsOv').hidden || !$('#dialogOv').hidden || Pop.node) return;
        if (Chat.busy) { e.preventDefault(); Chat.stop(); }
        else if (this.isMobile()) this.closeDrawer();
        return;
      }
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); $('#app').classList.remove('collapsed'); if (this.isMobile()) $('#app').classList.add('drawer'); $('#sessionSearch').focus(); }
      else if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); Chat.newChat(); }
      else if (mod && e.key === ',') { e.preventDefault(); Settings2.open('api'); }
    });
    window.addEventListener('beforeunload', () => Sessions.later.flush());
    document.addEventListener('visibilitychange', () => { if (document.hidden) Sessions.later.flush(); });
    window.addEventListener('resize', debounce(() => { if (!this.isMobile()) this.closeDrawer(); }, 120));

    View.renderSessions(); View.renderThread(); View.updateHeader(); View.updateDeep();
    TouchFx.init(); HeroType.init();
    Composer.focus();
    if (!Api.list.length) Toast.info('欢迎使用。请先在设置中添加一个 API。', 'info');

    Sync.init().catch(() => {});
    window.ZC = { Api, Net, Format, Sessions, Settings, Chat, Sync, Quirks, Agent, AgentFS };
  }
};

/* ==========================================================================
 * 10 账号：登录 / 注册（QQ 邮箱验证码）
 * 流程：注册（邮箱 + 密码 → 发送验证码 → 填写验证码）→ 注册成功后跳转登录页 → 登录进入应用。
 * 登录令牌存放在 zc_auth_session（刻意不使用 zc_gura_ 前缀，因此不会进入备份导出与云同步）。
 * ========================================================================== */
const Auth = {
  KEY: 'zc_auth_session',
  base: '/__zc_auth__',
  token: '', email: '', cfg: null, tab: 'login',
  start: null, booted: false, wired: false, expiring: false,
  busy: false, cd: 0, cdTimer: 0,

  load() {
    try {
      const o = JSON.parse(localStorage.getItem(this.KEY) || 'null');
      if (o && typeof o.token === 'string' && /^[a-f0-9]{64}$/.test(o.token)) { this.token = o.token; this.email = String(o.email || ''); }
    } catch (e) { /* ignore */ }
  },
  save(token, email) {
    this.token = token; this.email = email;
    try { localStorage.setItem(this.KEY, JSON.stringify({ token: token, email: email })); } catch (e) { /* ignore */ }
  },
  clear() {
    this.token = ''; this.email = '';
    try { localStorage.removeItem(this.KEY); } catch (e) { /* ignore */ }
  },

  async api(path, method, body) {
    try {
      const h = { 'Content-Type': 'application/json' };
      if (this.token) h['x-zc-session'] = this.token;
      const r = await fetch(this.base + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      let d = null;
      try { d = await r.json(); } catch (e) { d = null; }
      return { ok: r.ok, status: r.status, data: d || {} };
    } catch (e) {
      return { ok: false, status: 0, data: { error: '网络错误，无法连接服务器' } };
    }
  },

  // 给发往本站 /__zc_relay__ 与 /__zc_kv__ 的请求自动附带登录会话；服务端返回 401 时回到登录页
  installFetch() {
    if (window.__zcAuthFetch) return;
    window.__zcAuthFetch = true;
    const raw = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : ((input && input.url) || '');
        let p = '';
        if (u.charAt(0) === '/') p = u;
        else { const x = new URL(u, location.href); if (x.origin === location.origin) p = x.pathname; }
        if (Auth.token && (p.indexOf('/__zc_relay__') === 0 || p.indexOf('/__zc_kv__') === 0)) {
          init = Object.assign({}, init);
          const h = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || undefined);
          h.set('x-zc-session', Auth.token);
          init.headers = h;
        }
      } catch (e) { /* ignore */ }
      return raw(input, init).then(function (r) {
        if (r.status === 401 && r.headers.get('x-zc-auth') === 'required') Auth.expired();
        return r;
      });
    };
  },

  async gate(start) {
    this.start = start;
    this.installFetch();
    this.load();
    this.wire();
    const st = await this.api('/status');
    if (st.ok && st.data.enabled === false) { this.enter(false); return; } // 服务端设置了 ZC_AUTH_DISABLED
    if (!st.ok) {
      this.show('login');
      this.msg('无法连接登录服务：' + (st.data.error || ('HTTP ' + st.status)) + '。请确认是通过已部署的 Worker 地址打开本页面。');
      return;
    }
    this.cfg = st.data;
    if (!st.data.kv) {
      this.show('login');
      this.msg('服务端未绑定 KV（变量名 ZC_KV），登录注册暂不可用。请在 Worker 中绑定 KV 后刷新页面。');
      return;
    }
    if (this.token) {
      const me = await this.api('/me');
      if (me.ok) { this.email = me.data.email || this.email; this.enter(true); return; }
      if (me.status === 401) this.clear();
      else { this.show('login'); this.msg('暂时无法验证登录状态：' + (me.data.error || ('HTTP ' + me.status)) + '。请刷新页面重试。'); return; }
    }
    this.show('login');
  },

  enter(logged) {
    $('#authScreen').hidden = true;
    document.body.classList.add('authed');
    const b = $('#btnLogout');
    if (b) { b.hidden = !logged; if (logged) b.title = this.email; }
    this.expiring = false;
    if (!this.booted) { this.booted = true; this.start(); }
  },

  show(tab) {
    document.body.classList.remove('authed');
    $('#authScreen').hidden = false;
    this.setTab(tab);
  },

  setTab(tab) {
    this.tab = tab;
    $$('#authTabs button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === tab));
    $('#authLogin').hidden = tab !== 'login';
    $('#authReg').hidden = tab !== 'register';
    this.msg('');
    setTimeout(() => { const f = $(tab === 'login' ? '#loginEmail' : '#regEmail'); if (f) f.focus(); }, 30);
  },

  msg(text, type) {
    const n = $('#authMsg');
    n.hidden = !text;
    n.textContent = text || '';
    n.className = 'auth-msg' + (type === 'ok' ? ' ok' : '');
  },

  setBusy(on) {
    this.busy = on;
    $$('#authScreen .btn').forEach((b) => { b.disabled = on || (b.id === 'regSend' && this.cd > 0); });
  },

  wire() {
    if (this.wired) return;
    this.wired = true;
    $$('#authTabs button').forEach((b) => b.addEventListener('click', () => this.setTab(b.getAttribute('data-tab'))));
    $('#authLogin').addEventListener('submit', (e) => { e.preventDefault(); this.doLogin(); });
    $('#authReg').addEventListener('submit', (e) => { e.preventDefault(); this.doRegister(); });
    $('#regSend').addEventListener('click', () => this.sendCode());
    $('#regCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 6); });
    $('#btnLogout').addEventListener('click', () => this.logout());
  },

  checkEmail(v) {
    const email = String(v || '').trim().toLowerCase();
    if (!email) return { err: '请输入邮箱' };
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return { err: '邮箱格式不正确' };
    const domains = (this.cfg && this.cfg.domains) || ['qq.com'];
    if (domains.indexOf('*') < 0 && domains.indexOf(email.split('@')[1]) < 0) {
      return { err: '仅支持 ' + domains.map((d) => '@' + d).join('、') + ' 邮箱' };
    }
    return { email: email };
  },

  checkPass(pw, pw2) {
    const min = (this.cfg && this.cfg.passMin) || 8;
    if (!pw || pw.length < min) return '密码至少 ' + min + ' 位';
    if (pw.length > 128) return '密码不能超过 128 位';
    if (pw !== pw2) return '两次输入的密码不一致';
    return '';
  },

  countdown(sec) {
    clearInterval(this.cdTimer);
    this.cd = sec;
    const b = $('#regSend');
    const tick = () => {
      if (this.cd <= 0) { clearInterval(this.cdTimer); b.disabled = this.busy; b.textContent = '发送验证码'; return; }
      b.disabled = true; b.textContent = '重新发送(' + this.cd + 's)'; this.cd--;
    };
    tick();
    this.cdTimer = setInterval(tick, 1000);
  },

  async sendCode() {
    if (this.busy || this.cd > 0) return;
    const e = this.checkEmail($('#regEmail').value);
    if (e.err) return this.msg(e.err);
    const pe = this.checkPass($('#regPass').value, $('#regPass2').value);
    if (pe) return this.msg(pe);
    this.msg('');
    this.setBusy(true);
    const r = await this.api('/send-code', 'POST', { email: e.email });
    this.setBusy(false);
    if (r.ok) {
      this.msg('验证码已发送至 ' + e.email + '，10 分钟内有效。没收到请查看垃圾邮件箱。', 'ok');
      this.countdown((r.data && r.data.cooldown) || 60);
      $('#regCode').focus();
    } else {
      if (r.data && r.data.retryAfter) this.countdown(r.data.retryAfter);
      this.msg(r.data.error || '验证码发送失败，请稍后重试');
    }
  },

  async doRegister() {
    if (this.busy) return;
    const e = this.checkEmail($('#regEmail').value);
    if (e.err) return this.msg(e.err);
    const pw = $('#regPass').value;
    const pe = this.checkPass(pw, $('#regPass2').value);
    if (pe) return this.msg(pe);
    const code = $('#regCode').value.trim();
    if (!/^[0-9]{6}$/.test(code)) return this.msg('请输入 6 位邮箱验证码');
    this.msg('');
    this.setBusy(true);
    const r = await this.api('/register', 'POST', { email: e.email, password: pw, code: code });
    this.setBusy(false);
    if (!r.ok) return this.msg(r.data.error || '注册失败，请稍后重试');
    // 注册成功 → 清空注册表单并跳转到登录页
    clearInterval(this.cdTimer); this.cd = 0;
    $('#authReg').reset();
    $('#regSend').textContent = '发送验证码'; $('#regSend').disabled = false;
    this.setTab('login');
    $('#loginEmail').value = e.email;
    $('#loginPass').value = '';
    this.msg('注册成功，请使用刚才的邮箱和密码登录', 'ok');
    Toast.ok('注册成功，请登录');
    setTimeout(() => $('#loginPass').focus(), 60);
  },

  async doLogin() {
    if (this.busy) return;
    const e = this.checkEmail($('#loginEmail').value);
    if (e.err) return this.msg(e.err);
    const pw = $('#loginPass').value;
    if (!pw) return this.msg('请输入密码');
    this.msg('');
    this.setBusy(true);
    const r = await this.api('/login', 'POST', { email: e.email, password: pw });
    this.setBusy(false);
    if (!r.ok || !r.data.token) return this.msg(r.data.error || '登录失败，请稍后重试');
    this.save(r.data.token, r.data.email || e.email);
    $('#loginPass').value = '';
    this.enter(true);
  },

  async logout() {
    const ok = await Dialog.confirm('退出登录', '确定退出当前账号吗？', '退出');
    if (!ok) return;
    await this.api('/logout', 'POST');
    this.clear();
    location.reload();
  },

  // 使用中会话失效（过期 / 被服务端拒绝）：回到登录页，重新登录后继续使用
  expired() {
    if (this.expiring || !this.booted) return;
    this.expiring = true;
    const last = this.email;
    this.clear();
    this.show('login');
    if (last) $('#loginEmail').value = last;
    this.msg('登录已过期，请重新登录');
  }
};

const bootApp = () => Auth.gate(() => App.boot());
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp); else bootApp();

})();
</script>
</body>
</html>
`;
