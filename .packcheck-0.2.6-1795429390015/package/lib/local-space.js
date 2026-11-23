/**
 * v0.2.2 — 本地磁盘空间预检（设计规格 §16）。
 *
 * 背景：额外路径把备份包从 ~600 MiB 推到 1.5+ GiB，而 `lib/backup.js` 此前
 * 完全没有本地磁盘预检，会在「下载/组装到一半磁盘满」时才失败并留下残包。
 *
 * 策略：下载前要求目标目录可用空间 ≥ totalBytes × LOCAL_SPACE_FACTOR。
 * 预检本身不可用（如平台不支持 statfs）时**跳过**——预检绝不能成为新的失败点。
 */
import { statfs as defaultStatfs } from 'node:fs/promises';

import { humanBytes } from './extra-paths.js';

/**
 * 安全系数。规格 §16 要求至少 2×：外层 tar 落盘、分片目录、组装中间态、
 * 加密临时文件都会在目标目录上叠加占用。
 */
export const LOCAL_SPACE_FACTOR = 2.2;

/**
 * 校验本机目标目录的可用空间是否足够容纳预计落盘内容。
 *
 * @param {string} dir 本机下载目标目录（通常已由 runBackup 用 mkdir 建好）。
 * @param {number} bytes 预计要落盘的字节数（外层 tar 的 outerSize）。
 * @param {{ statfs?: Function }} [deps] 注入点（测试用）；缺省走真实 `fs/promises.statfs`。
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   requiredBytes?: number,
 *   availableBytes?: number,
 *   message?: string,
 *   reason?: string,
 * }>}
 */
export async function ensureLocalSpace(dir, bytes, deps = {}) {
  const statfs = typeof deps?.statfs === 'function' ? deps.statfs : defaultStatfs;

  let stats;
  try {
    stats = await statfs(dir);
  } catch (err) {
    return {
      ok: true,
      skipped: true,
      reason: `本地空间预检不可用（${err?.code ?? err?.message ?? '未知原因'}），跳过预检`,
    };
  }

  const bsize = Number(stats?.bsize);
  const bavail = Number(stats?.bavail);
  if (!Number.isFinite(bsize) || !Number.isFinite(bavail) || bsize <= 0 || bavail <= 0) {
    return { ok: true, skipped: true, reason: '本地空间预检返回数据不可用，跳过预检' };
  }

  const availableBytes = bavail * bsize;
  const requiredBytes = Math.ceil(Number(bytes) * LOCAL_SPACE_FACTOR);

  if (availableBytes < requiredBytes) {
    return {
      ok: false,
      requiredBytes,
      availableBytes,
      message:
        `本地磁盘不足：预计需要 ${humanBytes(requiredBytes)}` +
        `（含 ${LOCAL_SPACE_FACTOR}× 安全系数），目标目录可用仅 ${humanBytes(availableBytes)}。` +
        '请清理磁盘空间或调整额外路径配置后重试。',
    };
  }

  return { ok: true, skipped: false, requiredBytes, availableBytes };
}
