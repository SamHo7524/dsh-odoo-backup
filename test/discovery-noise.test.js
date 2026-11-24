import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pathKind,
  isInstallTreePath,
  isDbPhysicalData,
  mapContainerPathToHost,
} from '../lib/discovery/paths.js';
import { collectCandidates, collectCandidatesDetailed, tierCandidates } from '../lib/discovery/scan.js';
import { classifyCoverage } from '../lib/discovery/coverage.js';

/**
 * 这一组测试全部来自 2026-11-23 第一次 toogel 真机扫描的真实误报。
 *
 * 背景：那次扫描 24 条候选里 5 类判断错误——
 *  1. `/etc/default`、`/etc/sysconfig`、`/etc/localtime` 被当成业务数据建议新增
 *  2. openresty 的 `log` / `root` / `modules` / `conf/*` 共 11 条进 overflow
 *  3. 已被主备份覆盖的 odoo.conf 判成 `none`（容器路径 vs 宿主机路径）
 *  4. PostgreSQL 物理数据目录 1 GB 进 overflow
 *  5. `/root/attendance-system` 是真服务（真阳性，不是误报）
 *
 * 这些测试的作用是把「扫描器不许把这些东西端给用户」钉死。
 */

const CONTAINERS = [
  {
    name: '1Panel-odoo-kwnb',
    image: 'odoo:19.0',
    mounts: [
      { source: '/opt/1panel/apps/odoo/odoo19/data/addons', destination: '/mnt/extra-addons' },
      { source: '/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf', destination: '/etc/odoo/odoo.conf' },
      { source: '/opt/1panel/apps/odoo/odoo19/data/data', destination: '/var/lib/odoo' },
    ],
  },
  {
    name: 'attendance',
    image: 'python:3.14.0',
    mounts: [
      { source: '/opt/1panel/runtime/python/attendance/.env', destination: '/.env' },
      { source: '/root/attendance-system', destination: '/app' },
    ],
  },
];

// ---------------- DN-K：pathKind 新增两类非候选 ----------------

test('DN-K1 /etc/default 是系统共享配置目录，不进候选', () => {
  assert.equal(pathKind('/etc/default'), 'system');
});

test('DN-K2 /etc/sysconfig 是系统共享配置目录，不进候选', () => {
  assert.equal(pathKind('/etc/sysconfig'), 'system');
});

test('DN-K3 /etc/localtime 是系统发布文件，不进候选', () => {
  assert.equal(pathKind('/etc/localtime'), 'system');
});

test('DN-K4 /etc/systemd/system 仍是合法备份目标（不能因 /etc 规则误伤）', () => {
  assert.equal(pathKind('/etc/systemd/system'), 'ok');
});

test('DN-K5 日志目录按 basename 判为 nondata', () => {
  assert.equal(pathKind('/opt/1panel/apps/openresty/openresty/log'), 'nondata');
});

test('DN-K6 文件名里带 log 不是目录，不能被 nondata 误伤', () => {
  assert.equal(pathKind('/opt/web_cs/query_log.db'), 'ok');
});

// ---------------- DN-I：镜像安装树 ----------------

test('DN-I1 openresty 的 modules/conf/root 属于镜像自带安装树', () => {
  assert.equal(isInstallTreePath('/opt/1panel/apps/openresty/openresty/modules'), true);
  assert.equal(isInstallTreePath('/opt/1panel/apps/openresty/openresty/conf/nginx.conf'), true);
  assert.equal(isInstallTreePath('/opt/1panel/apps/openresty/openresty/root'), true);
});

test('DN-I2 odoo 的 data 子树不属于安装树（那是真数据）', () => {
  assert.equal(isInstallTreePath('/opt/1panel/apps/odoo/odoo19/data/addons'), false);
  assert.equal(isInstallTreePath('/opt/1panel/apps/odoo/odoo19/data/data'), false);
});

test('DN-I3 不在 /opt/1panel/apps 下的路径一律不算安装树', () => {
  assert.equal(isInstallTreePath('/root/attendance-system'), false);
  assert.equal(isInstallTreePath('/opt/web_cs/modules'), false);
});

// ---------------- DN-D：数据库物理数据目录 ----------------

test('DN-D1 postgresql 的 data 是物理数据目录', () => {
  assert.equal(isDbPhysicalData('/opt/1panel/apps/postgresql/postgresql/data'), true);
});

test('DN-D2 odoo 的 data/data 不是数据库物理目录（是 filestore）', () => {
  assert.equal(isDbPhysicalData('/opt/1panel/apps/odoo/odoo19/data/data'), false);
});

// ---------------- DN-M：容器路径 → 宿主机路径映射 ----------------

test('DN-M1 /etc/odoo/odoo.conf 映射回宿主机路径', () => {
  assert.equal(
    mapContainerPathToHost('/etc/odoo/odoo.conf', [{ name: '1Panel-odoo-kwnb', mounts: CONTAINERS[0].mounts }]),
    '/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf',
  );
});

