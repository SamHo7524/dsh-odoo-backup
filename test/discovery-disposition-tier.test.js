import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tierCandidates, buildReport } from '../lib/discovery/scan.js';
import { DISPOSITIONS } from '../lib/discovery/disposition.js';

/** 覆盖上下文：主备份 + 一条 web_cs 额外路径。 */
const CTX = {
  main: {
    addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons',
    dataPath: '/opt/1panel/apps/odoo/odoo19/data/data',
    pydepsPath: '/opt/1panel/apps/odoo/odoo19/data/data/.local',
    confPath: '/etc/odoo/odoo.conf',
    hostConfPath: '/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf',
  },
  extraPaths: [{ name: 'web-cs', path: '/opt/web_cs', exclude: ['./venv'] }],
  l2: [],
  recoveryRisks: {},
  containers: [],
};

const WAF = '/opt/1panel/apps/openresty/openresty/1pwaf/data';

/** 造一批混合候选，覆盖四分类。 */
function mixed() {
  return [
    // RESTORE_REQUIRED 且未覆盖 → 应进 suggest
    { path: '/root/attendance-system', sources: ['L3-runtime'], confidence: 'high' },
    { path: '/opt/1panel/www', sources: ['L3-runtime'], confidence: 'high' },
    { path: `${WAF}/sites`, sources: ['L3-runtime'], confidence: 'high' },
    // PREINSTALLED_RUNTIME → inventory
    { path: '/opt/1panel/db', sources: ['L3-runtime'], confidence: 'high' },
    { path: `${WAF}/rules`, sources: ['L3-runtime'], confidence: 'high' },
    { path: '/root/.hermes/node', sources: ['L3-runtime'], confidence: 'high' },
    // REBUILDABLE_DEPENDENCY → inventory
    { path: '/opt/web_cs/venv', sources: ['L3-runtime'], confidence: 'high' },
    { path: `${WAF}/geo`, sources: ['L3-runtime'], confidence: 'high' },
    // EXCLUDED → inventory
    { path: `${WAF}/db`, sources: ['L3-runtime'], confidence: 'high' },
    { path: '/opt/1panel/www/sites/www.toogel.cn/log', sources: ['L3-runtime'], confidence: 'high' },
  ];
}

function probeFor(list) {
  return {
    ok: true,
    entries: list.map((c) => ({ path: c.path, exists: true, bytes: 1234, readable: true, isDir: true })),
  };
}

function runTier(list = mixed()) {
  return tierCandidates({
    candidates: list,
    context: CTX,
    probe: probeFor(list),
    maxExtras: 8,
    configuredCount: 1,
  });
}

// ---------------- RB-T：四档 + 清单的契约 ----------------

test('RB-T1 suggest 中不含任何非 RESTORE_REQUIRED 的条目（RB-2）', () => {
  const r = runTier();
  for (const it of r.suggest) {
    assert.equal(it.disposition, 'RESTORE_REQUIRED', `${it.path} 不该进建议`);
  }
  assert.deepEqual(r.suggest.map((i) => i.path).sort(), [
    `${WAF}/sites`,
    '/opt/1panel/www',
    '/root/attendance-system',
  ]);
});

test('RB-T2 预置运行环境进 inventory，不进 suggest / confirm / overflow', () => {
  const r = runTier();
  const paths = r.inventory.map((i) => i.path);
  for (const p of ['/opt/1panel/db', `${WAF}/rules`, '/root/.hermes/node']) {
    assert.ok(paths.includes(p), `${p} 应在 inventory`);
    assert.ok(!r.suggest.some((i) => i.path === p), `${p} 不得进 suggest`);
    assert.ok(!r.confirm.some((i) => i.path === p), `${p} 不得进 confirm`);
    assert.equal(r.inventory.find((i) => i.path === p).disposition, 'PREINSTALLED_RUNTIME');
  }
});

test('RB-T3 可重建依赖进 inventory 且带四项重建信息（RB-4）', () => {
  const r = runTier();
  for (const p of ['/opt/web_cs/venv', `${WAF}/geo`]) {
    const it = r.inventory.find((i) => i.path === p);
    assert.ok(it, `${p} 应在 inventory`);
    assert.equal(it.disposition, 'REBUILDABLE_DEPENDENCY');
    assert.ok(it.rebuild, `${p} 的 rebuild 不能为空`);
    for (const k of ['how', 'source', 'version', 'verify']) {
      assert.ok(it.rebuild[k], `${p} 的 rebuild.${k} 不能为空`);
    }
  }
});

test('RB-T4 已排除项进 inventory 且 disposition=EXCLUDED', () => {
  const r = runTier();
  for (const p of [`${WAF}/db`, '/opt/1panel/www/sites/www.toogel.cn/log']) {
    const it = r.inventory.find((i) => i.path === p);
    assert.ok(it, `${p} 应在 inventory`);
    assert.equal(it.disposition, 'EXCLUDED');
  }
});

test('RB-T5 四档 + inventory 之和 == 发现总数，职责四类之和也 == 总数（RB-1）', () => {
  const list = mixed();
  const r = runTier(list);
  const tierSum = r.counts.covered + r.counts.suggest + r.counts.confirm + r.counts.overflow + r.counts.inventory;
  assert.equal(tierSum, list.length, '五档之和必须等于发现总数');

  const dispSum = DISPOSITIONS.reduce((a, k) => a + (r.dispositionCounts[k] ?? 0), 0);
  assert.equal(dispSum, list.length, '职责四类之和必须等于发现总数');
});

