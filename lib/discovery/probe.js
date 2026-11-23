/**
 * 存在性探针（只读）。
 *
 * 为什么必须有这一层：AC 里写着「不存在或不可读的路径不能进建议」。目录扫描能
 * 从挂载、unit、代码里"读到一个路径"，但**读到 ≠ 存在**：容器可能已删、unit 可能
 * 指向旧目录、代码里的字面量可能只是注释。把不存在的路径写进 extraPaths 会让
 * 下一次备份整体 fail-closed（`lib/extras-runner.js` 的存在性检查会直接 throw）。
 *
 * 一次 execRemote 批量验证全部候选，避免 N 次 SSH 往返。
 */

/**
 * 构造探针脚本。路径走 stdin（每行一个），这是 execRemote 的契约。
 *
 * 输出 `P\t<存在>\t<字节>\t<可读>\t<是目录>\t<路径>`。
 * 「是目录」这一列是 2026-11-23 真机误报逼出来的：`extraPaths` 只支持目录
 * （`validateExtraPath` + 远端 `[ -d "$SRC" ]`），但容器把 `.env`、`run.sh`
 * 这类单文件挂进来时扫描会把它们当候选。不区分目录/文件就只能靠猜。
 */
export function buildExistenceProbeScript() {
  return `set -uo pipefail

while IFS= read -r p; do
  [ -z "\${p:-}" ] && continue
  if [ -e "$p" ]; then
    ex=1
    rd=0
    d=0
    [ -r "$p" ] && rd=1
    [ -d "$p" ] && d=1
    sz=$(du -sb "$p" 2>/dev/null | awk '{print $1}')
    [ -z "\${sz:-}" ] && sz=-1
    printf 'P\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$ex" "$sz" "$rd" "$d" "$p"
  else
    printf 'P\\t0\\t-1\\t0\\t0\\t%s\\n' "$p"
  fi
done

echo "PROBE_RC=0"
`;
}

/**
 * 解析探针输出。
 *
 * 缺 `PROBE_RC` 一律当失败：远端没跑完时返回「所有路径都不存在」会比报错更危险——
 * 报告会把真实存在的目录写成"不存在"，用户据此删配置。
 *
 * 兼容两种行格式（4 列旧 / 5 列含「是目录」）：
 * 旧格式没有目录位时 `isDir` 为 `null`（未知），上层据此**不做**单文件降级，
 * 避免因为缺少一列信息就把所有候选降级成待确认。
 */
export function parseExistenceProbe(stdout) {
  const text = String(stdout ?? '');
  const m = text.match(/PROBE_RC=(\d+)/);
  if (!m) {
    return { ok: false, reason: '存在性探针没有输出结束标记（PROBE_RC 缺失），结果不完整' };
  }
  if (Number(m[1]) !== 0) {
    return { ok: false, reason: `存在性探针以退出码 ${m[1]} 结束` };
  }

  const entries = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('P\t')) continue;
    const parts = t.split('\t');
    if (parts.length < 5) continue;
    const hasDirColumn = parts.length >= 6;
    const path = (hasDirColumn ? parts.slice(5) : parts.slice(4)).join('\t');
    if (!path) continue;
    entries.push({
      path,
      exists: parts[1] === '1',
      bytes: Number(parts[2]),
      readable: parts[3] === '1',
      isDir: hasDirColumn ? parts[4] === '1' : null,
    });
  }

  return { ok: true, entries };
}
