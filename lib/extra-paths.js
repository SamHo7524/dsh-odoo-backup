/**
 * 额外路径（extra paths）备份的纯函数层。
 *
 * 定位：本模块只做「校验 / 脚本生成 / 输出解析 / 空间预算」，不触碰网络与文件系统，
 * 便于用单元测试把协议钉死。真正的远端执行由 lib/backup.js 通过 deps.execRemote 调用。
 *
 * 设计约定（v0.2.2）：
 *  - 参数一律经 stdin 传入远端脚本（脚本本身走 argv base64），因此任何含换行的值都必须拒收；
 *  - 名称会进入文件名（<name>-<ts>.tar.zst），必须防目录穿越与内置项重名；
 *  - 远端失败不静默：路径不存在/不可读直接失败，不像 addons 那样记 present:false 后照样出包。
 */

/** 单台服务器允许的额外路径条数上限。 */
export const MAX_EXTRAS = 8;

/** 与内置备份项（dump/addons/pydeps/conf/manifest）冲突的名称，统一小写比对。 */
export const RESERVED_EXTRA_NAMES = ['addons', 'pydeps', 'conf', 'dump', 'manifest', 'odoo'];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MAX_PATH_LENGTH = 512;
const MAX_EXCLUDE_LENGTH = 200;

/** 校验额外路径的名称（会作为文件名前缀使用）。 */
export function validateExtraName(name) {
  if (typeof name !== 'string') {
    return { ok: false, reason: '额外路径名称必须是字符串' };
  }
  const n = name.trim();
  if (!n) {
    return { ok: false, reason: '额外路径名称不能为空' };
  }
  if (!NAME_RE.test(n)) {
    return {
      ok: false,
      reason: `额外路径名称「${n}」非法：只能用字母、数字、连字符和下划线，首字符为字母或数字，长度 1-32`,
    };
  }
  if (RESERVED_EXTRA_NAMES.includes(n.toLowerCase())) {
    return { ok: false, reason: `额外路径名称「${n}」与内置备份项重名，请换一个名称` };
  }
  return { ok: true, name: n };
}

/** 校验额外路径的绝对路径。 */
export function validateExtraPath(path) {
  if (typeof path !== 'string') {
    return { ok: false, reason: '额外路径必须是字符串' };
  }
  const p = path.trim();
  if (!p) {
    return { ok: false, reason: '额外路径不能为空' };
  }
  if (p.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `额外路径过长（${p.length} > ${MAX_PATH_LENGTH} 字符）` };
  }
  if (/[\0\n\r]/.test(p)) {
    return { ok: false, reason: '额外路径不能含换行或空字节' };
  }
  if (!p.startsWith('/')) {
    return { ok: false, reason: `额外路径必须是绝对路径（以 / 开头）：${p}` };
  }
  if (p === '/') {
    return { ok: false, reason: '不允许把根目录 / 作为额外路径' };
  }
  if (p.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: `额外路径不能含 .. 段：${p}` };
  }
  return { ok: true, path: p };
}

/** 校验单条 exclude 模式。 */
function validateExcludeList(exclude) {
  if (exclude === undefined || exclude === null) {
    return { ok: true, list: [] };
  }
  if (!Array.isArray(exclude)) {
    return { ok: false, reason: 'exclude 必须是字符串数组' };
  }
  const list = [];
  for (const item of exclude) {
    if (typeof item !== 'string') {
      return { ok: false, reason: 'exclude 的每一项都必须是字符串' };
    }
    const s = item.trim();
    if (!s) {
      return { ok: false, reason: 'exclude 不能含空字符串' };
    }
    if (/[\0\n\r]/.test(s)) {
      return { ok: false, reason: 'exclude 模式不能含换行' };
    }
    if (s.length > MAX_EXCLUDE_LENGTH) {
      return { ok: false, reason: `exclude 模式过长（>${MAX_EXCLUDE_LENGTH} 字符）` };
    }
    list.push(s);
  }
  return { ok: true, list };
}

/**
 * 归一化 servers[].extraPaths。
 *
 * 未配置（undefined/null/空数组）不是错误，返回空列表；一旦配置了就用严格规则校验，
 * 任何一条非法都整体拒绝——不允许「一部分生效、一部分被静默忽略」。
 */
