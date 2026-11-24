/**
 * 加密单文件收集（extra files）的纯函数层。
 *
 * 与 `extra-paths.js` 的区别（**不要合并**）：
 *  - extraPaths 的远端脚本用 `[ -d "$SRC" ]` 校验，**只接受目录**；单文件走那条路必然 fail-closed。
 *  - extraPaths 的名额上限是 MAX_EXTRAS=8，用来装「一整棵业务目录」；
 *    这里装的是「散落在系统目录里的几个关键文件」，两者不该抢名额。
 *  - 这里收集的东西按定义是**敏感配置**（容器 .env、启动脚本），所以只进加密主包，
 *    绝不进 L2 的未加密 tar.gz。
 *
 * 设计约定（v0.2.9）：
 *  - 参数一律经 stdin 传入远端脚本，任何含换行的值都必须拒收；
 *  - **缺失或不可读一律失败**，不静默跳过——「少了一个 .env 的备份包」比没有包更危险，
 *    因为它看起来是成功的；
 *  - 打包成员保留原始绝对路径结构（`tar -C /` + 去掉前导 `/`），恢复时 `tar -C / -xzf`
 *    直接还原到原位置；`--numeric-owner` 保留 uid/gid 数字，mode 由 tar 自然保留；
 *  - MANIFEST 只记路径 / 字节 / sha256 / mode / uid / gid，**绝不记文件内容**。
 */

/** 单台服务器允许的加密单文件条数上限。 */
export const MAX_EXTRA_FILES = 16;

const MAX_PATH_LENGTH = 512;

/** 校验单个文件的绝对路径。 */
export function validateExtraFile(path) {
  if (typeof path !== 'string') {
    return { ok: false, reason: '单文件路径必须是字符串' };
  }
  const p = path.trim();
  if (!p) {
    return { ok: false, reason: '单文件路径不能为空' };
  }
  if (p.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `单文件路径过长（${p.length} > ${MAX_PATH_LENGTH} 字符）` };
  }
  if (/[\0\n\r\t]/.test(p)) {
    return { ok: false, reason: '单文件路径不能含换行、制表符或空字节' };
  }
  if (!p.startsWith('/')) {
    return { ok: false, reason: `单文件路径必须是绝对路径（以 / 开头）：${p}` };
  }
  if (p === '/') {
    return { ok: false, reason: '不允许把根目录 / 当作单文件路径' };
  }
  if (p.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: `单文件路径不能含 .. 段：${p}` };
  }
  if (p.endsWith('/')) {
    return { ok: false, reason: `单文件路径不能以 / 结尾（这是目录写法）：${p}` };
  }
  return { ok: true, path: p };
}

/**
 * 归一化 servers[].extraFiles。
 *
 * 未配置不是错误；一旦配置了就严格校验，任何一条非法都整体拒绝。
 * 重复路径也拒绝：同一条路径配两次只会让 MANIFEST 出现两条一模一样的记录，
 * 且让人误以为备份了两个不同的东西。
 */
export function normalizeExtraFiles(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, files: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'extraFiles 必须是数组' };
  }
  if (raw.length > MAX_EXTRA_FILES) {
    return { ok: false, reason: `单文件最多 ${MAX_EXTRA_FILES} 条，当前 ${raw.length} 条` };
  }

  const files = [];
  const seen = new Set();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const at = `第 ${i + 1} 条单文件`;
    // 允许两种写法：字符串，或 { path } 对象。字符串写法是为了让手写配置更短。
    const rawPath = typeof item === 'string' ? item : item && typeof item === 'object' ? item.path : undefined;
    if (rawPath === undefined) {
      return { ok: false, reason: `${at}不是字符串或 { path } 对象` };
    }
    const check = validateExtraFile(rawPath);
    if (!check.ok) {
      return { ok: false, reason: `${at}：${check.reason}` };
    }
    if (seen.has(check.path)) {
      return { ok: false, reason: `${at}与前面的条目重复：${check.path}` };
    }
    seen.add(check.path);
    files.push({ path: check.path });
  }

  return { ok: true, files };
}

/** 从绝对路径取 basename，用于 MANIFEST 里给人看的标识。 */
export function fileLabel(path) {
  const s = String(path ?? '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function assertNoNewline(value, label) {
  if (/[\0\n\r\t]/.test(value)) {
    throw new Error(`${label} 不能含换行、制表符或空字节`);
  }
}

/**
 * 构造单文件打包脚本的 stdin 参数块。
 *
 * 顺序固定：<输出文件> <条数 N> [N 行绝对路径]
 */
export function buildExtraFilesPackStdin({ files, outFile } = {}) {
  if (typeof outFile !== 'string' || !outFile.trim()) {
    throw new Error('outFile 不能为空');
  }
  assertNoNewline(outFile, 'outFile');

  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    throw new Error('files 不能为空');
  }
  if (list.length > MAX_EXTRA_FILES) {
    throw new Error(`单文件最多 ${MAX_EXTRA_FILES} 条，当前 ${list.length} 条`);
  }

  const paths = [];
  for (const f of list) {
    const p = typeof f === 'string' ? f : f?.path;
    const check = validateExtraFile(p);
    if (!check.ok) throw new Error(check.reason);
    paths.push(check.path);
  }

  return [outFile, String(paths.length), ...paths].join('\n') + '\n';
}

