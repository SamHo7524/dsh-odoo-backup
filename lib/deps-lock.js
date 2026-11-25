/**
 * 依赖快照（deps lock）—— 纯函数层。
 *
 * 由来（2026-11-24 真机恢复演练）：`/opt/web_cs` 在生产上有 **65 个已安装 Python 包**，
 * 但目录里没有任何依赖声明文件（requirements.txt / requirements-full.txt /
 * pyproject.toml / setup.py / Pipfile 全部不存在）。恢复源码与配置之后
 * `webchat.service` 报 `Command /opt/web_cs/venv/bin/python3 is not executable`，服务起不来。
 *
 * 用户裁决（m07836 第 2 项）原话：「仅恢复源码和配置，不能保证服务重新运行。」
 * 最终原则：「依赖必须有明确版本和恢复依据，不能只保证文件存在，却无法保证服务重新运行。」
 *
 * 与 extraFiles 的区别（**不要合并**）：
 *  - extraFiles 收的是**已经存在的文件**（.env / run.sh）：远端 stat 一下就打包；
 *  - depsLocks 收的是**现场生成的快照**：在运行中的 venv 上跑 `pip freeze`，
 *    产物在备份前并不存在，因此**必须先跑命令再打包**，失败模式也完全不同。
 *
 * 设计约定：
 *  - 快照内容 = 完整 `pip freeze` + 精确 Python 版本 + pip 版本 + 生成时间（UTC）+
 *    SHA-256（由远端算，进 MANIFEST）；
 *  - `pip freeze` 是**依赖版本快照，不是离线安装介质**。PyPI 下架某版本时，
 *    单有快照仍装不上。这一点必须写进锁文件头部，避免后来者误以为它是万能的；
 *  - **空快照 / 缺 venv / pip freeze 失败一律 fail-closed**：一个「0 个包」的锁文件
 *    比没有锁文件更危险，因为它看起来是成功的；
 *  - 参数一律经 stdin 传入远端脚本，含换行的值在 JS 侧就拒收。
 */

/** 单台服务器允许的依赖快照条数上限。 */
export const MAX_DEPS_LOCKS = 8;

/** 锁文件首行。恢复侧靠它认出「这是本插件生成的快照」而不是随便一个 requirements.txt。 */
export const LOCK_FILE_HEADER = '# dsh-odoo-backup deps lock v1';

/** 单条快照文件名的后缀，与用户裁决建议的 `web-cs-requirements.lock` 一致。 */
export const LOCK_FILE_SUFFIX = 'requirements.lock';

const MAX_PATH_LENGTH = 512;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/**
 * 从 venv 路径派生快照名。
 *
 * `/opt/web_cs/venv` → `web-cs`：取**父目录**（`venv`/`.venv` 本身没有辨识度），
 * 下划线转连字符（`web_cs` → `web-cs`，与用户裁决建议的文件名一致）。
 * 只有一段时退化为该段本身（`/opt` → `opt`）。
 */
export function deriveLockName(venvPath) {
  const p = String(venvPath ?? '').trim().replace(/\/+$/, '');
  if (!p) return '';
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return '';
  const base = segs[segs.length - 1];
  // venv / .venv / env 这类通用目录名没有辨识度，往上取一级。
  const generic = /^(\.?venv|env|\.env|virtualenv)$/i.test(base);
  const pick = generic && segs.length >= 2 ? segs[segs.length - 2] : base;
  return pick
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39);
}