test('DN-M2 容器内子路径按前缀替换', () => {
  assert.equal(
    mapContainerPathToHost('/var/lib/odoo/filestore/x', [{ name: 'x', mounts: CONTAINERS[0].mounts }]),
    '/opt/1panel/apps/odoo/odoo19/data/data/filestore/x',
  );
});

test('DN-M3 无匹配挂载时原样返回', () => {
  assert.equal(mapContainerPathToHost('/srv/other', [{ name: 'x', mounts: CONTAINERS[0].mounts }]), '/srv/other');
});

// ---------------- DN-C：候选收集要分类忽略，而不是静默丢弃 ----------------

test('DN-C1 三类噪声被收集层挡掉，且计数分类正确', () => {
  const detailed = collectCandidatesDetailed({
    runtime: {
      containers: [
        ...CONTAINERS,
        {
          name: '1Panel-openresty-OI6y',
          image: '1panel/openresty:1.31.1.1-2-1-noble',
          mounts: [
            { source: '/opt/1panel/apps/openresty/openresty/log', destination: '/var/log/nginx' },
            { source: '/opt/1panel/apps/openresty/openresty/modules', destination: '/usr/lib/nginx/modules' },
            { source: '/etc/localtime', destination: '/etc/localtime' },
          ],
        },
      ],
    },
    systemd: {
      units: [
        { name: 'webchat.service', workingDirectory: '/opt/web_cs', environmentFile: '/root/.hermes/profiles/cs-main/.env' },
        { name: 'cron.service', environmentFile: '/etc/default/cron' },
        { name: 'aliyun.service', environmentFile: '/etc/sysconfig/aliyun' },
        // 故意再给一个同样指向 /etc/default/cron 的 unit：真实系统里多个 unit
        // 共享同一个 EnvironmentFile 是常态。计数必须按**路径**去重，否则
        // 「已忽略 N 条」会随证据条数虚涨，与用户数得出来的目录数对不上。
        { name: 'cron-daily.service', environmentFile: '/etc/default/cron' },
      ],
    },
    config: null,
    odoo: null,
  });

  const paths = detailed.candidates.map((c) => c.path);
  assert.ok(!paths.includes('/etc/default'), '/etc/default 不应成为候选');
  assert.ok(!paths.includes('/etc/sysconfig'), '/etc/sysconfig 不应成为候选');
  assert.ok(!paths.includes('/etc/localtime'), '/etc/localtime 不应成为候选');
  assert.ok(!paths.includes('/opt/1panel/apps/openresty/openresty/log'), '日志目录不应成为候选');

  // 精确计数（不是 >= N）：重复证据必须被去重。
  // system 桶的 5 个唯一路径 = /etc/localtime、/etc/default、/etc/default/cron、
  // /etc/sysconfig、/etc/sysconfig/aliyun。
  assert.equal(detailed.ignored.system, 5, 'system 桶必须按路径去重后计数');
  assert.equal(detailed.ignored.nondata, 1, 'nondata 桶只应有 1 个唯一路径');
  assert.deepEqual(
    [...detailed.ignoredPaths.system].sort(),
    ['/etc/default', '/etc/default/cron', '/etc/localtime', '/etc/sysconfig', '/etc/sysconfig/aliyun'],
  );
  assert.deepEqual(detailed.ignoredPaths.nondata, ['/opt/1panel/apps/openresty/openresty/log']);
});

test('DN-C2 安装树路径仍是候选，但打上 install-tree 标记', () => {
  const detailed = collectCandidatesDetailed({
    runtime: {
      containers: [
        {
          name: '1Panel-openresty-OI6y',
          mounts: [{ source: '/opt/1panel/apps/openresty/openresty/modules', destination: '/usr/lib/nginx/modules' }],
        },
      ],
    },
    systemd: null,
    config: null,
    odoo: null,
  });
  const it = detailed.candidates.find((c) => c.path === '/opt/1panel/apps/openresty/openresty/modules');
  assert.ok(it, '安装树路径要保留（可见比干净更重要）');
  assert.equal(it.category, 'install-tree');
});

test('DN-C3 collectCandidates 旧签名仍返回数组', () => {
  const arr = collectCandidates({ runtime: null, systemd: null, config: null, odoo: null });
  assert.ok(Array.isArray(arr));
});

// ---------------- DN-T：分类层的新判定 ----------------

function ctx(extra = []) {
  return {
    main: {
      addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons',
      dataPath: '/opt/1panel/apps/odoo/odoo19/data/data',
      pydepsPath: '/opt/1panel/apps/odoo/odoo19/data/data/.local',
      confPath: '/etc/odoo/odoo.conf',
      hostConfPath: '/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf',
    },
    extraPaths: extra,
    l2: [],
    recoveryRisks: {},
    containers: CONTAINERS,
  };
}

