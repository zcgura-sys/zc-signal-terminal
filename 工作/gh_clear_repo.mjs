#!/usr/bin/env node
/**
 * gh_clear_repo.mjs — 一键清空 GitHub 仓库里的所有文件（保留提交历史，可回滚）
 *
 * 走 GitHub 官方 Git Data API：读当前 HEAD → 读 tree → 建空 tree → 建新提交 → 移动分支指针。
 * 不产生临时文件、不依赖 git、不需要克隆。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node gh_clear_repo.mjs --repo 用户名/仓库名                 # 演练（只读，打印待删清单）
 *   GITHUB_TOKEN=xxx node gh_clear_repo.mjs --repo 用户名/仓库名 --yes           # 真删（保留 .github/workflows/）
 *   GITHUB_TOKEN=xxx node gh_clear_repo.mjs --repo 用户名/仓库名 --yes --include-workflows   # 连工作流一起删
 *
 * 参数：
 *   --repo <owner/name>   目标仓库（必填，或用 GITHUB_REPO 环境变量）
 *   --branch <name>       目标分支，默认取仓库 default_branch
 *   --yes                 确认执行（不加则只是演练，不做任何写操作）
 *   --include-workflows   连 .github/workflows/ 一起删（默认保留，删了 Actions 工作流就没了）
 *   --keep <path>         额外保留的路径前缀（可重复），例如 --keep public/icon.svg
 *
 * Token 权限：细粒度 PAT 只需该仓库的 Contents: Read and write（建议最短有效期）。
 */

const API = 'https://api.github.com';

function parseArgs(argv) {
  const out = { keep: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (a === '--include-workflows') out.includeWorkflows = true;
    else if (a === '--keep') out.keep.push(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) { console.error(`未知参数：${a}`); process.exit(2); }
  }
  if (!out.repo && process.env.GITHUB_REPO) out.repo = process.env.GITHUB_REPO;
  return out;
}

function usage() {
  console.log(`用法：
  GITHUB_TOKEN=<PAT> node gh_clear_repo.mjs --repo <owner/name> [--yes] [--include-workflows] [--branch <b>] [--keep <path>]

 不加 --yes 为演练模式（只读）；加 --yes 才会真正清空。`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.repo || !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) {
  console.error('缺少或格式错误的 --repo（应为 owner/name）。\n');
  usage();
  process.exit(2);
}

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN（细粒度 PAT，需该仓库 Contents: Read and write）。');
  console.error('例如：GITHUB_TOKEN=github_pat_xxx node gh_clear_repo.mjs --repo ' + args.repo);
  process.exit(2);
}

async function gh(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gh-clear-repo',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && body.message) || String(text).slice(0, 200);
    const err = new Error(`HTTP ${res.status}：${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const KEEP_PREFIXES_DEFAULT = ['.github/workflows/'];

function shouldKeep(p, includeWorkflows) {
  if (!includeWorkflows && KEEP_PREFIXES_DEFAULT.some((k) => p === k.slice(0, -1) || p.startsWith(k))) return true;
  for (const k of args.keep) {
    if (!k) continue;
    if (p === k.replace(/\/$/, '') || p.startsWith(k)) return true;
  }
  return false;
}

const fmt = (n) => (n / 1024).toFixed(1) + ' KB';

async function main() {
  const [owner, name] = args.repo.split('/');
  console.log(`仓库     : ${args.repo}`);

  const repo = await gh(`/repos/${owner}/${name}`);
  const branch = args.branch || repo.default_branch;
  console.log(`可见性   : ${repo.private ? '私有' : '公开'}`);
  console.log(`默认分支 : ${branch}`);

  const ref = await gh(`/repos/${owner}/${name}/git/ref/heads/${branch}`);
  const commitSha = ref.object.sha;

  const commit = await gh(`/repos/${owner}/${name}/git/commits/${commitSha}`);
  const treeSha = commit.tree.sha;
  console.log(`HEAD     : ${commitSha.slice(0, 10)}   tree ${treeSha.slice(0, 10)}`);

  const tree = await gh(`/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated) {
    console.warn('⚠️  tree 被 API 截断（>10 万条目），脚本拒绝继续，请改用 git 方式清理。');
    process.exit(1);
  }

  const blobs = [];          // 待删除
  const keepEntries = [];    // 保留（按原 path/mode/sha 写回新 tree）
  const submodules = [];     // gitlink 子模块，保留不删
  for (const e of tree.tree) {
    if (e.type === 'commit') {
      submodules.push(e.path);
      keepEntries.push({ path: e.path, mode: e.mode || '160000', type: 'commit', sha: e.sha });
      continue;
    }
    if (e.type !== 'blob') continue;                      // 目录由 API 自动推导，无需列入
    if (shouldKeep(e.path, args.includeWorkflows)) {
      keepEntries.push({ path: e.path, mode: e.mode || '100644', type: 'blob', sha: e.sha });
      continue;
    }
    blobs.push(e);
  }
  const keptCount = keepEntries.length;

  const totalBytes = blobs.reduce((s, b) => s + (b.size || 0), 0);
  console.log(`\n待删除   : ${blobs.length} 个文件（blob），合计 ${fmt(totalBytes)}`);
  console.log(`保留     : ${keptCount} 个${args.includeWorkflows ? '' : '（含 .github/workflows/ 下的 Actions 工作流）'}`);
  if (args.keep.length) console.log(`--keep   : ${args.keep.join(', ')}`);
  if (submodules.length) console.log(`⚠️ 子模块  : ${submodules.length} 个 gitlink 保留不删：${submodules.join(', ')}`);

  const sample = blobs.slice(0, 15);
  if (sample.length) {
    console.log('\n待删清单（前 15 个）:');
    for (const b of sample) console.log(`  - ${b.path} (${b.size ?? '?'} B)`);
    if (blobs.length > sample.length) console.log(`  ... 其余 ${blobs.length - sample.length} 个`);
  }

  if (!blobs.length) {
    console.log('\n工作目录已经是空的，无需操作。');
    process.exit(0);
  }

  if (!args.yes) {
    console.log('\n=== 演练模式：未做任何修改 ===');
    console.log('确认无误后，重新运行并加上 --yes 才会真删。');
    process.exit(0);
  }

  console.log('\n=== 执行清空 ===');
  const newTree = await gh(`/repos/${owner}/${name}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: keepEntries }),   // 空数组 = 全空树；保留项按原 sha 写回
  });
  console.log(`新 tree   : ${newTree.sha}（${keepEntries.length} 项保留）`);

  const newCommit = await gh(`/repos/${owner}/${name}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `chore: clear repository contents${args.includeWorkflows ? '' : ' (keep workflows)'}`,
      tree: newTree.sha,
      parents: [commitSha],
    }),
  });
  console.log(`新提交    : ${newCommit.sha}`);

  await gh(`/repos/${owner}/${name}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: true }),
  });
  console.log(`分支已更新: ${branch} → ${newCommit.sha}`);

  console.log('\n✅ 清空完成。历史保留，需要回滚就把分支指针指回 ' + commitSha);
}

main().catch((e) => {
  console.error(`\n❌ 失败：${e.message}`);
  if (e.status === 404) console.error('   （仓库不存在，或 Token 无权访问；私有仓库需要 Contents: Read and write）');
  if (e.status === 403) console.error('   （权限不足或被限流；检查 PAT 是否勾了 Contents 写权限）');
  process.exit(1);
});
