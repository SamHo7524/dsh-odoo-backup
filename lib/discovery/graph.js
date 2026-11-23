/**
 * 依赖图层（纯函数，无 IO）。
 *
 * 用户 2026-11-23 追加要求：发现结果不能只是「一堆目录」，必须能回答
 * 「这个模块依赖的服务和数据能不能一起恢复」。所以每条边固定六类资产：
 *
 *   config    服务配置（systemd unit / EnvironmentFile / conf.d / odoo.conf）
 *   data      持久化数据（state.db / query_log.db / 业务库）
 *   files     文件目录（WorkingDirectory / Mounts.Source）
 *   db        数据库（pg 容器内的库，是否在主包 pg_dump 内）
 *   api       API/连接（**只记键名与形状，绝不记值**）
 *   recovery  恢复方式（**必填**，没有就写「未知，需人工确认」）
 *
 * 缺哪类必须显式出现在 missing 里，报告据此写「未发现」——省略会让人误以为不存在。
 */

export const ASSET_CLASSES = ['config', 'data', 'files', 'db', 'api', 'recovery'];

/** 六类全在的空资产集。 */
export function emptyAssetSet() {
  const out = {};
  for (const k of ASSET_CLASSES) out[k] = [];
  return out;
}

/** 判定一条字符串看起来是不是密钥值（用于抹除）。 */
function looksSecret(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 12) return false;
  return /^(sk-|ghp_|gho_|xox[bap]-|[A-Za-z0-9+/=_-]{24,})$/.test(s);
}

/** 抹除任何可能的值，只留键名与形状。 */
function sanitizeApiEntry(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry ?? {})) {
    if (k === 'value' || k === 'secret' || k === 'token' || k === 'password') {
      out.shape = '***';
      continue;
    }
    if (k === 'shape') {
      out.shape = '***';
      continue;
    }
    if (typeof v === 'string' && looksSecret(v)) {
      out.shape = '***';
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * 从一条资产的 recovery 声明里提炼「恢复方式」。
 * 没有声明时不能留空——留空等于把未知风险藏起来。
 */
function recoveryFrom(asset, serviceName, className) {
  if (asset?.recovery) {
    return { target: asset.path ?? asset.name ?? className, action: asset.recovery, source: 'explicit' };
  }
  return {
    target: asset?.path ?? asset?.name ?? className,
    action: `未知（需人工确认）：${serviceName} 的 ${className} 类资产未声明恢复方式`,
    source: 'missing',
  };
}

/**
 * 组装依赖图。
 *
 * input.services: [{ service, modules?, link?, assets? }]
 *   link: 'explicit' | 'inferred' | 'unknown'（缺省 inferred —— 绝不默认 explicit，
 *         否则「按命名猜出来的关联」会被读成事实）
 */
export function buildDependencyGraph({ services } = {}) {
  const src = Array.isArray(services) ? services : [];
  const out = { services: [], byModule: {} };

  for (const raw of src) {
    const name = String(raw?.service ?? '').trim();
    if (!name) continue;

    const modules = Array.isArray(raw?.modules)
      ? raw.modules.map((m) => String(m).trim()).filter(Boolean)
      : [];
    const link = raw?.link ?? (modules.length ? 'inferred' : 'unknown');

    const assets = emptyAssetSet();
    const given = raw?.assets ?? {};
    for (const cls of ASSET_CLASSES) {
      const list = Array.isArray(given[cls]) ? given[cls] : [];
      for (const a of list) {
        const entry = cls === 'api' ? sanitizeApiEntry(a) : { ...a };
        // recovery 类本身不递归生成 recovery
        if (cls !== 'recovery' && !entry.recovery) {
          entry.recoveryMissing = true;
        }
        assets[cls].push(entry);
      }
    }

    // recovery 必填：把每个非 recovery 类里缺恢复方式的资产，汇总成 recovery 条目；
    // 显式声明了 recovery 的，也要**汇总进 recovery 类**——报告读的是 recovery 类，
    // 只留在 data 条目的字段里等于没写（DG-R2 就是这么暴露出来的）。
    //
    // 「缺恢复方式」按类去重，不逐条资产重复：attendance 有 5 个 config 资产都没声明，
    // 逐条汇总会在报告里生成 5 行同一句话，读者反而看不清到底哪个类缺（DSV-C14）。
    const missingByClass = new Set();
    for (const cls of ASSET_CLASSES) {
      if (cls === 'recovery') continue;
      for (const a of assets[cls]) {
        if (a.recoveryMissing) {
          if (!missingByClass.has(cls)) {
            missingByClass.add(cls);
            assets.recovery.push(recoveryFrom(a, name, cls));
          }
          delete a.recoveryMissing;
        } else if (a.recovery) {
          assets.recovery.push({
            target: a.path ?? a.name ?? cls,
            action: a.recovery,
            source: 'explicit',
          });
        }
      }
    }

    // recovery 必填：即使六类全空也要留一条——否则「什么都没发现」会被读成「没问题」。
    // DSV-C8 就是这么暴露出来的：一个没有任何挂载/env 的容器，服务确实存在，
    // 但 recovery 类为空，报告里那一行就成了「recovery: 未发现」，读者会以为已确认过。
    if (!assets.recovery.length) {
      assets.recovery.push({
        target: name,
        action: `未知（需人工确认）：${name} 未发现任何可识别资产，无法判断它是否需要纳入灾备`,
        source: 'missing',
      });
    }

    const missing = ASSET_CLASSES.filter((c) => assets[c].length === 0);

    out.services.push({
      service: name,
      // origin/standalone 要一路带到报告里：用户要求「独立运行的业务系统」必须能一眼区分出来，
      // 不能和 Odoo 模块依赖的服务混在一张平表里（m05214 第⑤条）。
      origin: raw?.origin ?? 'unknown',
      standalone: raw?.standalone === true,
      image: raw?.image ?? '',
      modules,
      link,
      assets,
      missing,
    });

    for (const m of modules) {
      out.byModule[m] = [...(out.byModule[m] ?? []), name];
    }
  }

  for (const k of Object.keys(out.byModule)) {
    out.byModule[k] = [...new Set(out.byModule[k])].sort();
  }

  return out;
}
