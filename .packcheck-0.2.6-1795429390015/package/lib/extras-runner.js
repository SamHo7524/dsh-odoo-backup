import { execRemote } from './ssh.js';
import {
  buildExtraProbeScript,
  parseExtraProbe,
  buildExtraPackScript,
  buildExtraPackStdin,
  parseExtraPackResult,
  planExtrasSpace,
} from './extra-paths.js';

/**
 * 额外路径备份的执行层：预检 → 空间预算 → 逐条远端打包。
 *
 * 为什么单独成模块：runBackup 的主体（dump/下载/加密）无法在单测里跑（要真 SCP），
 * 把「额外路径」这一段抽成独立函数并注入 exec，就能在无网络下把协议与失败路径全测到。
 *
 * fail-closed 原则：路径不存在 / 不可读 / 空间不足 / 产物校验不过，一律抛错终止整个备份。
 * 宁可这次没有包，也不能产出一个「少了知识库但 manifest 声称有」的包。
 */
const PROBE_TIMEOUT_MS = 600_000;
const PACK_TIMEOUT_MS = 3_600_000;

export async function packExtras({
  server,
  workDir,
  ts,
  compressor,
  extras,
  dumpBytes = 0,
  exec = execRemote,
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(extras) || extras.length === 0) {
    return { ok: true, extras: [], bytes: 0 };
  }

  // 1) 预检：一次 ssh 拿到所有路径的存在性与体积 + 远端可用空间
  onProgress({
    phase: 'packing-extras',
    percent: 28,
    message: `正在预检 ${extras.length} 条额外路径`,
  });
  const probeRes = await exec(server, buildExtraProbeScript(), {
    stdin: [String(extras.length), ...extras.map((e) => e.path)].join('\n') + '\n',
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const probe = parseExtraProbe(probeRes.stdout);
  if (!probe.ok) {
    throw new Error(`额外路径预检失败：${probe.reason}`);
  }

  const missing = [];
  extras.forEach((extra, i) => {
    const entry = probe.entries[i];
    if (!entry || !entry.exists) missing.push(`${extra.name}（${extra.path}）`);
  });
  if (missing.length > 0) {
    throw new Error(
      `以下额外路径在远端不存在，拒绝继续备份：${missing.join('、')}。` +
        '请修正服务器上的 extraPaths 配置，或先在远端确认路径拼写。',
    );
  }

  // 2) 空间预算：额外路径 ×1.5 + dump ×2 + 余量（dump 在容器内生成后再拷出，会短暂双份）
  const extraBytes = probe.entries.reduce((sum, e) => sum + (e.bytes > 0 ? e.bytes : 0), 0);
  const plan = planExtrasSpace({ dumpBytes, extraBytes, availableBytes: probe.availableBytes });
  if (!plan.ok) {
    throw new Error(`额外路径空间预检未通过：${plan.message}`);
  }
  onProgress({
    phase: 'packing-extras',
    percent: 30,
    message: `远端空间充足（${plan.message}）`,
  });

  // 3) 逐条打包：串行，避免同时吃满 IO 与磁盘
  const ext = compressor === 'gzip' ? 'gz' : 'zst';
  const records = [];
  let totalBytes = 0;

  for (let i = 0; i < extras.length; i++) {
    const extra = extras[i];
    const percent = Math.min(44, 31 + Math.floor((13 * i) / extras.length));
    onProgress({
      phase: 'packing-extras',
      percent,
      message: `正在打包额外路径 ${extra.name}（${extra.path}）`,
    });

    const outFile = `${workDir}/${extra.name}-${ts}.tar.${ext}`;
    let stdin;
    try {
      stdin = buildExtraPackStdin({
        path: extra.path,
        outFile,
        compressor,
        exclude: extra.exclude ?? [],
      });
    } catch (e) {
      throw new Error(`额外路径「${extra.name}」参数非法：${e.message}`);
    }

    const packRes = await exec(server, buildExtraPackScript(), { stdin, timeoutMs: PACK_TIMEOUT_MS });
    const parsed = parseExtraPackResult(packRes.stdout);
    if (!parsed.ok) {
      throw new Error(`额外路径「${extra.name}」打包失败：${parsed.reason}`);
    }
    if (extra.maxBytes && parsed.bytes > extra.maxBytes) {
      throw new Error(
        `额外路径「${extra.name}」产物 ${parsed.bytes} 字节，超过配置上限 ${extra.maxBytes} 字节；` +
          '请加密排项（如 cache）或调大 maxBytes。',
      );
    }

    totalBytes += parsed.bytes;
    records.push({
      name: extra.name,
      path: extra.path,
      file: `${extra.name}-${ts}.tar.${ext}`,
      bytes: parsed.bytes,
      sha256: parsed.sha256,
      exclude: extra.exclude ?? [],
      warning: parsed.warning ?? '',
    });
  }

  return { ok: true, extras: records, bytes: totalBytes };
}