import { execRemote } from './ssh.js';
import {
  buildDepsLockScript,
  buildDepsLockStdin,
  parseDepsLockResult,
} from './deps-lock.js';

/**
 * 依赖快照收集的执行层。
 *
 * 与 `extra-files-runner.js` 分开：那条链路是「打包已存在的文件」，
 * 这里是「先在远端跑 pip freeze 生成锁文件，再让外层 tar 把它带走」。
 * 两者失败模式也不同——extraFiles 失败于「文件不在」，
 * depsLock 失败于「venv 不在 / pip 冻结失败 / 冻出来是空的」。
 *
 * fail-closed：任何一条 venv 不可用都抛错终止整个备份。
 * 一个「看起来收集了依赖、实际 0 个包」的备份包，比没有这个机制更危险——
 * 恢复时人会以为有依据，装到一半才发现装不上。
 */
const LOCK_TIMEOUT_MS = 600_000;

export async function packDepsLocks({
  server,
  workDir,
  locks,
  exec = execRemote,
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(locks) || locks.length === 0) {
    return { ok: true, locks: [], file: null };
  }

  let stdin;
  try {
    stdin = buildDepsLockStdin({ outDir: workDir, locks });
  } catch (e) {
    throw new Error(`依赖快照参数非法：${e.message}`);
  }

  onProgress({
    phase: 'packing-extras',
    percent: 39,
    message: `正在生成 ${locks.length} 份依赖快照（${locks.map((l) => `${l.name} @ ${l.venvPath}`).join('、')}）`,
  });

  const res = await exec(server, buildDepsLockScript(), { stdin, timeoutMs: LOCK_TIMEOUT_MS });
  const parsed = parseDepsLockResult(res.stdout);
  if (!parsed.ok) {
    throw new Error(`依赖快照收集失败：${parsed.reason}`);
  }

  return {
    ok: true,
    // 锁文件留在 workDir 里，由外层 tar 一起带走（加密主包内）。
    // MANIFEST 只记元数据：name / 文件 / 字节 / sha256 / python / 包数。
    locks: parsed.entries.map((e) => ({
      name: e.name,
      file: e.file,
      bytes: e.bytes,
      sha256: e.sha256,
      pythonVersion: e.pythonVersion,
      packages: e.packages,
    })),
    file: null,
  };
}