/** 校验单条依赖快照配置。 */
export function validateDepsLock(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, reason: '依赖快照必须是 { name, venvPath } 对象或 venv 路径字符串' };
  }

  const rawName = item.name;
  const rawPath = item.venvPath;

  if (rawPath === undefined || rawPath === null) {
    return { ok: false, reason: '依赖快照缺少 venvPath（虚拟环境目录的绝对路径）' };
  }
  if (typeof rawPath !== 'string') {
    return { ok: false, reason: 'venvPath 必须是字符串' };
  }
  const p = rawPath.trim();
  if (!p) return { ok: false, reason: 'venvPath 不能为空' };
  if (p.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `venvPath 过长（${p.length} > ${MAX_PATH_LENGTH} 字符）` };
  }
  if (/[\0\n\r\t]/.test(p)) {
    return { ok: false, reason: 'venvPath 不能含换行、制表符或空字节' };
  }
  if (!p.startsWith('/')) {
    return { ok: false, reason: `venvPath 必须是绝对路径（以 / 开头）：${p}` };
  }
  if (p === '/') return { ok: false, reason: '不允许把根目录 / 当作 venvPath' };
  if (p.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: `venvPath 不能含 .. 段：${p}` };
  }
  if (p.endsWith('/')) {
    return { ok: false, reason: `venvPath 不能以 / 结尾（这是目录写法）：${p}` };
  }

  // name 会直接进产物文件名——含斜杠能写出目录外，含空格会让后续 tar/scp 出歧义。
  // 这里**不**做派生：派生逻辑放在 normalizeDepsLocks（只有那条路径知道「用户没写」还是
  // 「用户写了个空的」）。单条校验拿到 undefined 就是缺字段，直接报出来。
  if (rawName === undefined || rawName === null) {
    return { ok: false, reason: '依赖快照缺少 name（产物文件名要用它，例如 web-cs）' };
  }
  const name = String(rawName).trim();
  if (!name) {
    return { ok: false, reason: 'name 不能为空（产物文件名要用它，例如 web-cs）' };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name 只能是小写字母、数字与连字符，且以字母/数字开头（当前：${name}）——它会直接进产物文件名`,
    };
  }

  return { ok: true, lock: { name, venvPath: p } };
}

/**
 * 归一化 servers[].depsLocks。
 *
 * 允许的写法：
 *  - 字符串：只给 venv 路径，name 自动派生；
 *  - `{ name, venvPath }`：显式指定；
 *  - `{ venvPath }`：只给路径，同样派生。
 *
 * 未配置不是错误；配置了就严格校验，**任何一条非法都整体拒绝**。
 * 重复 name（产物文件互相覆盖）与重复 venvPath（同一份快照记两次）都拒绝。
 */
export function normalizeDepsLocks(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, locks: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'depsLocks 必须是数组' };
  }
  if (raw.length > MAX_DEPS_LOCKS) {
    return { ok: false, reason: `依赖快照最多 ${MAX_DEPS_LOCKS} 条，当前 ${raw.length} 条` };
  }

  const locks = [];
  const byName = new Set();
  const byPath = new Set();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const at = `第 ${i + 1} 条依赖快照`;
    // 两种简写都在这一层补 name：字符串 = 只给 venv 路径；
    // `{ venvPath }` = 只给路径。派生需要路径本身，所以只有这里做得了。
    let normalized;
    if (typeof item === 'string') {
      normalized = { name: deriveLockName(item), venvPath: item };
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      normalized = item.name === undefined || item.name === null
        ? { ...item, name: deriveLockName(item.venvPath) }
        : item;
    } else {
      normalized = item;
    }
    const check = validateDepsLock(normalized);
    if (!check.ok) {
      return { ok: false, reason: `${at}：${check.reason}` };
    }
    if (byName.has(check.lock.name)) {
      return { ok: false, reason: `${at}的 name 与前面的条目重复：${check.lock.name}（产物文件会互相覆盖）` };
    }
    if (byPath.has(check.lock.venvPath)) {
      return { ok: false, reason: `${at}与前面的条目 venvPath 重复：${check.lock.venvPath}` };
    }
    byName.add(check.lock.name);
    byPath.add(check.lock.venvPath);
    locks.push(check.lock);
  }

  return { ok: true, locks };
}

/** 锁文件在远端工作目录里的名字。 */
export function lockFileName(name) {
  return `${name}-${LOCK_FILE_SUFFIX}`;
}

function assertNoNewline(value, label) {
  if (/[\0\n\r\t]/.test(String(value))) {
    throw new Error(`${label} 不能含换行、制表符或空字节`);
  }
}

/**
 * 构造依赖快照脚本的 stdin 参数块。
 *
 * 顺序固定：<输出目录> <条数 N> [N 行 name\ttab\tvenvPath]
 * 用 tab 分隔而不是空格：路径里可能含空格（真机 `/root/Documents/Obsidian Vault` 就是）。
 */
export function buildDepsLockStdin({ outDir, locks } = {}) {
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw new Error('outDir 不能为空');
  }
  assertNoNewline(outDir, 'outDir');

  const list = Array.isArray(locks) ? locks : [];
  if (list.length === 0) throw new Error('locks 不能为空');
  if (list.length > MAX_DEPS_LOCKS) {
    throw new Error(`依赖快照最多 ${MAX_DEPS_LOCKS} 条，当前 ${list.length} 条`);
  }

  const rows = [];
  for (const l of list) {
    const check = validateDepsLock(l);
    if (!check.ok) throw new Error(check.reason);
    rows.push(`${check.lock.name}\t${check.lock.venvPath}`);
  }

  return [outDir, String(rows.length), ...rows].join('\n') + '\n';
}

/**
 * 远端依赖快照脚本。
 *
 * 关键纪律：
 *  - 不用 `set -e`：每一段都要自己判定退出码；
 *  - 禁用 `| head`：pipefail 下 SIGPIPE 会提前退出（这个仓库踩过）；
 *  - **先校验再生成**：venv 不存在 / 没有 bin/python / pip freeze 失败 → 整体失败，
 *    一个锁文件都不生成。半套快照比没有更危险；
 *  - `pip freeze` 走**虚拟环境自己的 pip**（`$VENV/bin/pip`），不用系统 pip——
 *    系统 pip 冻结出来的是全局包，与这个 venv 无关；
 *  - 包清单只写进文件，stdout 只出元数据（`DLOCK\t...` 一行一条）。
 */
export function buildDepsLockScript() {
  return `#!/usr/bin/env bash
# 依赖快照收集（v0.3.1）。参数走 stdin，共 2 + N 行：
#   <输出目录> <条数 N> [N 行 name<TAB>venvPath]
# 不使用 set -e：需要自己判定退出码；禁用管道接 head（pipefail 下 SIGPIPE 会提前退出）。
if [ -z "\${BASH_VERSION:-}" ]; then
  echo 'DLOCK_RC=95'
  echo 'DLOCK_ERR=远端没有 bash'
  exit 95
fi
set -uo pipefail

IFS= read -r OUTDIR || OUTDIR=''
IFS= read -r N || N='0'

case "$N" in
  ''|*[!0-9]*)
    echo 'DLOCK_RC=94'
    echo "DLOCK_ERR=条数非法：$N"
    exit 94
    ;;