test('DN-T1 数据库物理目录进清单（inventory），不进待确认也不进建议', () => {
  // 契约变更（2026-11-24 用户边界裁决）：这类路径判 disposition=EXCLUDED，
  // 归入 inventory 清单而不是 confirm。理由：confirm 是「需要人做决定的待办」，
  // 而物理目录的正确处置已经确定（靠 pg_dump），没有待决事项。
  const tier = tierCandidates({
    candidates: [
      { path: '/opt/1panel/apps/postgresql/postgresql/data', sources: ['L3-runtime'], confidence: 'high' },
    ],
    context: ctx(),
    probe: {
      ok: true,
      entries: [{ path: '/opt/1panel/apps/postgresql/postgresql/data', exists: true, readable: true, bytes: 999572385, isDir: true }],
    },
    maxExtras: 8,
    configuredCount: 0,
  });
  assert.equal(tier.suggest.length, 0, '数据库物理目录绝不能进建议');
  assert.equal(tier.confirm.length, 0, '处置已确定，不该进待确认');
  assert.equal(tier.inventory.length, 1);
  assert.equal(tier.inventory[0].disposition, 'EXCLUDED');
  assert.match(tier.inventory[0].dispositionReason, /物理|逻辑导出|pg_dump/);
});

test('DN-T2 单文件进待确认，理由说明 extraPaths 只支持目录', () => {
  // `/opt/1panel/runtime/python/attendance/.env` 是 attendance 的业务级环境变量，
  // 属 RESTORE_REQUIRED，因此会走到「单文件」这条降级。
  // （曾把它归到 `/opt/1panel/runtime` 预置前缀，导致业务配置被判成「不用备份」。）
  const tier = tierCandidates({
    candidates: [{ path: '/opt/1panel/runtime/python/attendance/.env', sources: ['L3-runtime'], confidence: 'high' }],
    context: ctx(),
    probe: {
      ok: true,
      entries: [{ path: '/opt/1panel/runtime/python/attendance/.env', exists: true, readable: true, bytes: 223, isDir: false }],
    },
    maxExtras: 8,
    configuredCount: 0,
  });
  assert.equal(tier.suggest.length, 0);
  assert.equal(tier.confirm.length, 1);
  assert.match(tier.confirm[0].reasons.join('；'), /单文件/);
});

test('DN-T3 install-tree 进清单，理由点名镜像重建', () => {
  // 同 DN-T1 的契约变更：镜像安装树判 PREINSTALLED_RUNTIME，归 inventory。
  const tier = tierCandidates({
    candidates: [
      {
        path: '/opt/1panel/apps/openresty/openresty/modules',
        sources: ['L3-runtime'],
        confidence: 'high',
        category: 'install-tree',
      },
    ],
    context: ctx(),
    probe: {
      ok: true,
      entries: [{ path: '/opt/1panel/apps/openresty/openresty/modules', exists: true, readable: true, bytes: 1024, isDir: true }],
    },
    maxExtras: 8,
    configuredCount: 0,
  });
  assert.equal(tier.suggest.length, 0);
  assert.equal(tier.confirm.length, 0);
  assert.equal(tier.inventory.length, 1);
  assert.equal(tier.inventory[0].disposition, 'PREINSTALLED_RUNTIME');
  assert.match(tier.inventory[0].dispositionReason, /镜像/);
});

test('DN-T4 真阳性仍然进建议：/root/attendance-system 是目录且未覆盖', () => {
  const tier = tierCandidates({
    candidates: [{ path: '/root/attendance-system', sources: ['L3-runtime'], confidence: 'high' }],
    context: ctx(),
    probe: {
      ok: true,
      entries: [{ path: '/root/attendance-system', exists: true, readable: true, bytes: 128106463, isDir: true }],
    },
    maxExtras: 8,
    configuredCount: 0,
  });
  assert.equal(tier.suggest.length, 1, '真实未覆盖的服务数据必须能被建议出来');
  assert.equal(tier.suggest[0].path, '/root/attendance-system');
});

// ---------------- DN-V：覆盖判定要认宿主机路径 ----------------

test('DN-V1 odoo.conf 的宿主机路径应判 main（不能因为容器路径不相等而判 none）', () => {
  const r = classifyCoverage({
    path: '/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf',
    context: ctx(),
  });
  assert.equal(r.coverage, 'main', `期望 main，实际 ${r.coverage}（${r.reason}）`);
});

test('DN-V2 容器内路径本身仍判 main', () => {
  const r = classifyCoverage({ path: '/etc/odoo/odoo.conf', context: ctx() });
  assert.equal(r.coverage, 'main');
});

// ---------------- DN-R：报告头必须交代忽略了什么 ----------------

test('DN-R1 报告头含「已忽略」分类说明', async () => {
  const { buildReport } = await import('../lib/discovery/scan.js');
  const tier = tierCandidates({
    candidates: [],
    context: ctx(),
    probe: { ok: true, entries: [] },
    maxExtras: 8,
    configuredCount: 0,
  });
  tier.ignored = { system: 3, nondata: 1, tooBroad: 0 };
  const text = buildReport({ server: 'toogel', tier, graph: null });
  assert.match(text, /已忽略/);
  assert.match(text, /系统发布件/);
});