export function normalizeExtras(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, extras: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'extraPaths 必须是数组' };
  }
  if (raw.length > MAX_EXTRAS) {
    return { ok: false, reason: `额外路径最多 ${MAX_EXTRAS} 条，当前 ${raw.length} 条` };
  }

  const extras = [];
  const seen = new Map();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const at = `第 ${i + 1} 条额外路径`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: `${at}不是对象` };
    }

    const nameCheck = validateExtraName(item.name);
    if (!nameCheck.ok) {
      return { ok: false, reason: `${at}：${nameCheck.reason}` };
    }
    const pathCheck = validateExtraPath(item.path);
    if (!pathCheck.ok) {
      return { ok: false, reason: `${at}（${nameCheck.name}）：${pathCheck.reason}` };
    }

    const lower = nameCheck.name.toLowerCase();
    if (seen.has(lower)) {
      return {
        ok: false,
        reason: `${at}与第 ${seen.get(lower) + 1} 条重名（名称不区分大小写）：${nameCheck.name}`,
      };
    }
    seen.set(lower, i);

    const excludeCheck = validateExcludeList(item.exclude);
    if (!excludeCheck.ok) {
      return { ok: false, reason: `${at}（${nameCheck.name}）：${excludeCheck.reason}` };
    }

    let maxBytes = null;
    if (item.maxBytes !== undefined && item.maxBytes !== null) {
      if (typeof item.maxBytes !== 'number' || !Number.isInteger(item.maxBytes) || item.maxBytes <= 0) {
        return { ok: false, reason: `${at}（${nameCheck.name}）：maxBytes 必须是正整数` };
      }
      maxBytes = item.maxBytes;
    }

    extras.push({
      name: nameCheck.name,
      path: pathCheck.path,
      exclude: excludeCheck.list,
      maxBytes,
    });
  }

  return { ok: true, extras };
}
// ───────────────────────── 远端脚本协议层 ─────────────────────────

/** 人读字节数：≥1 GiB 用 GB（1024 进制）一位小数，≥1 MiB 用 MB，否则 KB/B。 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function assertNoNewline(value, label) {
  if (/[\0\n\r]/.test(value)) {
    throw new Error(`${label} 不能含换行或空字节`);
  }
}

/**
 * 构造打包脚本的 stdin 参数块。
 *
 * 参数必须走 stdin 而不是命令行：脚本经 base64 塞在 ssh argv 里，路径再拼进 argv
 * 会同时踩到 shell 转义与长度上限两个坑。约定顺序固定，脚本按行 read。
 */
export function buildExtraPackStdin({ path, outFile, compressor, exclude } = {}) {
  const p = validateExtraPath(path);
  if (!p.ok) throw new Error(p.reason);

  if (typeof outFile !== 'string' || !outFile.trim()) {
    throw new Error('outFile 不能为空');
  }
  assertNoNewline(outFile, 'outFile');

  if (compressor !== 'zstd' && compressor !== 'gzip') {
    throw new Error(`压缩器只支持 zstd 或 gzip，收到：${compressor}`);
  }

  const ex = exclude === undefined || exclude === null ? [] : exclude;
  if (!Array.isArray(ex)) throw new Error('exclude 必须是数组');
  for (const item of ex) {
    if (typeof item !== 'string') throw new Error('排除项必须是字符串');
    assertNoNewline(item, '排除项');
  }

  return [p.path, outFile, compressor, String(ex.length), ...ex].join('\n') + '\n';
}

function readMarkers(stdout) {
  const marks = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^(EXTRA_[A-Z0-9]+)=(.*)$/.exec(line);
    if (m && !marks.has(m[1])) marks.set(m[1], m[2].trim());
  }
  return marks;
}

/** 解析远端打包脚本的输出标记。任何「拿不到确定结果」都返回 ok:false。 */
export function parseExtraPackResult(stdout) {
  const marks = readMarkers(stdout);

  if (!marks.has('EXTRA_RC')) {
    return { ok: false, reason: '远端打包脚本没有输出 EXTRA_RC，未拿到结果（可能被杀或被截断）' };
  }

  const rc = Number.parseInt(marks.get('EXTRA_RC'), 10);
  if (!Number.isInteger(rc)) {
    return { ok: false, reason: `远端返回的退出码无法解析：${marks.get('EXTRA_RC')}` };
  }
  const err = marks.get('EXTRA_ERR') ?? '';

  if (rc === 95) return { ok: false, rc, reason: '远端缺少 bash（额外路径打包脚本需要 bash 才能安全捕获管道退出码）' };
  if (rc === 96) return { ok: false, rc, reason: `额外路径不可读，无法打包：${err}` };
  if (rc === 97) return { ok: false, rc, reason: `额外路径不存在或不是目录：${err}` };
  if (rc === 98) return { ok: false, rc, reason: `排除模式不合法（必须相对额外路径根、不以 / 开头）：${err}` };
  if (rc >= 2) {
    return { ok: false, rc, reason: `额外路径打包失败（tar 退出码 ${rc}）：${err || '无错误输出'}` };
  }

  const zrc = Number.parseInt(marks.get('EXTRA_ZRC') ?? '', 10);
  if (zrc !== 0) {
    return {
      ok: false,
      rc,
      reason: `额外路径压缩失败（压缩器退出码 ${Number.isInteger(zrc) ? zrc : '未知'}），产物不可用：${err || '无错误输出'}`,
    };
  }

  const bytes = Number.parseInt(marks.get('EXTRA_BYTES') ?? '', 10);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    return { ok: false, rc, reason: `额外路径打包产物字节数非法（${marks.get('EXTRA_BYTES') ?? '缺失'}），疑似空包` };
  }

  const sha256 = (marks.get('EXTRA_SHA256') ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return { ok: false, rc, reason: `额外路径打包产物缺少合法 sha256（${marks.get('EXTRA_SHA256') ?? '缺失'}）` };
  }

  return {
    ok: true,
    rc,
    bytes,
    sha256,
    warning: rc === 1 ? `打包过程中有文件被并发修改（tar 退出码 1，产物仍可用）：${err || '无错误输出'}` : '',
  };
}

