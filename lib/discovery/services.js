import { normalizePath, isUnder } from './paths.js';
import { ASSET_CLASSES, emptyAssetSet } from './graph.js';

/**
 * 服务装配层（纯函数，无 IO）。
 *
 * 用户 2026-11-23 追加要求：Discovery 不能只是目录扫描器，要能回答
 * 「这个模块依赖的服务和数据能不能一起恢复」。所以这里做的是**关联**：
 *
 *   Odoo 模块 ──(端口/名称/路径)──> 外部服务 ──> 六类资产
 *
 * 关联强度只有 `explicit` 才算事实。规则刻意保守：
 *  - 只有「socket 端口数字对上」或「模块名直接出现在服务标识里」才允许 inferred
 *  - 同目录、同前缀这种巧合一律不认
 *  - 认不出来就 link=unknown，模块留空，**绝不为了报告好看而编一条边**
 */

/** systemd unit 名去掉 .service 后缀，变成服务短名。 */
export function serviceShortName(unitName) {
  const n = String(unitName ?? '').trim();
  if (!n) return '';
  return n.endsWith('.service') ? n.slice(0, -'.service'.length) : n;
}

/** 从 ExecStart 或监听地址里抽端口号。 */
export function portOf(entry) {
  if (entry && typeof entry === 'object' && Number.isInteger(entry.port)) return entry.port;
  const s = String(entry ?? '');
  const m = s.match(/:(\d{2,5})\b/);
  return m ? Number(m[1]) : null;
}

