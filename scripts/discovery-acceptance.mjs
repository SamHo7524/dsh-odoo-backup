#!/usr/bin/env node
/**
 * Phase 1 真机验收（AC-1 ~ AC-10）。
 *
 * 这个脚本是**只读**的：它唯一会改动服务器的地方是 AC-3 临时创建一个
 * systemd unit 与一个目录，然后立刻清理。除此之外不写任何东西——
 * AC-6 就是专门用来证明这一点的（扫描前后逐字节比对指纹）。
 *
 * 用法：
 *   node scripts/discovery-acceptance.mjs --server toogel \
 *        --key H:/odoo/key/odoo-backup --host 47.121.205.143
 *
 * 退出码：0 全过 / 1 有 FAIL / 2 前置条件不满足
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { scanExternalDeps } from '../lib/discovery/index.js';
import { COVERAGE_STATES, classifyCoverage } from '../lib/discovery/coverage.js';
import { buildCoverageContext } from '../lib/discovery/scan.js';

// ---------------- 参数 ----------------

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SERVER_NAME = arg('server', 'toogel');
const SSH_KEY = arg('key', 'H:/odoo/key/odoo-backup');
const HOST = arg('host', '47.121.205.143');
const PORT = Number(arg('port', '22'));
const USER = arg('user', 'root');
const MAX_EXTRAS = Number(arg('maxExtras', '8'));
const CONFIG_PATH = arg('config', '');

if (!SSH_KEY || !HOST) {
  console.error('必须提供 --key 与 --host');
  process.exit(2);
}

// ---------------- 服务器连接 ----------------

function ssh(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = `f=/tmp/.dsh-ac-$$.sh; echo '${b64}' | base64 -d > "$f"; bash "$f"; rc=$?; rm -f "$f"; exit $rc`;
  return execFileSync(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=15',
      '-p', String(PORT),
      '-i', SSH_KEY,
      '-o', 'IdentitiesOnly=yes',
      `${USER}@${HOST}`,
      cmd,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

// ---------------- extraPaths：从运行中配置读，不自己编 ----------------

function loadExtraPaths() {
  if (CONFIG_PATH) {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    // cordis.patch.yml 里的 servers[0].extraPaths 用简易 YAML 抽取即可，
    // 这里不引入 YAML 依赖——我们只要 path/exclude/name 三个字段。
    const lines = raw.split('\n');
    const result = [];
    let cur = null;
    let inExtra = false;
    for (const line of lines) {
      if (/^\s*extraPaths:/.test(line)) {
        inExtra = true;
        continue;
      }
      if (!inExtra) continue;
      const nameM = line.match(/^\s*-\s+name:\s*(\S+)\s*$/);
      if (nameM) {
        if (cur) result.push(cur);
        cur = { name: nameM[1], path: '', exclude: [], maxBytes: null };
        continue;
      }
      const pathM = line.match(/^\s+path:\s*(\S.*?)\s*$/);
      if (pathM && cur) {
        cur.path = pathM[1].replace(/^["']|["']$/g, '');
        continue;
      }
      const exM = line.match(/^\s+exclude:\s*\[(.*)\]\s*$/);
      if (exM && cur) {
        cur.exclude = exM[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        continue;
      }
      if (/^\s*[a-zA-Z]+:/.test(line) && !/^\s+(path|exclude|maxBytes|name):/.test(line) && !/^\s+-/.test(line)) {
        // 离开 extraPaths 段
        if (cur) result.push(cur);
        cur = null;
        inExtra = false;
      }
    }
    if (cur) result.push(cur);
    return result.filter((e) => e.path);
  }
  return [];
}

const EXTRA_PATHS = loadExtraPaths();

// ---------------- 指纹（AC-6） ----------------
//
// AC-6 要证明的是「**扫描这个动作**不写服务器」，所以指纹必须只包住扫描，
// 不能把 AC-3 的临时 unit 创建/删除也圈进来（那当然会改 /etc/systemd/system）。
//
// 两类目录必须区别对待：
//   · 静态目录（/etc/systemd/system、/opt/1panel/www）—— 没人常态写它们，
//     mtime 与条目数都该纹丝不动；
//   · 活目录（/root/.hermes、/opt/web_cs）—— hermes gateway（gateway run /
//     browser_harness / odoo_mcp / process_supervisor）与 webchat 在持续写
//     cron、gateway_state.json、kanban.db-shm、query_log.db 等。实测 12 秒窗口内
//     就有 4 个条目 mtime 在动。把这种漂移算成「扫描写入」是假阳性，所以
//     活目录**不参与** mtime 与条目数比对。
//
// 那活目录怎么证明没被我们写？用等价证据：
//   · 关键文件 md5 不变（server.py / kb_config.json / jobs.json / webchat.service）；
//   · 我们自己的临时脚本残留数为 0（/tmp/.dsh-script-*、/tmp/.dsh-ac-*）。
// 扫描若真的写了服务器，要么改内容（md5 变），要么留文件（残留 > 0）。
const VOLATILE_DIRS = ['/root/.hermes', '/opt/web_cs'];
const STABLE_DIRS = ['/etc/systemd/system', '/opt/1panel/www', '/root/Documents/Obsidian Vault'];

const FP_SCRIPT = `
echo "===DIRMTIME==="
for p in ${STABLE_DIRS.map((d) => `"${d}"`).join(' ')}; do
  if [ -e "$p" ]; then
    printf '%s|%s|%s\\n' "$p" "$(stat -c %Y "$p" 2>/dev/null)" "$(stat -c %s "$p" 2>/dev/null)"
  fi
done
echo "===DIRCOUNT==="
for p in ${STABLE_DIRS.map((d) => `"${d}"`).join(' ')}; do
  printf '%s|%s\\n' "$p" "$(find "$p" -maxdepth 1 2>/dev/null | wc -l)"
done
echo "===FILEMD5==="
md5sum /opt/web_cs/server.py /opt/web_cs/kb_config.json /etc/systemd/system/webchat.service /root/.hermes/cron/jobs.json 2>/dev/null
echo "===OURTMP==="
printf 'dsh-script|%s\\n' "$(ls -1 /tmp/.dsh-script-* 2>/dev/null | grep -v -F "$0" | wc -l)"
printf 'dsh-ac|%s\\n' "$(ls -1 /tmp/.dsh-ac-* 2>/dev/null | grep -v -F "$0" | wc -l)"
echo "FP_RC=0"
`;

/** 从指纹输出里取出可比较的三个部分。 */
function parseFp(text) {
  const seg = (name) => (text.split(`===${name}===`)[1] ?? '').split('===')[0];
  const lines = (name) =>
    seg(name)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  return {
    dirMtime: lines('DIRMTIME'),
    dirCount: lines('DIRCOUNT'),
    fileMd5: lines('FILEMD5'),
    // 只取 `name|count` 形态的行：该段后面紧跟 FP_RC=0，不滤掉会被当成残留
    ourTmp: lines('OURTMP').filter((l) => /^[a-z0-9-]+\|\d+$/.test(l)),
  };
}