esac
if [ -z "$OUTDIR" ]; then
  echo 'DLOCK_RC=94'
  echo 'DLOCK_ERR=输出目录为空'
  exit 94
fi
case "$OUTDIR" in
  /*) ;;
  *) echo 'DLOCK_RC=94'; echo "DLOCK_ERR=输出目录必须是绝对路径：$OUTDIR"; exit 94 ;;
esac

NAMES=()
VENVS=()
i=0
while [ "$i" -lt "$N" ]; do
  IFS= read -r row || row=''
  # 用 tab 切分：路径里可能含空格
  nm="\${row%%	*}"
  vp="\${row#*	}"
  if [ -z "$nm" ] || [ -z "$vp" ]; then
    echo 'DLOCK_RC=94'
    echo "DLOCK_ERR=参数行格式非法（应为 name<TAB>venvPath）：$row"
    exit 94
  fi
  NAMES+=("$nm")
  VENVS+=("$vp")
  i=$((i + 1))
done

if [ "\${#VENVS[@]}" -eq 0 ]; then
  echo 'DLOCK_RC=94'
  echo 'DLOCK_ERR=没有给出任何虚拟环境'
  exit 94
fi

mkdir -p "$OUTDIR" || { echo 'DLOCK_RC=94'; echo "DLOCK_ERR=无法创建输出目录：$OUTDIR"; exit 94; }

GENERATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# 失败分类要能区分「目录不存在」（96）与「目录在但不是虚拟环境」（97）：
# 前者是配置写错/路径漂移，后者是备份到了错误的目录。混成一个码会让人查错方向。
RC=0
IDX=0
while [ "$IDX" -lt "\${#VENVS[@]}" ]; do
  NM="\${NAMES[$IDX]}"
  VP="\${VENVS[$IDX]}"
  IDX=$((IDX + 1))

  if [ ! -d "$VP" ]; then
    printf 'DLOCK_MISSING\\t%s\\t%s\\t%s\\n' "$NM" "$VP" '虚拟环境目录不存在'
    [ "$RC" = "0" ] && RC=96
    continue
  fi
  if [ ! -x "$VP/bin/python" ]; then
    printf 'DLOCK_MISSING\\t%s\\t%s\\t%s\\n' "$NM" "$VP" '目录存在但缺少 bin/python（不是虚拟环境）'
    [ "$RC" = "0" ] && RC=97
    continue
  fi
  if [ ! -x "$VP/bin/pip" ]; then
    printf 'DLOCK_MISSING\\t%s\\t%s\\t%s\\n' "$NM" "$VP" '虚拟环境缺少 bin/pip（无法冻结依赖）'
    [ "$RC" = "0" ] && RC=97
    continue
  fi

  PYV="$("$VP/bin/python" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])' 2>/dev/null || echo '')"
  PIPV="$("$VP/bin/pip" --version 2>/dev/null | awk '{print $2}')"

  LOCK="$OUTDIR/$NM-requirements.lock"
  FREEZE_ERR="$OUTDIR/.dlock-err.$$"
  "$VP/bin/pip" freeze > "$LOCK.body" 2>"$FREEZE_ERR"
  FRC=$?
  if [ "$FRC" -ne 0 ]; then
    printf 'DLOCK_RC=98\\n'
    printf 'DLOCK_ERR=pip freeze 退出码 %s: %s\\n' "$FRC" "$(tail -c 300 "$FREEZE_ERR" | tr '\\n' ' ')"
    rm -f "$FREEZE_ERR" "$LOCK.body" 2>/dev/null
    exit 98
  fi
  rm -f "$FREEZE_ERR" 2>/dev/null

  PKGS="$(wc -l < "$LOCK.body" | tr -d ' ')"
  case "$PKGS" in
    ''|*[!0-9]*) PKGS=0 ;;
  esac

  {
    printf '%s\\n' '# dsh-odoo-backup deps lock v1'
    printf '# name: %s\\n' "$NM"
    printf '# venv: %s\\n' "$VP"
    printf '# python: %s\\n' "\${PYV:-未记录}"
    printf '# pip: %s\\n' "\${PIPV:-未记录}"
    printf '# generated: %s\\n' "$GENERATED"
    printf '# packages: %s\\n' "$PKGS"
    printf '# note: pip freeze 是依赖版本快照，不是离线安装介质；PyPI 下架该版本时仍需另行取证（wheel 存档）。\\n'
    printf '# restore: python3 -m venv <target> && <target>/bin/pip install -r <this file>\\n'
    cat "$LOCK.body"
  } > "$LOCK"
  rm -f "$LOCK.body" 2>/dev/null

  LB="$(stat -c %s "$LOCK" 2>/dev/null || echo 0)"
  LS="$(sha256sum "$LOCK" | awk '{print $1}')"
  printf 'DLOCK\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$NM" "$LOCK" "$LB" "$LS" "\${PYV:-未知}" "$PKGS"
done

echo "DLOCK_RC=$RC"
echo "DLOCK_COUNT=\${#VENVS[@]}"
if [ "$RC" -ne 0 ]; then
  echo 'DLOCK_ERR=存在缺失或不可用的虚拟环境'
fi
exit 0
`;
}

/**
 * 统一行尾再切行。
 *
 * 真机事故：远端脚本输出 `DLOCK_RC=0\r\n`，而标记行正则写的是 `(.*)$`。
 * JS 的 `.` 不匹配 `\r`（它是行终止符），于是 `DLOCK_RC=0\r` 整行匹配失败 ——
 * 元数据行（按 \t 切、`parseInt` 能吃下 `34\r`）解析得出来，标记行却匹配不到，
 * 结果「成功生成的锁文件」被判成「远端没有输出 DLOCK_RC，未拿到结果」。
 *
 * 行尾不是远端脚本的语义，是传输链路的属性（Windows 中转、某些 ssh/管道组合）。
 * 同文件的 parseLockFile 早就做了归一化，这里遗漏了。所有面向远端文本的解析
 * 都应先过这一层，否则「换条链路采集」就会变成「换个结论」。
 */
function normalizeLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function readMarks(stdout) {
  const marks = new Map();
  for (const line of normalizeLines(stdout).split('\n')) {
    const m = /^(DLOCK_[A-Z0-9]+)=(.*)$/.exec(line);
    if (m && !marks.has(m[1])) marks.set(m[1], m[2].trim());
  }
  return marks;
}

/**
 * 解析远端依赖快照输出。
 *
 * 任何「拿不到确定结果」都返回 ok:false。尤其是下面这些，它们都会让备份包
 * **看起来有依赖依据，实际却装不起来**：
 *  - 缺 venv（rc=96/97）；
 *  - pip freeze 失败（rc=98）；
 *  - 产物 0 字节或 0 个包；
 *  - 自报条数与实际解析条数不符。
 */
export function parseDepsLockResult(stdout) {
  const marks = readMarks(stdout);
  const entries = [];
  const missing = [];

  for (const line of normalizeLines(stdout).split('\n')) {
    const t = line.trimEnd();
    if (t.startsWith('DLOCK\t')) {
      // DLOCK\t<name>\t<abs path>\t<bytes>\t<sha256>\t<python>\t<packages>
      const p = t.split('\t');
      if (p.length >= 7) {
        const absPath = p[2];
        const slash = absPath.lastIndexOf('/');
        entries.push({
          name: p[1],
          file: slash >= 0 ? absPath.slice(slash + 1) : absPath,
          bytes: Number.parseInt(p[3], 10),
          sha256: String(p[4]).toLowerCase(),
          pythonVersion: p[5],
          packages: Number.parseInt(p[6], 10),
        });
      }
      continue;
    }
    if (t.startsWith('DLOCK_MISSING\t')) {
      const p = t.split('\t');
      if (p.length >= 4) missing.push({ name: p[1], venvPath: p[2], reason: p[3] });
    }
  }

  if (!marks.has('DLOCK_RC')) {
    return {
      ok: false,
      reason: '远端依赖快照脚本没有输出 DLOCK_RC，未拿到结果（可能被杀或被截断）',
      entries,
      missing,
    };
  }

  const rc = Number.parseInt(marks.get('DLOCK_RC'), 10);
  if (!Number.isInteger(rc)) {
    return { ok: false, reason: `远端返回的退出码无法解析：${marks.get('DLOCK_RC')}`, entries, missing };
  }
  const err = (marks.get('DLOCK_ERR') ?? '').trim();

  if (rc === 95) {
    return { ok: false, rc, reason: '远端缺少 bash（依赖快照脚本需要 bash 才能安全捕获管道退出码）', entries, missing };
  }
  if (rc === 94) {
    return { ok: false, rc, reason: `依赖快照参数非法：${err || '未说明'}`, entries, missing };
  }
  if (rc === 96 || rc === 97) {
    const detail = missing.length
      ? missing.map((m) => `${m.name}（${m.venvPath}：${m.reason}）`).join('、')
      : err || '未说明';
    return {
      ok: false,
      rc,
      reason: `虚拟环境缺失或不可用，拒绝生成依赖快照（不静默跳过）：${detail}`,
      entries,
      missing,
    };
  }
  if (rc === 98) {
    return { ok: false, rc, reason: `依赖冻结失败：${err || 'pip freeze 未成功'}`, entries, missing };
  }
  if (rc >= 2) {
    return { ok: false, rc, reason: `依赖快照失败（退出码 ${rc}）：${err || '无错误输出'}`, entries, missing };
  }

  // rc=0 但仍报 MISSING：说明 BAD 计数没生效，这本身是脚本 bug，不能放行。
  if (missing.length) {
    return {
      ok: false,
      rc,
      reason: `依赖快照报告缺失但退出码为 0（脚本状态不一致）：${missing.map((m) => m.name).join('、')}`,
      entries,
      missing,
    };
  }

  for (const e of entries) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      return { ok: false, rc, reason: `依赖快照缺少合法 sha256：${e.name}（${e.sha256 || '缺失'}）`, entries, missing };
    }
    if (!Number.isInteger(e.bytes) || e.bytes <= 0) {
      return { ok: false, rc, reason: `依赖快照字节数非法：${e.name}（${e.bytes}），疑似空快照`, entries, missing };
    }
    if (!Number.isInteger(e.packages) || e.packages <= 0) {
      return {
        ok: false,
        rc,
        reason: `依赖快照里有 0 个包：${e.name}——空快照没有恢复价值，判为失败（否则备份包看起来成功却装不起来）`,
        entries,
        missing,
      };
    }
  }

  const declared = Number.parseInt(marks.get('DLOCK_COUNT') ?? '', 10);
  if (Number.isInteger(declared) && declared !== entries.length) {
    return {
      ok: false,
      rc,
      reason: `依赖快照条数不一致：远端自报 ${declared} 条，实际解析到 ${entries.length} 条`,
      entries,
      missing,
    };
  }

  return { ok: true, rc, entries, missing };
}

