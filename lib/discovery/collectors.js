/**
 * 外部依赖发现 —— 采集层（远端脚本构造 + 输出解析）。
 *
 * 这里的脚本都遵守三条从真机事故里学来的纪律：
 *  1. **不用 `set -e`**：要自己判每一段的退出码，`set -e` 会让第一段失败就整体退出，
 *     后面能采到的证据也一起丢掉。
 *  2. **禁用 `| head`**：`set -o pipefail` 下 head 提前关闭管道会让上游收到 SIGPIPE，
 *     整个脚本在清理语句之前就退出（2026-11-20 实测）。
 *  3. **只读**：不 sed -i、不 tee、不重定向写入生产路径。AC-6「扫描零写入」靠这条。
 *
 * 解析层也遵守一条：**env 只留键名，api 只留 URL 形状**，任何值都不进结果（AC-7）。
 */

/** 把 ===SECTION=== 切成 map，行数组。`===NAME=value===` 也识别，值丢弃。 */
function splitSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^===([A-Z_]+)(?:=[^=]*)?===$/);
    if (m) {
      cur = m[1];
      if (!out[cur]) out[cur] = [];
      continue;
    }
    if (cur) out[cur].push(line);
  }
  return out;
}

/** 读 `===XXX_RC=n===`；缺失返回 null（缺失不能被当成成功）。 */
function readRc(text, name) {
  const m = String(text ?? '').match(new RegExp(`===${name}=(\\d+)===`));
  return m ? Number(m[1]) : null;
}

// ================= L3-runtime =================

/**
 * 宿主运行时扫描：容器、挂载、env 键名、工作目录、监听端口、进程。
 *
 * 挂载（`.Mounts` 的 Source）是**最硬的路径证据**：它直接说明数据落在宿主机哪个目录，
 * 不依赖任何命名约定或代码文本。
 */
export function buildRuntimeScanScript() {
  return `set -uo pipefail

echo "===DOCKER==="
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null || true
fi

echo "===MOUNTS==="
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}' 2>/dev/null | while IFS= read -r c; do
    [ -z "\${c:-}" ] && continue
    docker inspect "$c" --format '{{range .Mounts}}{{.Source}}=>{{.Destination}}{{println}}{{end}}' 2>/dev/null \\
      | while IFS= read -r m; do
          [ -z "\${m:-}" ] && continue
          printf '%s\\t%s\\n' "$c" "$m"
        done
  done
fi

echo "===ENVKEYS==="
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}' 2>/dev/null | while IFS= read -r c; do
    [ -z "\${c:-}" ] && continue
    docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \\
      | while IFS= read -r kv; do
          [ -z "\${kv:-}" ] && continue
          printf '%s\\t%s\\n' "$c" "\${kv%%=*}"
        done
  done
fi

echo "===WORKDIR==="
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}' 2>/dev/null | while IFS= read -r c; do
    [ -z "\${c:-}" ] && continue
    wd=$(docker inspect "$c" --format '{{.Config.WorkingDir}}' 2>/dev/null)
    [ -z "\${wd:-}" ] && continue
    printf '%s\\t%s\\n' "$c" "$wd"
  done
fi

echo "===PORTS==="
if command -v ss >/dev/null 2>&1; then
  ss -lntpH 2>/dev/null | while IFS= read -r line; do
    addr=$(printf '%s' "$line" | awk '{print $4}')
    who=$(printf '%s' "$line" | sed -n 's/.*users:(("\\([^"]*\\)".*/\\1/p')
    [ -z "\${addr:-}" ] && continue
    printf '%s\\t%s\\n' "$addr" "\${who:-unknown}"
  done
fi

echo "===PROCS==="
ps -eo user,pid,args --no-headers 2>/dev/null || true

echo "===RUNTIME_RC=0==="
`;
}

