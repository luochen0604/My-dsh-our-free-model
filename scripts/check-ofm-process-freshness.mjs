#!/usr/bin/env node
// 检测「正在运行的 DSH 进程是否已加载当前磁盘上的 OFM 代码」。
// 三方比对：① 仓库工作区指纹 ② profile 安装副本指纹（宿主实际加载的是它）③ 运行中主进程 StartTime。
// 退出码：fresh=0 / stale=1 / unknown=2。用法：
//   node scripts/check-ofm-process-freshness.mjs [--json] [--record]
// 配置：环境变量 OFM_PROFILE_DIR 可覆盖 profile 副本路径（默认本机 ASUS 的 desktop profile）。

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR_DEFAULT = String.raw`C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-our-free-model`;
const PROFILE_DIR = process.env.OFM_PROFILE_DIR || PROFILE_DIR_DEFAULT;
const PROCESS_NAME = 'DeepSeek Harness';
const STATE_FILE = path.join(REPO_ROOT, '.ofm-freshness-state.json');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const doRecord = args.has('--record');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// 展开 package.json files 字段：文件、目录（递归）、通配符（如 locale/*.json）。
async function expandFilesField(root, entries) {
  const out = [];
  for (const entry of entries) {
    const clean = entry.replace(/^\.\//, '');
    if (clean.includes('*')) {
      // 简单 glob：只支持 `<dir>/*.ext` 形式
      const dir = path.dirname(clean);
      const pattern = path.basename(clean).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
      const re = new RegExp('^' + pattern.replace(/[.]/g, '\\.') + '$');
      const fullDir = path.join(root, dir);
      if (!existsSync(fullDir)) { out.push({ rel: clean, missing: true }); continue; }
      const names = (await import('node:fs/promises')).readdir(fullDir);
      for (const n of await names) {
        if (re.test(n)) out.push({ rel: path.join(dir, n).replace(/\\/g, '/') });
      }
      continue;
    }
    const abs = path.join(root, clean);
    if (!existsSync(abs)) { out.push({ rel: clean, missing: true }); continue; }
    const st = await stat(abs);
    if (st.isDirectory()) {
      // 目录递归展开
      const stack = [[abs, clean]];
      while (stack.length) {
        const [d, r] = stack.pop();
        for (const n of await (await import('node:fs/promises')).readdir(d)) {
          const childAbs = path.join(d, n);
          const childRel = path.join(r, n).replace(/\\/g, '/');
          const cst = await stat(childAbs);
          if (cst.isDirectory()) stack.push([childAbs, childRel]);
          else out.push({ rel: childRel, mtimeMs: cst.mtimeMs });
        }
      }
    } else {
      out.push({ rel: clean, mtimeMs: st.mtimeMs });
    }
  }
  // package.json 本身也是安装副本的一部分
  const pkg = path.join(root, 'package.json');
  if (!out.some((f) => f.rel === 'package.json')) {
    if (existsSync(pkg)) out.push({ rel: 'package.json', mtimeMs: (await stat(pkg)).mtimeMs });
  }
  // 去重 + 排序
  const seen = new Map();
  for (const f of out) if (f.rel && !seen.has(f.rel)) seen.set(f.rel, f);
  return [...seen.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

async function fingerprint(root, label) {
  const pkgAbs = path.join(root, 'package.json');
  if (!existsSync(pkgAbs)) {
    return { ok: false, reason: `${label}：找不到 package.json（路径不存在？）`, root };
  }
  let pkg;
  try { pkg = JSON.parse(await readFile(pkgAbs, 'utf8')); }
  catch (e) { return { ok: false, reason: `${label}：package.json 解析失败：${e.message}`, root }; }
  const filesField = Array.isArray(pkg.files) ? pkg.files : [];
  const list = await expandFilesField(root, filesField);
  const missing = list.filter((f) => f.missing).map((f) => f.rel);
  const present = list.filter((f) => !f.missing);
  let maxMtimeMs = 0;
  let maxMtimeFile = null;
  const perFile = {};
  const roll = createHash('sha256');
  for (const f of present) {
    try {
      const buf = await readFile(path.join(root, f.rel));
      const h = sha256(buf);
      perFile[f.rel] = h;
      roll.update(f.rel); roll.update('\0'); roll.update(h); roll.update('\0');
      const m = f.mtimeMs ?? 0;
      if (m > maxMtimeMs) { maxMtimeMs = m; maxMtimeFile = f.rel; }
    } catch (e) {
      missing.push(`${f.rel}（读取失败：${e.message}）`);
    }
  }
  return {
    ok: true,
    root,
    fingerprint: roll.digest('hex'),
    fileCount: present.length,
    missing, // 缺失文件如实列出（可能为空）
    maxMtimeMs,
    maxMtimeFile,
  };
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

async function findMainProcess() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
Get-Process -Name "${PROCESS_NAME}" | Where-Object { $_.StartTime } |
  Sort-Object StartTime | Select-Object -First 1 |
  ForEach-Object { ($_.Id, $_.StartTime.ToString('yyyy-MM-dd HH:mm:ss.fff'), $_.Path) -join [char]9 }
`;
  const { err, stdout } = await runPowerShell(script);
  if (err && !stdout.trim()) {
    return { ok: false, reason: `进程查询失败：${(err.message || '').trim() || '未知错误'}` };
  }
  const line = stdout.trim().split('\n')[0];
  if (!line) return { ok: false, reason: `找不到名为 "${PROCESS_NAME}" 且能读取 StartTime 的进程` };
  const [pid, start, exePath] = line.split('\t');
  const startTime = new Date(start);
  if (Number.isNaN(startTime.getTime())) {
    return { ok: false, reason: `进程 StartTime 解析失败：${start}` };
  }
  return { ok: true, pid: Number(pid), startTime, exePath: exePath || '' };
}

async function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { corrupt: true }; }
}

async function main() {
  const reasons = [];
  let status = 'fresh';

  // ① 仓库工作区指纹
  const repo = await fingerprint(REPO_ROOT, '仓库工作区');
  if (!repo.ok) {
    console.log(`[unknown] ${repo.reason}`);
    if (asJson) console.log(JSON.stringify({ status: 'unknown', reasons: [repo.reason] }, null, 2));
    process.exit(2);
  }

  // 插件清单锚点
  let manifest = null;
  const manifestAbs = path.join(REPO_ROOT, 'catalog', 'dsh-plugin.json');
  if (existsSync(manifestAbs)) {
    try {
      manifest = JSON.parse(await readFile(manifestAbs, 'utf8'));
    } catch { /* 如实降级 */ }
  }
  const pluginInfo = manifest
    ? { version: manifest.version, revision: manifest.source?.revision ?? null }
    : null;

  // ② profile 安装副本指纹（宿主实际加载的目录）
  const profile = await fingerprint(PROFILE_DIR, 'profile 安装副本');
  const profileExists = profile.ok;

  // ③ 主进程 StartTime
  const proc = await findMainProcess();

  // --- 判定 ---
  if (!proc.ok) {
    status = 'unknown';
    reasons.push(proc.reason);
  } else {
    // 信号 a：仓库内被跟踪产物的最大 mtime 晚于进程 StartTime
    const maxMtime = new Date(repo.maxMtimeMs);
    if (maxMtime > proc.startTime) {
      status = 'stale';
      reasons.push(
        `仓库文件 ${repo.maxMtimeFile} 的修改时间（${maxMtime.toLocaleString('zh-CN')}）晚于进程启动时间（${proc.startTime.toLocaleString('zh-CN')}，PID ${proc.pid}）→ 进程启动后代码被改过`,
      );
    }
    // 信号 b0：仓库指纹 vs profile 副本指纹不一致 → 宿主加载的不是这份代码
    if (profileExists && profile.fingerprint !== repo.fingerprint) {
      status = 'stale';
      reasons.push(
        `仓库工作区指纹（${repo.fingerprint.slice(0, 16)}…，${repo.fileCount} 文件）与 profile 副本指纹（${profile.fingerprint.slice(0, 16)}…，${profile.fileCount} 文件）不一致 → 宿主实际加载的 ${PROFILE_DIR} 不是当前仓库代码`,
      );
    }
    // 信号 b1：与状态文件里记录的上次确认指纹比对
    const state = await readState();
    if (state?.corrupt) {
      reasons.push('状态文件损坏，已忽略（可 --record 重建）');
    } else if (state?.confirmedFingerprint && state.confirmedFingerprint !== repo.fingerprint) {
      status = 'stale';
      reasons.push(
        `磁盘指纹（${repo.fingerprint.slice(0, 16)}…）与上次确认进程已加载的指纹（${state.confirmedFingerprint.slice(0, 16)}…，记录于 ${state.recordedAt ?? '未知时间'}）不一致`,
      );
    } else if (!state?.confirmedFingerprint) {
      reasons.push('状态文件尚无记录：无法与「上次确认指纹」比对（--record 可记录）');
    }
  }

  if (profileExists && profile.missing.length) {
    reasons.push(`profile 副本相对 package.json files 字段缺少 ${profile.missing.length} 个文件（详见 JSON 输出）`);
  }
  if (repo.missing.length) {
    reasons.push(`仓库工作区相对 files 字段缺少 ${repo.missing.length} 个文件（详见 JSON 输出）`);
  }
  if (!profileExists) {
    reasons.push(`profile 副本不可读：${profile.reason}`);
  }
  if (reasons.length === 0 && status === 'fresh') {
    reasons.push(`仓库指纹 = profile 副本指纹 = 上次确认指纹，且无文件晚于进程启动时间（PID ${proc.pid}）`);
  }

  // --record：把当前磁盘指纹记为「进程已加载该指纹」
  if (doRecord) {
    await mkdir(REPO_ROOT, { recursive: true });
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          confirmedFingerprint: repo.fingerprint,
          recordedAt: new Date().toISOString(),
          process: proc.ok ? { pid: proc.pid, startTime: proc.startTime.toISOString() } : null,
          plugin: pluginInfo,
        },
        null,
        2,
      ),
    );
    reasons.push('已把当前仓库指纹写入状态文件（.ofm-freshness-state.json，已 gitignore）');
  }

  const summary = {
    status,
    reasons,
    plugin: pluginInfo,
    process: proc.ok
      ? { pid: proc.pid, startTime: proc.startTime.toISOString(), exePath: proc.exePath }
      : { error: proc.reason },
    repo: {
      root: repo.root,
      fingerprint: repo.fingerprint,
      fileCount: repo.fileCount,
      maxMtime: repo.maxMtimeFile ? new Date(repo.maxMtimeMs).toISOString() : null,
      missing: repo.missing,
    },
    profile: profileExists
      ? {
          dir: PROFILE_DIR,
          fingerprint: profile.fingerprint,
          fileCount: profile.fileCount,
          matchesRepo: profile.fingerprint === repo.fingerprint,
          missing: profile.missing,
        }
      : { dir: PROFILE_DIR, error: profile.reason },
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[${status.toUpperCase()}] OFM 进程新鲜度检测`);
    console.log(`插件版本：${pluginInfo?.version ?? '未知'}    源码 revision：${pluginInfo?.revision ?? '未知'}`);
    if (proc.ok) console.log(`主进程：PID ${proc.pid}，启动于 ${proc.startTime.toLocaleString('zh-CN')}（${proc.exePath || '路径未知'}）`);
    else console.log(`主进程：${proc.reason}`);
    console.log(`仓库指纹：${repo.fingerprint.slice(0, 24)}…（${repo.fileCount} 文件）`);
    if (profileExists) {
      console.log(`profile 副本指纹：${profile.fingerprint.slice(0, 24)}…（${profile.fileCount} 文件，${profile.fingerprint === repo.fingerprint ? '与仓库一致' : '与仓库不一致'}）`);
    } else {
      console.log(`profile 副本：${profile.reason}`);
    }
    for (const r of reasons) console.log(`- ${r}`);
    if (status === 'stale') {
      console.log('结论：正在运行的 DSH 加载的不是当前代码 → 需要重启 DSH（必要时在插件管理器里重装）才能生效。');
    } else if (status === 'unknown') {
      console.log('结论：无法判定，请先解决上面的 unknown 原因。');
    } else {
      console.log('结论：正在运行的 DSH 已加载当前磁盘代码。');
    }
  }
  process.exit(status === 'fresh' ? 0 : status === 'stale' ? 1 : 2);
}

main().catch((e) => {
  console.log(`[unknown] 未预期错误：${e?.stack || e?.message || e}`);
  process.exit(2);
});