/** 从 URL 里抽端口；无端口时按 scheme 给默认值。 */
export function portOfUrl(url) {
  const s = String(url ?? '').trim();
  const m = s.match(/^https?:\/\/[^/?#]*?:(\d{2,5})\b/i);
  if (m) return Number(m[1]);
  if (/^https:\/\//i.test(s)) return 443;
  if (/^http:\/\//i.test(s)) return 80;
  return null;
}

/**
 * 装配 services 数组，供 `buildDependencyGraph()` 消费。
 *
 * @param {object} o
 * @param {object} o.instance       discover.js 的实例（含 dbName / pgContainer / pgDatabases）
 * @param {Array}  o.units          parseSystemdScan().units
 * @param {Array}  o.ports          parseRuntimeScan().ports
 * @param {Array}  o.containers     parseRuntimeScan().containers
 * @param {Array}  o.modules        parseOdooModules().modules（只取自定义模块）
 * @param {object} o.config         parseConfigScan() 结果
 * @param {Array}  o.extraPaths     运行中配置的额外路径
 * @param {object} [o.recipes]      恢复配方表（见 DEFAULT_RECIPES）
 */
export function buildServices({ instance, units = [], ports = [], containers = [], modules = [], config, extraPaths = [], recipes = DEFAULT_RECIPES } = {}) {
  const out = [];
  const customModules = (Array.isArray(modules) ? modules : []).filter((m) => m && !m.official);
  const customNames = customModules.map((m) => m.name);

  const envKeysByFile = new Map();
  for (const it of config?.envKeys ?? []) {
    const f = normalizePath(it?.file);
    if (!f) continue;
    envKeysByFile.set(f, [...(envKeysByFile.get(f) ?? []), it.key]);
  }
  const urlsByFile = new Map();
  for (const it of config?.urls ?? []) {
    const f = normalizePath(it?.file);
    if (!f) continue;
    urlsByFile.set(f, [...(urlsByFile.get(f) ?? []), it.value]);
  }

  for (const u of units) {
    const short = serviceShortName(u?.name);
    if (!short) continue;

    const wd = normalizePath(u?.workingDirectory);
    const envFile = normalizePath(u?.environmentFile);
    const unitFile = `/etc/systemd/system/${u.name}`;

    // 关联模块：① 模块名出现在服务标识里（explicit）② 端口对上（inferred）
    let modulesHit = [];
    let link = 'unknown';
    const evidence = [];

    for (const name of customNames) {
      const n = name.toLowerCase();
      if (short.toLowerCase().includes(n) || n.includes(short.toLowerCase())) {
        modulesHit = [name];
        link = 'explicit';
        evidence.push(`模块名 ${name} 与 unit ${u.name} 直接对应`);
        break;
      }
    }

    if (!modulesHit.length) {
      // 端口/路径关联：模块代码里引用的 URL，其**首个路径段**与服务短名一致，
      // 或端口与该服务监听端口一致，才认为模块在调用这个服务。
      //
      // 真实依据（2026-11-23 实测）：`chatbot_ai_hermes/models/chatbot_script_step.py`
      // 里有 `HERMES_API_URL = "https://www.toogel.cn/webchat/api/chat"`，首段 `/webchat`
      // 正好对应 `webchat.service`。这条链路是可验证的；而「模块和 web_cs 都在 /opt 下」
      // 这种巧合不构成证据，所以只认 URL 首段与端口。
      const listenPorts = ports
        .filter((p) => (p?.who ?? '').toLowerCase().includes(short.toLowerCase()))
        .map((p) => portOf(p))
        .filter(Boolean);

      for (const mod of customModules) {
        const dir = normalizePath(mod?.dir);
        const refs = [];
        for (const [f, urls] of urlsByFile.entries()) {
          if (dir && !isUnder(f, dir)) continue;
          for (const raw of urls) refs.push(raw);
        }
        const hit = refs.find((u) => {
          const s = String(u);
          const seg = (s.match(/^https?:\/\/[^/?#]*\/([^/?#]+)/i) ?? [])[1] ?? '';
          if (seg && seg.toLowerCase() === short.toLowerCase()) return true;
          const p = portOfUrl(s);
          return Boolean(p && listenPorts.includes(p));
        });
        if (hit) {
          modulesHit = [mod.name];
          link = 'inferred';
          evidence.push(
            `${mod.name} 的代码引用 ${hit}，与服务 ${u.name}${listenPorts.length ? `（监听 ${listenPorts.join(',')}）` : ''} 对应`,
          );
          break;
        }
      }
    }

    // 六类资产
    const assets = emptyAssetSet();
    if (unitFile) assets.config.push({ path: unitFile, note: 'systemd unit' });
    if (envFile) assets.config.push({ path: envFile, note: 'EnvironmentFile（只记录路径，不读内容）' });
    if (wd) assets.files.push({ path: wd, note: 'WorkingDirectory' });

    for (const k of envKeysByFile.get(envFile) ?? []) {
      assets.api.push({ key: k, shape: '***' });
    }

    // 数据资产：只用「已知配方」或「工作目录内的 SQLite 型文件名」，不瞎猜
    //
    // 配方键有三种可能写法：服务短名（webchat）、工作目录（/opt/web_cs）、
    // 目录名（web_cs）。三种都认——否则 `webchat.service` 永远匹配不到为
    // `/opt/web_cs` 写的配方，报告里就会显示「恢复方式未知」（DSV-S7 暴露的）。
    const recipe = findRecipe(recipes, [short, wd, wd ? wd.slice(wd.lastIndexOf('/') + 1) : '']);
    if (recipe) {
      for (const d of recipe.data ?? []) {
        assets.data.push({ path: d.path, note: d.note, recovery: d.recovery });
      }
      for (const c of recipe.config ?? []) {
        assets.config.push({ path: c.path, note: c.note });
      }
      for (const r of recipe.recovery ?? []) {
        assets.recovery.push({ target: r.target, action: r.action, source: 'explicit' });
      }
    }

    // 数据库类：Odoo 自己的库归到 odoo 服务，不重复记到每个 web 服务上
    if (instance?.dbName && short.toLowerCase().includes('odoo')) {
      assets.db.push({ name: instance.dbName, note: '主包 pg_dump 已含' });
    }

    out.push({
      service: short,
      modules: modulesHit,
      link,
      evidence,
      assets,
    });
  }

  // Odoo 自身作为一个服务：把主备份四件套显式列进资产，报告据此证明「已覆盖」
  if (instance) {
    const assets = emptyAssetSet();
    if (instance.confPath) assets.config.push({ path: instance.confPath, note: 'odoo.conf（脱敏后入包）' });
    if (instance.addonsPath) assets.files.push({ path: instance.addonsPath, note: 'addons bind mount' });
    if (instance.dataPath) assets.files.push({ path: instance.dataPath, note: 'data_dir bind mount' });
    if (instance.pydepsPath) assets.data.push({ path: instance.pydepsPath, note: 'python 依赖目录' });
    if (instance.dbName) assets.db.push({ name: instance.dbName, note: '主包 pg_dump' });
    assets.recovery.push({
      target: instance.dbName ?? 'odoo',
      action: '用 odoo_restore 还原主包：安全备份 → 临时恢复 → 验证 → 停机切换 → 验证（失败自动回滚）',
      source: 'explicit',
    });
    out.unshift({
      service: `${instance.odooContainer || 'odoo'} (Odoo)`,
      modules: customNames,
      link: customNames.length ? 'explicit' : 'unknown',
      evidence: ['Odoo 实例本身'],
      assets,
    });
  }

  void containers;
  void ASSET_CLASSES;
  void isUnder;
  return out;
}

/** 按多个键依次查配方（服务短名 → 工作目录 → 目录名）。 */
function findRecipe(recipes, keys) {
  for (const k of keys) {
    const key = normalizePath(k) || String(k ?? '').trim();
    if (!key) continue;
    if (recipes?.[key]) return recipes[key];
  }
  return null;
}

/**
 * 恢复配方表：**人工写下的**「这些服务的数据在哪、怎么恢复」。
 *
 * 为什么必须人工写：机器无法从代码里可靠推断「恢复要做什么」。留空比编造好——
 * `buildDependencyGraph` 会把没有 recovery 的资产标成「未知，需人工确认」。
 */
export const DEFAULT_RECIPES = {
  web_cs: {
    config: [
      { path: '/opt/web_cs/kb_config.json', note: 'file_index 172 条 + image_map 77 条（每日 5:00 由 kb_sync_and_verify.py 重建）' },
      // 宿主机路径。容器内它叫 /www/conf.d/...（OpenResty 容器把 /opt/1panel/www 挂在 /www）。
      // 写宿主机路径，因为 extraPaths 打包的是宿主机文件系统。
      { path: '/opt/1panel/www/conf.d/www.toogel.cn.conf', note: 'OpenResty 反代 /webchat/ → 127.0.0.1:8766（第 133-142 行）' },
    ],
    data: [
      { path: '/opt/web_cs/query_log.db', note: '查询日志 SQLite', recovery: '可直接恢复，历史日志非必需' },
      { path: '/opt/web_cs/embeddings/v1', note: 'FAISS 索引（496 chunks / 768 维）', recovery: '新机需用 build_embeddings.py 重建，且必须联网下载 781 MiB 模型' },
    ],
    recovery: [
      { target: '/opt/web_cs', action: '恢复 web-cs 额外路径 → 重建 venv（未备份）→ 重建 FAISS 索引 → 重启 webchat' },
      { target: 'DEEPSEEK_API_KEY', action: '恢复后轮换 Key（旧 key 不进包，包内只有 deepseek.env）' },
    ],
  },
};