/** 解析运行时扫描输出。无容器不代表失败（可能没装 docker），但缺 RC 一定是失败。 */
export function parseRuntimeScan(stdout) {
  const text = String(stdout ?? '');
  const rc = readRc(text, 'RUNTIME_RC');
  if (rc === null) {
    return { ok: false, reason: '运行时扫描没有输出结束标记（RUNTIME_RC 缺失），结果不完整' };
  }
  if (rc !== 0) {
    return { ok: false, reason: `运行时扫描以退出码 ${rc} 结束，结果不可信` };
  }

  const sec = splitSections(text);

  const containers = [];
  const byName = new Map();
  for (const line of sec.DOCKER ?? []) {
    const t = line.trim();
    if (!t.includes('|')) continue;
    const [name, image, status] = t.split('|');
    const c = {
      name: (name ?? '').trim().replace(/^\//, ''),
      image: (image ?? '').trim(),
      status: (status ?? '').trim(),
      mounts: [],
      envKeys: [],
      workDir: '',
    };
    if (!c.name) continue;
    containers.push(c);
    byName.set(c.name, c);
  }

  for (const line of sec.MOUNTS ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [name, pair] = t.split('\t');
    const c = byName.get((name ?? '').trim().replace(/^\//, ''));
    if (!c) continue;
    const [source, destination] = String(pair ?? '').split('=>');
    if (!source || !destination) continue;
    c.mounts.push({ source: source.trim(), destination: destination.trim() });
  }

  for (const line of sec.ENVKEYS ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [name, key] = t.split('\t');
    const c = byName.get((name ?? '').trim().replace(/^\//, ''));
    const k = (key ?? '').trim();
    if (!c || !k) continue;
    if (!c.envKeys.includes(k)) c.envKeys.push(k);
  }

  for (const line of sec.WORKDIR ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [name, wd] = t.split('\t');
    const c = byName.get((name ?? '').trim().replace(/^\//, ''));
    if (c && wd) c.workDir = wd.trim();
  }

  const ports = [];
  for (const line of sec.PORTS ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [addr, who] = t.split('\t');
    const a = (addr ?? '').trim();
    const idx = a.lastIndexOf(':');
    const port = idx >= 0 ? Number(a.slice(idx + 1)) : NaN;
    if (!Number.isInteger(port)) continue;
    ports.push({ addr: a, port, who: (who ?? '').trim() || 'unknown' });
  }

  const processes = [];
  for (const line of sec.PROCS ?? []) {
    const t = line.trim();
    if (!t) continue;
    // 兼容 ps 的空格对齐输出与脚本里的 tab 分隔
    const m = t.match(/^(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    processes.push({ user: m[1], pid: Number(m[2]), cmd: m[3].trim() });
  }

  return {
    ok: true,
    dockerAvailable: containers.length > 0,
    containers,
    ports,
    processes,
  };
}

// ================= L4-systemd =================

/**
 * systemd 扫描。
 *
 * `WorkingDirectory` + `EnvironmentFile` 是**最有价值的一对**：前者是服务的数据根，
 * 后者是配置根。有了这两个，通常不必再读代码就能定位灾备范围。
 */
export function buildSystemdScanScript() {
  return `set -uo pipefail

UNITS=""
echo "===UNITS==="
if command -v systemctl >/dev/null 2>&1; then
  UNITS=$(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}')
  if [ -n "\${UNITS:-}" ]; then
    printf '%s\\n' "$UNITS"
  fi
fi

echo "===CAT==="
for u in \${UNITS:-}; do
  echo "###UNIT:$u"
  systemctl cat "$u" 2>/dev/null | grep -E '^(WorkingDirectory|EnvironmentFile|ExecStart)=' || true
done

echo "===ENABLED==="
for u in \${UNITS:-}; do
  st=$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)
  printf '%s\\t%s\\n' "$u" "\${st:-unknown}"
done

echo "===SYSTEMD_RC=0==="
`;
}

/** 解析 systemd 输出。 */
export function parseSystemdScan(stdout) {
  const text = String(stdout ?? '');
  const rc = readRc(text, 'SYSTEMD_RC');
  if (rc === null) {
    return { ok: false, reason: 'systemd 扫描没有输出结束标记（SYSTEMD_RC 缺失），结果不完整' };
  }
  if (rc !== 0) {
    return { ok: false, reason: `systemd 扫描以退出码 ${rc} 结束` };
  }

  const sec = splitSections(text);
  const units = [];

  for (const line of sec.UNITS ?? []) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const name = parts[0];
    if (!name || !name.endsWith('.service')) continue;
    units.push({
      name,
      load: parts[1] ?? '',
      active: parts[2] ?? '',
      sub: parts[3] ?? '',
      description: parts.slice(4).join(' '),
      workingDirectory: '',
      environmentFile: '',
      execStart: '',
      enabled: 'unknown',
    });
  }

  const byName = new Map(units.map((u) => [u.name, u]));

  let current = null;
  for (const line of sec.CAT ?? []) {
    const t = line.trim();
    const m = t.match(/^###UNIT:(.+)$/);
    if (m) {
      current = byName.get(m[1].trim()) ?? null;
      continue;
    }
    if (!current) continue;
    const kv = t.match(/^(WorkingDirectory|EnvironmentFile|ExecStart)=(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    if (kv[1] === 'WorkingDirectory') current.workingDirectory = val;
    if (kv[1] === 'EnvironmentFile') current.environmentFile = val.replace(/^-/, '');
    if (kv[1] === 'ExecStart') current.execStart = val;
  }

  for (const line of sec.ENABLED ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [name, st] = t.split('\t');
    const u = byName.get((name ?? '').trim());
    if (u) u.enabled = (st ?? '').trim() || 'unknown';
  }

  return { ok: true, units };
}

// ================= L1-odoo =================

/** Odoo 官方模块（用名称前缀粗筛，漏判只会导致多列几行，不会漏报自定义模块）。 */
const OFFICIAL_PREFIXES = [
  'base',
  'web',
  'website',
  'mail',
  'account',
  'sale',
  'purchase',
  'stock',
  'mrp',
  'hr',
  'product',
  'crm',
  'project',
  'point_of_sale',
  'payment',
  'portal',
  'auth',
  'bus',
  'calendar',
  'contacts',
  'digest',
  'event',
  'fleet',
  'forum',
  'gamification',
  'google',
  'im_livechat',
  'link_tracker',
  'lunch',
  'mass_mailing',
  'membership',
  'microsoft',
  'note',
  'partner',
  'phone_validation',
  'privacy',
  'rating',
  'resource',
  'rpc',
  'sales_team',
  'sms',
  'snailmail',
  'social',
  'spreadsheet',
  'survey',
  'test',
  'theme',
  'transifex',
  'uom',
  'utm',
  'web_editor',
  'web_tour',
  'web_unsplash',
  'web_hierarchy',
];

function isOfficialModule(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n) return false;
  return OFFICIAL_PREFIXES.some((p) => n === p || n.startsWith(`${p}_`));
}

/**
 * Odoo 模块与系统参数扫描。
 *
 * stdin 三行：PG 容器名 / PG 超级用户 / 数据库名。走 `read` 是本项目 execRemote 的契约
 * （脚本 base64 进 argv，stdin 空闲供脚本读参数）。
 */
export function buildOdooModuleScript() {
  return `set -uo pipefail

read -r PGC || true
read -r PGU || true
read -r DBN || true

echo "===MODULES==="
if [ -n "\${PGC:-}" ] && [ -n "\${DBN:-}" ] && command -v docker >/dev/null 2>&1; then
  docker exec "$PGC" psql -U "\${PGU:-postgres}" -d "$DBN" -t -A -F'|' \\
    -c "SELECT name, latest_version, state FROM ir_module_module WHERE state='installed' ORDER BY name" 2>/dev/null || true
fi

echo "===CONFPARAMS==="
if [ -n "\${PGC:-}" ] && [ -n "\${DBN:-}" ] && command -v docker >/dev/null 2>&1; then
  docker exec "$PGC" psql -U "\${PGU:-postgres}" -d "$DBN" -t -A -F'|' \\
    -c "SELECT key, value FROM ir_config_parameter WHERE key LIKE '%path%' OR key LIKE '%dir%' OR key LIKE '%host%' OR key LIKE '%url%' ORDER BY key" 2>/dev/null || true
fi

echo "===ODOO_RC=0==="
`;
}

/** url 只留 scheme://host，丢掉路径与查询串（避免把 token 形状带出去）。 */
function urlShape(value) {
  const v = String(value ?? '').trim();
  const m = v.match(/^(https?:\/\/[^/?#\s]+)/i);
  if (m) return m[1];
  // 非 URL 的值：只回形状描述，不回原值
  if (!v) return '';
  if (v.startsWith('/')) return '本地绝对路径';
  return `${v.length} 字符`;
}

/** 解析 Odoo 模块扫描输出。 */
export function parseOdooModules(stdout) {
  const text = String(stdout ?? '');
  const rc = readRc(text, 'ODOO_RC');
  if (rc === null) {
    return { ok: false, reason: 'Odoo 模块扫描没有输出结束标记（ODOO_RC 缺失），结果不完整' };
  }
  if (rc !== 0) {
    return { ok: false, reason: `Odoo 模块扫描以退出码 ${rc} 结束` };
  }

  const sec = splitSections(text);
  const modules = [];
  for (const line of sec.MODULES ?? []) {
    const t = line.trim();
    if (!t.includes('|')) continue;
    const [name, version, state] = t.split('|');
    const n = (name ?? '').trim();
    if (!n) continue;
    modules.push({
      name: n,
      version: (version ?? '').trim(),
      state: (state ?? '').trim(),
      official: isOfficialModule(n),
    });
  }

  const configParams = [];
  for (const line of sec.CONFPARAMS ?? []) {
    const t = line.trim();
    if (!t.includes('|')) continue;
    const [key, value] = t.split('|');
    const k = (key ?? '').trim();
    if (!k) continue;
    configParams.push({ key: k, valueShape: urlShape(value) });
  }

  return { ok: true, modules, configParams };
}

// ================= L2-config =================

/**
 * 静态配置扫描（**低置信度**）。
 *
 * 这一层只产出线索，绝不允许单独产出 `suggest` —— 2026-11-23 的教训：正则扫
 * `server.py` 把 `_call_hermes_legacy`（仅 key 为空时的降级路径）误判成主链路，
 * 导致文档写错并返工。AC-10 就是为这条立的。
 */
export function buildConfigScanScript() {
  return `set -uo pipefail

echo "===ENVKEYS==="
for f in /root/.hermes/profiles/*/.env /opt/web_cs/.env; do
  [ -f "$f" ] || continue
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$f" 2>/dev/null | cut -d= -f1 | while IFS= read -r k; do
    [ -z "\${k:-}" ] && continue
    printf '%s\\t%s\\n' "$f" "$k"
  done
done

echo "===PATHLIT==="
if [ -d /opt/web_cs ]; then
  grep -rInE '/(opt|root|etc|srv)/[A-Za-z0-9_./-]{4,}' /opt/web_cs \\
    --include='*.py' --include='*.sh' --include='*.json' \\
    --exclude-dir=venv --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=backups 2>/dev/null \\
    | while IFS= read -r line; do
        f=\${line%%:*}
        rest=\${line#*:}
        ln=\${rest%%:*}
        txt=\${rest#*:}
        val=$(printf '%s' "$txt" | sed -n 's/.*\\(\\/(opt\\|root\\|etc\\|srv\\)\\/[A-Za-z0-9_./-]*\\).*/\\1/p')
        [ -z "\${val:-}" ] && continue
        printf '%s\\t%s\\n' "$f" "$val"
      done
fi

echo "===URL==="
if [ -d /opt/web_cs ]; then
  grep -rIoE 'https?://[A-Za-z0-9_.:/-]{4,}' /opt/web_cs \\
    --include='*.py' --include='*.json' \\
    --exclude-dir=venv --exclude-dir=.git --exclude-dir=__pycache__ 2>/dev/null \\
    | while IFS= read -r line; do
        f=\${line%%:*}
        u=\${line#*:}
        [ -z "\${u:-}" ] && continue
        printf '%s\\t%s\\n' "$f" "$u"
      done
fi

echo "===CONFIG_RC=0==="
`;
}

/** 解析静态配置扫描输出。恒为 low 置信度。 */
export function parseConfigScan(stdout) {
  const text = String(stdout ?? '');
  const rc = readRc(text, 'CONFIG_RC');
  if (rc === null) {
    return { ok: false, confidence: 'low', reason: '配置扫描没有输出结束标记（CONFIG_RC 缺失）' };
  }

  const sec = splitSections(text);
  const envKeys = [];
  const pathLiterals = [];
  const urls = [];

  for (const line of sec.ENVKEYS ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [file, key] = t.split('\t');
    if (!key) continue;
    envKeys.push({ file: (file ?? '').trim(), key: key.trim() });
  }

  for (const line of sec.PATHLIT ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [file, value] = t.split('\t');
    if (!value) continue;
    pathLiterals.push({ file: (file ?? '').trim(), value: value.trim() });
  }

  for (const line of sec.URL ?? []) {
    const t = line.trim();
    if (!t.includes('\t')) continue;
    const [file, value] = t.split('\t');
    if (!value) continue;
    urls.push({ file: (file ?? '').trim(), value: value.trim() });
  }

  return { ok: true, confidence: 'low', envKeys, pathLiterals, urls };
}