// ---------------- 汇总 ----------------

const results = [];
const record = (id, desc, ok, detail = '') => {
  results.push({ id, desc, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? `\n          ${detail}` : ''}`);
};

async function main() {
  console.log(`目标：${USER}@${HOST}  服务器名=${SERVER_NAME}`);
  console.log(`extraPaths 来源：${CONFIG_PATH || '（未提供 --config，使用空数组）'}`);
  console.log(`解析到 ${EXTRA_PATHS.length} 条：${EXTRA_PATHS.map((e) => e.name).join(', ') || '（无）'}\n`);

  if (!EXTRA_PATHS.length) {
    console.error('没有 extraPaths，AC-1/AC-2 无法验收。请用 --config 指到运行中的 cordis.patch.yml。');
    process.exit(2);
  }

  // AC-6 的测量窗口必须紧贴扫描动作：前面不放任何会改服务器的步骤，
  // 后面也立刻取指纹。AC-3 会创建临时 unit（那当然会改 /etc/systemd/system），
  // 所以它必须排在 AC-6 之后。
  const fpBefore = ssh(FP_SCRIPT);

  // 主扫描
  const t0 = Date.now();
  const server = { name: SERVER_NAME, host: HOST, port: PORT, user: USER, keyPath: SSH_KEY };
  const res = await scanExternalDeps({ server, extraPaths: EXTRA_PATHS, maxExtras: MAX_EXTRAS });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const fpAfter = ssh(FP_SCRIPT);
  console.log(`扫描完成：${elapsed}s，warnings=${res.discoveryWarnings.length}\n`);

  // ---------------- AC-1 ----------------
  {
    const epItems = res.covered.filter((c) => c.coverage === 'extraPaths');
    const configured = EXTRA_PATHS.filter((e) => e.name !== 'vault' || true);
    const expected = ['/opt/web_cs', '/opt/1panel/www', '/root/.hermes/profiles/cs-main'];
    const hit = expected.filter((p) => epItems.some((c) => c.path === p));
    record(
      'AC-1',
      'extraPaths 覆盖的目录判 covered，coverage=extraPaths',
      hit.length === 3 && epItems.length >= 3,
      `命中 ${hit.length}/3 预期目录；extraPaths 类共 ${epItems.length} 条`,
    );
  }

  // ---------------- AC-2 ----------------
  {
    const ctx = buildCoverageContext({ instance: res.instance, extraPaths: EXTRA_PATHS, containers: [] });
    const three = [
      '/root/scripts/odoo19-website-translator',
      '/root/scripts/toogel',
      '/root/scripts/toogel-v20',
    ];
    const cls = three.map((p) => ({ p: p.split('/').pop(), r: classifyCoverage({ path: p, context: ctx }) }));
    const allL2 = cls.every((x) => x.r.coverage === 'l2');
    const hasL2Sample = res.covered.some((c) => c.coverage === 'l2');
    record(
      'AC-2',
      '三个 scripts 目录判 covered 且 coverage=l2，理由引用 L2 覆盖线',
      allL2 && hasL2Sample,
      `三个目录=${cls.map((x) => `${x.p}:${x.r.coverage}`).join(' ')}；覆盖清单里 l2 样例=${hasL2Sample}`,
    );
  }

  // ---------------- AC-6 ----------------
  //
  // 判定口径（比「整段字节相同」更准）：
  //   · 静态目录的 mtime 必须不变——扫描若在里面创建/删除文件就会变；
  //   · 所有受监测目录的**条目数**必须不变——不能增删；
  //   · 关键文件的 md5 必须不变——不能改内容。
  // 不比对活目录（/root/.hermes、/opt/web_cs）的 mtime：hermes gateway 与
  // webchat 在持续写，那是既有行为，算成「扫描写入」是假阳性。
  {
    const a = parseFp(fpBefore);
    const b = parseFp(fpAfter);
    const diff = [];
    if (a.dirMtime.join('|') !== b.dirMtime.join('|')) {
      diff.push(`静态目录 mtime 变了：\n    前 ${a.dirMtime.join(' / ')}\n    后 ${b.dirMtime.join(' / ')}`);
    }
    if (a.dirCount.join('|') !== b.dirCount.join('|')) {
      diff.push(`静态目录条目数变了：\n    前 ${a.dirCount.join(' / ')}\n    后 ${b.dirCount.join(' / ')}`);
    }
    if (a.fileMd5.join('|') !== b.fileMd5.join('|')) {
      diff.push(`关键文件 md5 变了：\n    前 ${a.fileMd5.join(' / ')}\n    后 ${b.fileMd5.join(' / ')}`);
    }
    // 等价证据：扫描若要写服务器，必然留下临时文件
    const leftovers = [...a.ourTmp, ...b.ourTmp].filter((l) => !/\|0$/.test(l));
    if (leftovers.length) {
      diff.push(`我们留下了临时脚本残留：${leftovers.join(' / ')}`);
    }
    record(
      'AC-6',
      '扫描零写入：静态目录 mtime/条目数、关键文件 md5 前后一致，且无临时脚本残留',
      diff.length === 0,
      diff.length === 0
        ? `静态目录 ${a.dirMtime.length} 个 mtime 不变、条目数不变、关键文件 ${a.fileMd5.length} 个 md5 不变、临时残留 0`
        : diff.join('\n  '),
    );
  }

  // ---------------- AC-3 ----------------
  //  放在 AC-6 之后：它要临时创建 unit 并 daemon-reload，会改 /etc/systemd/system，
  //  时间窗口必须先关闭。
  {
    const UNIT = '/etc/systemd/system/dsh-acceptance-tmp.service';
    const SETUP = [
      'mkdir -p /opt/test-svc',
      'echo ac3-payload > /opt/test-svc/data.txt',
      `cat > ${UNIT} <<'UNITEOF'`,
      '[Unit]',
      'Description=DSH acceptance temp unit (auto-removed)',
      '[Service]',
      'Type=simple',
      'WorkingDirectory=/opt/test-svc',
      'ExecStart=/bin/sleep 600',
      '[Install]',
      'WantedBy=multi-user.target',
      'UNITEOF',
      'systemctl daemon-reload',
      'systemctl start dsh-acceptance-tmp.service',
      'sleep 1',
      'systemctl is-active dsh-acceptance-tmp.service',
    ].join('\n');
    const CLEAN = [
      'systemctl stop dsh-acceptance-tmp.service >/dev/null 2>&1 || true',
      `rm -f ${UNIT}`,
      'systemctl daemon-reload >/dev/null 2>&1',
      'rm -rf /opt/test-svc',
      'echo AC3_CLEANED',
    ].join('\n');

    let ok3 = false;
    let detail = '';
    try {
      const setupOut = ssh(SETUP);
      if (!/^active$/m.test(setupOut)) {
        detail = '临时 unit 未能启动，AC-3 无法验收';
      } else {
        const r2 = await scanExternalDeps({ server, extraPaths: EXTRA_PATHS, maxExtras: MAX_EXTRAS });
        const hit = r2.suggest.find((s) => s.path === '/opt/test-svc');
        const srcs = hit?.sources ?? [];
        ok3 = Boolean(hit) && srcs.includes('L4-systemd');
        detail = hit
          ? `进 suggest，sources=${srcs.join(',')}`
          : `未进 suggest（本次 suggest=${r2.suggest.length} 条）`;
      }
    } catch (err) {
      detail = `临时 unit 创建/扫描失败：${err?.message ?? err}`;
    } finally {
      try {
        ssh(CLEAN);
      } catch {
        /* 清理失败不掩盖结论 */
      }
    }
    record('AC-3', '临时 systemd unit 的 WorkingDirectory 进建议，证据含 L4-systemd', ok3, detail);
  }

  // ---------------- AC-4 ----------------
  {
    const sum4 = res.counts.covered + res.counts.suggest + res.counts.confirm + res.counts.overflow;
    const sum5 = COVERAGE_STATES.reduce((a, k) => a + (res.coverageCounts[k] ?? 0), 0);
    const realLen =
      res.covered.length + res.suggest.length + res.confirm.length + res.overflow.length;
    record(
      'AC-4',
      '四档计数之和 == 发现总数，coverage 各态之和同样 == 总数',
      sum4 === realLen && sum5 === realLen && realLen > 0,
      `四档=${sum4} 各态=${sum5} 数组实长=${realLen}`,
    );
  }

  // ---------------- AC-5 ----------------
  {
    const narrow = await scanExternalDeps({
      server,
      extraPaths: EXTRA_PATHS,
      maxExtras: Math.max(1, EXTRA_PATHS.length - 3),
    });
    const sumN = narrow.counts.covered + narrow.counts.suggest + narrow.counts.confirm + narrow.counts.overflow;
    const lenN =
      narrow.covered.length + narrow.suggest.length + narrow.confirm.length + narrow.overflow.length;
    const allRendered = narrow.overflow.every((o) => narrow.report.includes(o.path));
    record(
      'AC-5',
      'MAX_EXTRAS 调小后超限项完整保留在 overflow 且全部出现在报告里（不静默截断）',
      sumN === lenN && allRendered && narrow.overflow.length > 0 && narrow.suggest.length === 0,
      `maxExtras=${Math.max(1, EXTRA_PATHS.length - 3)} → suggest=${narrow.suggest.length} overflow=${narrow.overflow.length}，报告含全部 overflow=${allRendered}`,
    );
  }

  // ---------------- AC-6 已在上方（紧贴扫描窗口）完成 ----------------

  // ---------------- AC-7 ----------------
  {
    const payload = JSON.stringify(res);
    const badApi = [];
    (function walk(node, p) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${p}[${i}]`));
        return;
      }
      if ('key' in node && 'shape' in node) {
        const shape = String(node.shape);
        const okShape =
          shape === '***' || /^\d+ 字符$/.test(shape) || /^https?:\/\/[^/?]+$/.test(shape) || shape === '本地绝对路径';
        if (!okShape) badApi.push(`${p}: ${node.key}=${shape}`);
        for (const f of ['value', 'secret', 'token', 'password', 'raw']) {
          if (f in node) badApi.push(`${p}: 含禁止字段 ${f}`);
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${p}.${k}`);
    })(res, '$');

    const skLike = payload.match(/sk-[A-Za-z0-9_-]{16,}/g) ?? [];
    record(
      'AC-7',
      '输出不含任何密钥值（api 只出现键名与掩码形状）',
      badApi.length === 0 && skLike.length === 0,
      `非掩码 shape/禁止字段 ${badApi.length} 处；sk- 形态串 ${skLike.length} 个`,
    );
  }

  // ---------------- AC-8 ----------------
  {
    const missing = COVERAGE_STATES.filter((k) => (res.coverageCounts[k] ?? 0) === 0);
    record(
      'AC-8',
      'coverage 各态（main/extraPaths/l2/none）在本机全部有真实样例',
      missing.length === 0,
      `分布 ${COVERAGE_STATES.map((k) => `${k}=${res.coverageCounts[k] ?? 0}`).join(' ')}`,
    );
  }

  // ---------------- AC-9 ----------------
  {
    const tail = res.report.split('## 模块 → 服务 → 六类资产')[1] ?? '';
    const blocks = tail.split(/^### /m).slice(1);
    const missing = [];
    for (const b of blocks) {
      const name = b.split('\n')[0].trim();
      for (const cls of ['config', 'data', 'files', 'db', 'api', 'recovery']) {
        if (!new RegExp(`^- ${cls}:`, 'm').test(b)) missing.push(`${name}/${cls}`);
      }
    }
    const apiSafe = !/sk-[A-Za-z0-9]{16,}/.test(tail) && !/shape=(?!\*\*\*)/.test(tail);
    record(
      'AC-9',
      '依赖图每个服务六类齐全（缺类写「未发现」），api 只出现键名与形状',
      blocks.length > 0 && missing.length === 0 && apiSafe,
      `服务 ${blocks.length} 个，缺类 ${missing.length} 处${missing.length ? `（${missing.slice(0, 4).join(',')}）` : ''}；api 形态合规=${apiSafe}`,
    );
  }

  // ---------------- AC-10 ----------------
  {
    const pureStatic = res.suggest.filter((s) => (s.sources ?? []).every((x) => x === 'L2-config'));
    const staticTotal = res.confirm.filter((c) =>
      (c.sources ?? []).every((x) => x === 'L2-config'),
    ).length;
    record(
      'AC-10',
      '静态扫描线索不得单独产出建议',
      pureStatic.length === 0,
      `suggest 中纯静态线索 ${pureStatic.length} 条；confirm 中纯静态线索 ${staticTotal} 条（后者是正确归宿）`,
    );
  }

  // ---------------- 汇总 ----------------
  const passCount = results.filter((r) => r.ok).length;
  console.log(`\n================ 验收结果 ${passCount}/${results.length} ================`);
  for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.id}  ${r.desc}`);
  console.log('\n报告头：');
  console.log(res.report.split('\n').slice(0, 9).join('\n'));

  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本异常：', err?.stack ?? err);
  process.exit(2);
});