/**
 * 解析锁文件文本（恢复侧读回用）。
 *
 * 与 `parseDepsLockResult` 的分工：那个解析**远端脚本的 stdout**，
 * 这个解析**锁文件本身**——恢复时只有文件，没有 stdout。
 */
export function parseLockFile(text) {
  const raw = String(text ?? '');
  // 锁文件可能被 Windows 侧编辑过（CRLF），统一换行后再解析。
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  if (lines.length === 0 || lines[0].trim() !== LOCK_FILE_HEADER) {
    return { ok: false, reason: `锁文件首行不是「${LOCK_FILE_HEADER}」，认不出这是本插件生成的依赖快照` };
  }

  const meta = {};
  const packages = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const m = /^#\s*([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (m) {
      meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    if (line.trim().startsWith('#')) continue;
    const t = line.trim();
    if (!t) continue;
    packages.push(t);
  }

  if (!meta.python || !meta.python.trim()) {
    return { ok: false, reason: '锁文件缺少 python 版本行——没有精确版本就无法判断重建是否可行' };
  }

  const declared = Number.parseInt(meta.packages ?? '', 10);
  if (Number.isInteger(declared) && declared !== packages.length) {
    return {
      ok: false,
      reason: `锁文件自报 ${declared} 个包，实际读到 ${packages.length} 个——快照被截断，不能作为恢复依据`,
    };
  }

  if (packages.length === 0) {
    return { ok: false, reason: '锁文件里有 0 个包——空快照没有恢复价值' };
  }

  return {
    ok: true,
    name: meta.name ?? '',
    venvPath: meta.venv ?? '',
    pythonVersion: meta.python,
    pipVersion: meta.pip ?? '',
    generatedAt: meta.generated ?? '',
    declaredPackages: Number.isInteger(declared) ? declared : packages.length,
    packages,
  };
}