/** 解析预检脚本输出：条目体积 + 远端可用空间。 */
export function parseExtraProbe(stdout) {
  const entries = [];
  let availableBytes = null;
  let rc = null;

  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trimEnd();
    if (t.startsWith('PROBE\t')) {
      const m = /^PROBE\t([01])\t(.*)\t(\d+)$/.exec(t);
      if (m) {
        entries.push({
          path: m[2],
          exists: m[1] === '1',
          bytes: Number.parseInt(m[3], 10),
        });
      }
      continue;
    }
    if (t.startsWith('AVAIL\t')) {
      const m = /^AVAIL\t(\d+)$/.exec(t);
      if (m) availableBytes = Number.parseInt(m[1], 10);
      continue;
    }
    const r = /^PROBE_RC=(\d+)$/.exec(t);
    if (r) rc = Number.parseInt(r[1], 10);
  }

  if (rc === 95) {
    return { ok: false, reason: '远端缺少 bash，无法执行额外路径预检（需要 bash 才能读 stdin 参数）' };
  }
  if (rc === 98) {
    return { ok: false, reason: '额外路径预检参数非法（条数不是数字）' };
  }
  if (rc !== 0) {
    return { ok: false, reason: rc === null ? '远端预检脚本没有输出 PROBE_RC，未拿到结果' : `额外路径预检失败（退出码 ${rc}）` };
  }

  return { ok: true, entries, availableBytes };
}

/**
 * 远端空间预算。
 *
 * 需求 = 额外路径原始体积 × 1.5 + dump 体积 × 2 + 余量。
 *  ×1.5 是打包产物 + 可能的重跑；×2 是 dump 在 odoo 容器内生成后再 docker cp 到宿主机，
 *  同一份数据在远端会短暂存在两份。余量 512 MiB 兜住日志与临时文件。
 */
export function planExtrasSpace({ dumpBytes, extraBytes, availableBytes, marginBytes } = {}) {
  const margin = Number.isInteger(marginBytes) ? marginBytes : 512 * 1024 * 1024;
  const extra = Number.isFinite(extraBytes) ? extraBytes : 0;
  const dump = Number.isFinite(dumpBytes) ? dumpBytes : 0;
  const requiredBytes = Math.ceil(extra * 1.5 + dump * 2 + margin);

  if (!Number.isFinite(availableBytes) || availableBytes === null) {
    return {
      ok: false,
      requiredBytes,
      message: `无法确认远端可用空间，拒绝在盲区打包（需要约 ${humanBytes(requiredBytes)}）`,
    };
  }

  if (availableBytes < requiredBytes) {
    return {
      ok: false,
      requiredBytes,
      message: `额外路径与 dump 打包需要约 ${humanBytes(requiredBytes)} 远端空间，当前可用 ${humanBytes(availableBytes)}；请清理远端 /tmp 或临时移除部分额外路径`,
    };
  }

  return { ok: true, requiredBytes, message: `远端空间充足：需要约 ${humanBytes(requiredBytes)}，可用 ${humanBytes(availableBytes)}` };
}