test('RB-T6 dispositionCounts 含全部四个键（含 0 值）', () => {
  const r = runTier();
  assert.deepEqual(Object.keys(r.dispositionCounts).sort(), [...DISPOSITIONS].sort());
  assert.equal(r.dispositionCounts.RESTORE_REQUIRED, 3);
  assert.equal(r.dispositionCounts.PREINSTALLED_RUNTIME, 3);
  assert.equal(r.dispositionCounts.REBUILDABLE_DEPENDENCY, 2);
  assert.equal(r.dispositionCounts.EXCLUDED, 2);
});

test('RB-T7 已覆盖的预置项仍进 covered（覆盖判定优先于职责判定）', () => {
  // /opt/1panel/db 若被某条 extraPaths 覆盖，它应进 covered 而不是 inventory：
  // 「已经备份了」是既成事实，不该因为「理论上不用备份」而把它藏起来。
  const ctx = {
    ...CTX,
    extraPaths: [{ name: 'panel', path: '/opt/1panel', exclude: [] }],
  };
  const list = [{ path: '/opt/1panel/db', sources: ['L3-runtime'], confidence: 'high' }];
  const r = tierCandidates({
    candidates: list,
    context: ctx,
    probe: probeFor(list),
    maxExtras: 8,
    configuredCount: 1,
  });
  assert.equal(r.covered.length, 1);
  assert.equal(r.inventory.length, 0);
  assert.equal(r.covered[0].disposition, 'PREINSTALLED_RUNTIME');
});

// ---------------- RB-R：报告 ----------------

test('RB-R1 报告头含「职责分布」一行且四类齐全（RB-8）', () => {
  const tier = runTier();
  const report = buildReport({ server: 'toogel', tier, graph: {} });
  assert.match(report, /职责分布：恢复业务状态 3 条 \/ 预置运行环境 3 条 \/ 可重建依赖 2 条 \/ 已排除 2 条/);
});

test('RB-R2 报告含「不需要备份的清单」一节，且三组各自分组', () => {
  const tier = runTier();
  const report = buildReport({ server: 'toogel', tier, graph: {} });
  assert.match(report, /## 五、不需要备份的清单/);
  assert.match(report, /### 预置运行环境（恢复前装好，不要打包）　共 3 条/);
  assert.match(report, /### 可重建依赖（不打包，但必须照此重建）　共 2 条/);
  assert.match(report, /### 已排除（与业务状态无关）　共 2 条/);
});

test('RB-R3 预置项在报告里带版本/镜像/来源（RB-3）', () => {
  const list = [
    {
      path: '/opt/1panel/apps/openresty/openresty/modules',
      sources: ['L3-runtime'],
      confidence: 'high',
      category: 'install-tree',
    },
  ];
  const r = tierCandidates({
    candidates: list,
    context: {
      ...CTX,
      containers: [
        {
          name: '1Panel-openresty-OI6y',
          image: '1panel/openresty:1.31.1.1-2-1-noble',
          mounts: [{ source: '/opt/1panel/apps/openresty/openresty', destination: '/usr/local/openresty' }],
        },
      ],
    },
    probe: probeFor(list),
    maxExtras: 8,
    configuredCount: 1,
  });
  const report = buildReport({ server: 'toogel', tier: r, graph: {} });
  assert.match(report, /预装 OpenResty｜版本 1\.31\.1\.1-2-1-noble｜镜像 1panel\/openresty:1\.31\.1\.1-2-1-noble/);
});

test('RB-R4 报告里的条目行含「职责 xxx（理由）」', () => {
  const tier = runTier();
  const report = buildReport({ server: 'toogel', tier, graph: {} });
  assert.match(report, /职责 RESTORE_REQUIRED（业务配置或数据/);
});

test('RB-R5 报告同时给覆盖分布与职责分布（两者都不能少）', () => {
  const tier = runTier();
  const report = buildReport({ server: 'toogel', tier, graph: {} });
  assert.match(report, /覆盖分布：main \d+ \/ extraPaths \d+ \/ l2 \d+ \/ none \d+/);
  assert.match(report, /职责分布：/);
  // 职责分布必须在覆盖分布之后、未验证恢复之前，读者按顺序读到「有没有备份」再读「该不该备份」
  assert.ok(report.indexOf('覆盖分布：') < report.indexOf('职责分布：'));
});

test('RB-R6 inventory 为空时第五节仍渲染三组「（无）」而不是整节省略', () => {
  const list = [{ path: '/root/attendance-system', sources: ['L3-runtime'], confidence: 'high' }];
  const r = tierCandidates({
    candidates: list,
    context: CTX,
    probe: probeFor(list),
    maxExtras: 8,
    configuredCount: 1,
  });
  const report = buildReport({ server: 'toogel', tier: r, graph: {} });
  assert.match(report, /### 预置运行环境（恢复前装好，不要打包）　共 0 条/);
  assert.match(report, /### 已排除（与业务状态无关）　共 0 条/);
});