function normalizePkgList(list) {
  const out = [];
  for (const line of Array.isArray(list) ? list : String(list ?? '').split('\n')) {
    const t = String(line ?? '').trim();
    if (!t || t.startsWith('#')) continue;
    out.push(t);
  }
  return out;
}

/**
 * 装完之后的对账：把实际 `pip freeze` 与锁文件比。
 *
 * 三项都要看：
 *  - missing：锁文件里有、实际没装上的（最致命）；
 *  - extra：实际多装了的（不是「多装点没关系」——多装的包会改变行为，
 *    例如别的版本 numpy 会让数值结果漂移）；
 *  - 顺序无关：pip 输出顺序不保证稳定。
 */
export function compareFreezeToLock(actual, expected) {
  const a = normalizePkgList(actual);
  const e = normalizePkgList(expected);
  const setA = new Set(a);
  const setE = new Set(e);
  const missing = e.filter((x) => !setA.has(x)).sort();
  const extra = a.filter((x) => !setE.has(x)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * 恢复侧脚本：按锁文件在目标机重建 venv 并回读 pip freeze 供对账。
 *
 * stdin 四行：<锁文件绝对路径> <目标 venv 目录> <python 可执行文件> <是否删除已存在的目标目录 0|1>
 * 输出：===DREST=== / drest_rc= / drest_created= / ===FREEZE=== … ===FREEZE_END=== / ===END===
 *
 * 为什么错误信息要点名 `python3.12-venv`：真机上 `python3 -m venv` 直接报
 * `ensurepip is not available`，而这条正是「基础设施负责提前准备」清单里
 * 少掉的那一项（用户 m07836 第 3 项裁决）。
 */
export function buildDepsRestoreScript() {
  return `#!/usr/bin/env bash
# 依赖快照恢复（v0.3.1）。参数走 stdin，共 4 行：
#   <锁文件绝对路径> <目标 venv 目录> <python 可执行文件> <允许覆盖 0|1>
# 不使用 set -e；禁用管道接 head。
if [ -z "\${BASH_VERSION:-}" ]; then
  echo 'DREST_RC=95'
  echo 'DREST_ERR=远端没有 bash'
  exit 95
fi
set -uo pipefail

IFS= read -r LOCK || LOCK=''
IFS= read -r TARGET || TARGET=''
IFS= read -r PY || PY=''
IFS= read -r ALLOW || ALLOW='0'

if [ ! -f "$LOCK" ]; then
  echo 'DREST_RC=96'
  echo "DREST_ERR=锁文件不存在：$LOCK"
  exit 96
fi
if [ -z "$TARGET" ]; then
  echo 'DREST_RC=94'
  echo 'DREST_ERR=目标 venv 目录为空'
  exit 94
fi
if [ -z "$PY" ]; then
  PY=python3
fi

if [ -e "$TARGET" ]; then
  if [ "$ALLOW" != "1" ]; then
    echo 'DREST_RC=97'
    echo "DREST_ERR=目标目录已存在且未允许覆盖：$TARGET（恢复演练应指向新目录）"
    exit 97
  fi
  rm -rf "$TARGET" || { echo 'DREST_RC=97'; echo "DREST_ERR=无法删除已存在的目标目录：$TARGET"; exit 97; }
fi

# 目标父目录可能不存在（恢复演练常指向 /tmp/xxx/venv 这类新路径）。
# 不先建的话 python -m venv 会直接退出码 1。
mkdir -p "$(dirname "$TARGET")" 2>/dev/null || {
  echo 'DREST_RC=97'
  echo "DREST_ERR=无法创建目标父目录：$(dirname "$TARGET")"
  exit 97
}

# 错误捕获文件必须落在一定存在的目录（/tmp 或 $TMPDIR），**不能**写成 "$TARGET.xxx"：
# 真机上 "$TARGET" 此刻还不存在，重定向本身就失败，
# 于是 VMSG 恒为空、报错只剩一个冒号，真实原因被日志机制吃掉。
ERRDIR="\${TMPDIR:-/tmp}"
VERR="$ERRDIR/dsh-drest-venv.$$"
"$PY" -m venv "$TARGET" 2>"$VERR"
VRC=$?
if [ "$VRC" -ne 0 ]; then
  VMSG="$(tail -c 400 "$VERR" 2>/dev/null | tr '\\n' ' ')"
  [ -n "$VMSG" ] || VMSG='（无法捕获错误输出，请手动执行 python3 -m venv 复现）'
  rm -f "$VERR" 2>/dev/null
  echo 'DREST_RC=98'
  echo "DREST_ERR=venv 创建失败（退出码 $VRC）：$VMSG"
  case "$VMSG" in
    *ensurepip*|*"not created successfully"*)
      echo 'DREST_HINT=宿主机缺少 python3-venv（Debian/Ubuntu 为 python3.12-venv），ensurepip 不可用；请先预装该包（这是「基础设施负责提前准备」清单的一项）'
      ;;
  esac
  exit 98
fi
rm -f "$VERR" 2>/dev/null

IERR="$ERRDIR/dsh-drest-pip.$$"
"$TARGET/bin/pip" install --no-input -r "$LOCK" 2>"$IERR"
IRC=$?
if [ "$IRC" -ne 0 ]; then
  IMSG="$(tail -c 400 "$IERR" 2>/dev/null | tr '\\n' ' ')"
  [ -n "$IMSG" ] || IMSG='（无法捕获错误输出）'
  rm -f "$IERR" 2>/dev/null
  echo 'DREST_RC=99'
  echo "DREST_ERR=按锁文件安装失败（退出码 $IRC）：$IMSG"
  echo 'DREST_HINT=pip freeze 是版本快照而非离线介质；若 PyPI 已下架该版本，需要用 wheel 存档重建'
  exit 99
fi
rm -f "$IERR" 2>/dev/null

echo '===FREEZE==='
"$TARGET/bin/pip" freeze 2>/dev/null
echo '===FREEZE_END==='
echo 'DREST_RC=0'
echo 'drest_created=1'
echo '===END==='
exit 0
`;
}