/** 远端打包脚本（固定文本，参数一律走 stdin）。 */
export function buildExtraPackScript() {
  return `#!/usr/bin/env bash
# 额外路径打包（v0.2.2）。参数走 stdin，共 4 + N 行：
#   <源目录> <输出文件> <zstd|gzip> <排除条数 N> [N 行排除模式]
# 不使用 set -e：需要自己判定退出码；禁用管道接字符串过滤（pipefail 下 SIGPIPE 会提前退出）。
if [ -z "\${BASH_VERSION:-}" ]; then
  echo 'EXTRA_RC=95'
  echo 'EXTRA_ERR=远端没有 bash'
  exit 95
fi
set -uo pipefail

IFS= read -r SRC || SRC=''
IFS= read -r OUT || OUT=''
IFS= read -r COMP || COMP='zstd'
IFS= read -r NEX || NEX='0'

case "$NEX" in
  ''|*[!0-9]*)
    echo 'EXTRA_RC=98'
    echo "EXTRA_ERR=排除条数非法：$NEX"
    exit 98
    ;;
esac
if [ -n "$SRC" ]; then case "$SRC" in /*) ;; *) echo 'EXTRA_RC=98'; echo "EXTRA_ERR=源目录必须是绝对路径：$SRC"; exit 98 ;; esac; fi

EXCL=()
i=0
while [ "$i" -lt "$NEX" ]; do
  IFS= read -r pat || pat=''
  case "$pat" in
    ''|/*)
      echo 'EXTRA_RC=98'
      echo "EXTRA_ERR=排除模式不合法（不能为空、不能以 / 开头）：$pat"
      exit 98
      ;;
  esac
  EXCL+=("--exclude=$pat")
  i=$((i + 1))
done

if [ ! -d "$SRC" ]; then
  if [ ! -e "$SRC" ]; then
    echo 'EXTRA_RC=97'
    echo "EXTRA_ERR=路径不存在：$SRC"
    exit 97
  fi
  echo 'EXTRA_RC=97'
  echo "EXTRA_ERR=不是目录：$SRC"
  exit 97
fi
if [ ! -r "$SRC" ]; then
  echo 'EXTRA_RC=96'
  echo "EXTRA_ERR=目录不可读：$SRC"
  exit 96
fi

OUTDIR="$(dirname "$OUT")"
mkdir -p "$OUTDIR" || { echo 'EXTRA_RC=99'; echo "EXTRA_ERR=无法创建输出目录：$OUTDIR"; exit 99; }
ERRF="$OUTDIR/.extra-err.$$"
export COPYFILE_DISABLE=1

if [ "$COMP" = 'zstd' ]; then
  tar -C "$SRC" --numeric-owner "\${EXCL[@]}" -cf - -- . 2>"$ERRF" | zstd -3 -q -f -o "$OUT" -
  st=("\${PIPESTATUS[@]}")
else
  tar -C "$SRC" --numeric-owner "\${EXCL[@]}" -cf - -- . 2>"$ERRF" | gzip -6 -c > "$OUT"
  st=("\${PIPESTATUS[@]}")
fi

TRC="\${st[0]:-1}"
ZRC="\${st[1]:-1}"

BYTES=0
SHA=''
if [ -f "$OUT" ]; then
  BYTES="$(wc -c < "$OUT" | tr -d ' ')"
  SHA="$(sha256sum "$OUT" | awk '{print $1}')"
fi

echo "EXTRA_RC=$TRC"
echo "EXTRA_ZRC=$ZRC"
echo "EXTRA_BYTES=$BYTES"
echo "EXTRA_SHA256=$SHA"
if [ -s "$ERRF" ]; then
  echo "EXTRA_ERR=$(tail -c 400 "$ERRF" | tr '\\n' ' ')"
else
  echo 'EXTRA_ERR='
fi
rm -f "$ERRF" 2>/dev/null
exit 0
`;
}

/** 远端预检脚本（只读：算各路径体积与 / 可用空间）。 */
export function buildExtraProbeScript() {
  return `#!/usr/bin/env bash
# 额外路径预检（只读）。stdin 共 1 + N 行：<路径条数 N> [N 行绝对路径]
if [ -z "\${BASH_VERSION:-}" ]; then
  echo 'PROBE_RC=95'
  exit 95
fi
set -uo pipefail

IFS= read -r NP || NP='0'
case "$NP" in
  ''|*[!0-9]*)
    echo 'PROBE_RC=98'
    exit 98
    ;;
esac

i=0
while [ "$i" -lt "$NP" ]; do
  IFS= read -r P || P=''
  if [ -d "$P" ] || [ -f "$P" ]; then
    B="$(du -sb "$P" 2>/dev/null | awk '{print $1}')"
    [ -z "$B" ] && B=0
    printf 'PROBE\\t1\\t%s\\t%s\\n' "$P" "$B"
  else
    printf 'PROBE\\t0\\t%s\\t0\\n' "$P"
  fi
  i=$((i + 1))
done

AV="$(df -B1 / 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$AV" ]; then
  printf 'AVAIL\\t%s\\n' "$AV"
fi
echo 'PROBE_RC=0'
exit 0
`;
}
