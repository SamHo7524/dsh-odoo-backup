import { execRemote } from './ssh.js';
import {
  buildExtraFilesPackScript,
  buildExtraFilesPackStdin,
  parseExtraFilesPackResult,
} from './extra-files.js';

/**
 * 加密单文件收集的执行层。
 *
 * 与 `extras-runner.js` 分开：那条链路打的是目录、走空间预算、支持 exclude；
 * 这里打的是**几个明确的文件**，没有 exclude 概念，也不该按 ×1.5 估空间
 * （单文件通常是几 KB，重头在 dump）。
 *
 * fail-closed：任何一个文件缺失 / 不是普通文件 / 不可读 → 抛错终止整个备份。
 * 「少了一个 .env 的备份包」比没有包更危险——它看起来是成功的。
 */
const PACK_TIMEOUT_MS = 600_000;

export async function packExtraFiles({
  server,
  workDir,
  ts,
  files,
  exec = execRemote,
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true, files: [], bytes: 0, file: null };
  }

  const outFile = `${workDir}/extra-files-${ts}.tar.gz`;
  let stdin;
  try {
    stdin = buildExtraFilesPackStdin({ files, outFile });
  } catch (e) {
    throw new Error(`单文件收集参数非法：${e.message}`);
  }

  onProgress({
    phase: 'packing-extras',
    percent: 38,
    message: `正在收集 ${files.length} 个加密单文件（${files.map((f) => (typeof f === 'string' ? f : f?.path)).join('、')}）`,
  });

  const res = await exec(server, buildExtraFilesPackScript(), { stdin, timeoutMs: PACK_TIMEOUT_MS });
  const parsed = parseExtraFilesPackResult(res.stdout);
  if (!parsed.ok) {
    throw new Error(`单文件收集失败：${parsed.reason}`);
  }

  return {
    ok: true,
    file: `extra-files-${ts}.tar.gz`,
    bytes: parsed.bytes,
    sha256: parsed.sha256,
    // 逐文件元数据进 MANIFEST：路径 / 字节 / 权限 / uid / gid / sha256。
    // 绝不记内容——这是用户 2026-11-24 裁决第 5 条。
    files: parsed.entries.map((e) => ({
      path: e.path,
      bytes: e.bytes,
      mode: e.mode,
      uid: e.uid,
      gid: e.gid,
      sha256: e.sha256,
    })),
  };
}