function readMarks(stdout) {
  const marks = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^(EFILE_[A-Z0-9]+)=(.*)$/.exec(line);
    if (m && !marks.has(m[1])) marks.set(m[1], m[2].trim());
  }
  return marks;
}

/**
 * 解析远端单文件打包输出。
 *
 * 返回 `{ok:true, bytes, sha256, entries, missing}`。
 * 任何「拿不到确定结果」都返回 ok:false——尤其是**缺失文件**，它必须是一条明确的失败，
 * 而不是一个「其余都备份成功了」的含糊成功。
 */
export function parseExtraFilesPackResult(stdout) {
  const marks = readMarks(stdout);
  const entries = [];
  const missing = [];

  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trimEnd();
    if (t.startsWith('EFILE\t')) {
      // EFILE\t<path>\t<bytes>\t<mode>\t<uid>\t<gid>\t<sha256>
      const parts = t.split('\t');
      if (parts.length >= 7) {
        entries.push({
          path: parts[1],
          bytes: Number.parseInt(parts[2], 10),
          mode: parts[3],
          uid: Number.parseInt(parts[4], 10),
          gid: Number.parseInt(parts[5], 10),
          sha256: parts[6],
        });
      }
      continue;
    }
    if (t.startsWith('EFILE_MISSING\t')) {
      const parts = t.split('\t');
      if (parts.length >= 3) missing.push({ path: parts[1], reason: parts[2] });
    }
  }

  if (!marks.has('EFILE_RC')) {
    return {
      ok: false,
      reason: '远端单文件脚本没有输出 EFILE_RC，未拿到结果（可能被杀或被截断）',
      entries,
      missing,
    };
  }

  const rc = Number.parseInt(marks.get('EFILE_RC'), 10);
  if (!Number.isInteger(rc)) {
    return { ok: false, reason: `远端返回的退出码无法解析：${marks.get('EFILE_RC')}`, entries, missing };
  }
  const err = (marks.get('EFILE_ERR') ?? '').trim();

  if (rc === 95) {
    return { ok: false, rc, reason: '远端缺少 bash（单文件收集脚本需要 bash 才能安全捕获管道退出码）', entries, missing };
  }
  if (rc === 96) {
    // 缺文件是这里最要紧的失败模式：不打包、不降级，把缺了谁一条条报出来。
    const detail = missing.length
      ? missing.map((m) => `${m.path}（${m.reason}）`).join('、')
      : err || '未说明';
    return {
      ok: false,
      rc,
      reason: `单文件缺失或不可读，拒绝生成备份（不静默跳过）：${detail}`,
      entries,
      missing,
    };
  }
  if (rc === 98) {
    return { ok: false, rc, reason: `单文件收集参数非法：${err}`, entries, missing };
  }
  if (rc >= 2) {
    return { ok: false, rc, reason: `单文件打包失败（tar 退出码 ${rc}）：${err || '无错误输出'}`, entries, missing };
  }

  const bytes = Number.parseInt(marks.get('EFILE_BYTES') ?? '', 10);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    return {
      ok: false,
      rc,
      reason: `单文件打包产物字节数非法（${marks.get('EFILE_BYTES') ?? '缺失'}），疑似空包`,
      entries,
      missing,
    };
  }

  const sha256 = (marks.get('EFILE_SHA256') ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return { ok: false, rc, reason: `单文件打包产物缺少合法 sha256（${marks.get('EFILE_SHA256') ?? '缺失'}）`, entries, missing };
  }

  // 打包成功但条目数与远端自报不符 → 说明有文件没进包，不能算成功。
  const declared = Number.parseInt(marks.get('EFILE_COUNT') ?? '', 10);
  if (Number.isInteger(declared) && declared !== entries.length) {
    return {
      ok: false,
      rc,
      reason: `单文件条目数不一致：远端自报 ${declared} 条，实际解析到 ${entries.length} 条`,
      entries,
      missing,
    };
  }

  return { ok: true, rc, bytes, sha256, entries, missing };
}

/**
 * 远端单文件收集脚本。
 *
 * 关键纪律：
 *  - 不用 `set -e`：每一段都要自己判定退出码；
 *  - 禁用 `| head`：pipefail 下 SIGPIPE 会提前退出；
 *  - 先逐条 stat/校验，**有任何一个不满足就整体失败**，一个文件都不打包；
 *  - 成员名是去掉前导 `/` 的绝对路径，恢复时 `tar -C / -xzf` 原位还原。
 */
export function buildExtraFilesPackScript() {
  return `#!/usr/bin/env bash
# 加密单文件收集（v0.2.9）。参数走 stdin，共 2 + N 行：
#   <输出文件> <文件条数 N> [N 行绝对路径]
# 不使用 set -e：需要自己判定退出码；禁用管道接 head（pipefail 下 SIGPIPE 会提前退出）。
if [ -z "\${BASH_VERSION:-}" ]; then
  echo 'EFILE_RC=95'
  echo 'EFILE_ERR=远端没有 bash'
  exit 95
fi
set -uo pipefail

IFS= read -r OUT || OUT=''
IFS= read -r NF || NF='0'

case "$NF" in
  ''|*[!0-9]*)
    echo 'EFILE_RC=98'
    echo "EFILE_ERR=条数非法：$NF"
    exit 98
    ;;
esac
if [ -z "$OUT" ]; then
  echo 'EFILE_RC=98'
  echo 'EFILE_ERR=输出文件为空'
  exit 98
fi
case "$OUT" in
  /*) ;;
  *) echo 'EFILE_RC=98'; echo "EFILE_ERR=输出文件必须是绝对路径：$OUT"; exit 98 ;;
esac

PATHS=()
MEMBERS=()
i=0
while [ "$i" -lt "$NF" ]; do
  IFS= read -r p || p=''
  case "$p" in
    /*) ;;
    *) echo 'EFILE_RC=98'; echo "EFILE_ERR=路径必须是绝对路径：$p"; exit 98 ;;
  esac
  case "/$p/" in
    */../*) echo 'EFILE_RC=98'; echo "EFILE_ERR=路径不能含 .. 段：$p"; exit 98 ;;
  esac
  PATHS+=("$p")
  MEMBERS+=("\${p#/}")
  i=$((i + 1))
done

if [ "\${#PATHS[@]}" -eq 0 ]; then
  echo 'EFILE_RC=98'
  echo 'EFILE_ERR=没有给出任何文件'
  exit 98
fi

# 逐条校验：存在 / 是普通文件 / 可读。任何一条不满足就整体失败，一个都不打包。
BAD=0
for p in "\${PATHS[@]}"; do
  if [ ! -e "$p" ]; then
    printf 'EFILE_MISSING\\t%s\\t%s\\n' "$p" '不存在'
    BAD=1
  elif [ ! -f "$p" ]; then
    printf 'EFILE_MISSING\\t%s\\t%s\\n' "$p" '不是普通文件'
    BAD=1
  elif [ ! -r "$p" ]; then
    printf 'EFILE_MISSING\\t%s\\t%s\\n' "$p" '不可读'
    BAD=1
  fi
done
if [ "$BAD" -ne 0 ]; then
  echo 'EFILE_RC=96'
  echo 'EFILE_ERR=存在缺失或不可读的单文件'
  exit 96
fi

OUTDIR="$(dirname "$OUT")"
mkdir -p "$OUTDIR" || { echo 'EFILE_RC=99'; echo "EFILE_ERR=无法创建输出目录：$OUTDIR"; exit 99; }
ERRF="$OUTDIR/.efile-err.$$"
export COPYFILE_DISABLE=1

tar -C / --numeric-owner -czf "$OUT" -- "\${MEMBERS[@]}" 2>"$ERRF"
TRC=$?

BYTES=0
SHA=''
if [ -f "$OUT" ]; then
  BYTES="$(wc -c < "$OUT" | tr -d ' ')"
  SHA="$(sha256sum "$OUT" | awk '{print $1}')"
fi

# 逐文件元数据：只报路径 / 字节 / 权限 / uid / gid / sha256，**不输出内容**
for p in "\${PATHS[@]}"; do
  FB="$(stat -c %s "$p" 2>/dev/null || echo 0)"
  FM="$(stat -c %a "$p" 2>/dev/null || echo '?')"
  FU="$(stat -c %u "$p" 2>/dev/null || echo -1)"
  FG="$(stat -c %g "$p" 2>/dev/null || echo -1)"
  FH="$(sha256sum "$p" 2>/dev/null | awk '{print $1}')"
  printf 'EFILE\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$FB" "$FM" "$FU" "$FG" "$FH"
done

echo "EFILE_RC=$TRC"
echo "EFILE_COUNT=\${#PATHS[@]}"
echo "EFILE_BYTES=$BYTES"
echo "EFILE_SHA256=$SHA"
if [ -s "$ERRF" ]; then
  echo "EFILE_ERR=$(tail -c 400 "$ERRF" | tr '\\n' ' ')"
else
  echo 'EFILE_ERR='
fi
rm -f "$ERRF" 2>/dev/null
exit 0
`;
}
