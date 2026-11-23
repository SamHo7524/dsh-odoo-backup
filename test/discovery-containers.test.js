import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServices } from '../lib/discovery/services.js';
import { buildDependencyGraph } from '../lib/discovery/graph.js';
import { buildReport } from '../lib/discovery/scan.js';

/**
 * DSV-C：容器承载的「独立业务系统」必须成为依赖图里的服务。
 *
 * 用户 2026-11-23 裁决（m05214 第⑤条）：
 *   「以后 Discovery 不能只寻找 Odoo 模块依赖，还必须识别服务器上独立运行的业务系统。
 *     第二种不能因为找不到 Odoo 模块引用就自动忽略。
 *     我们不能等到灾难恢复时才发现还有第四个、第五个从未纳入备份的业务系统。」
 *
 * 真机背景（2026-11-23 实测）：`attendance (python:3.14.0)` 与
 * `1Panel-openresty-OI6y` 都只在 docker 里跑、**没有 systemd unit**，
 * 因此旧实现（只遍历 units）把它们整段丢掉——报告 33 个服务全是 systemd unit。
 */

const instance = {
  odooContainer: '1Panel-odoo-kwnb',
  odooVersion: '19.0-20260619',
  dbName: 'tg-odoo',
  addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons',
  dataPath: '/opt/1panel/apps/odoo/odoo19/data/data',
  pydepsPath: '/opt/1panel/apps/odoo/odoo19/data/data/.local',
  confPath: '/etc/odoo/odoo.conf',
};

const attendanceContainer = {
  name: 'attendance',
  image: 'python:3.14.0',
  status: 'running',
  mounts: [
    { source: '/opt/1panel/runtime/python/attendance/.env', destination: '/.env' },
    { source: '/root/attendance-system', destination: '/app' },
    { source: '/opt/1panel/runtime/python/attendance/run.sh', destination: '/run.sh' },
  ],
  envKeys: ['PYTHON_VERSION', 'EXEC_SCRIPT', 'CODE_DIR', 'CONTAINER_NAME'],
  workDir: '/app',
};

const openrestyContainer = {
  name: '1Panel-openresty-OI6y',
  image: '1panel/openresty:1.31.1.1-2-1-noble',
  status: 'running',
  mounts: [
    { source: '/etc/localtime', destination: '/etc/localtime' },
    { source: '/opt/1panel/apps/openresty/openresty/log', destination: '/var/log/nginx' },
    { source: '/opt/1panel/apps/openresty/openresty/1pwaf/data', destination: '/usr/local/1pwaf/data' },
    { source: '/opt/1panel/apps/openresty/openresty/conf/nginx.conf', destination: '/usr/local/openresty/nginx/conf/nginx.conf' },
  ],
  envKeys: [],
  workDir: '',
};

const odooContainer = {
  name: '1Panel-odoo-kwnb',
  image: 'odoo:19.0',
  status: 'running',
  mounts: [{ source: '/opt/1panel/apps/odoo/odoo19/data/addons', destination: '/mnt/extra-addons' }],
  envKeys: ['HOST'],
  workDir: '/var/lib/odoo',
};

function make(containers, extra = {}) {
  return buildServices({
    instance,
    units: [],
    ports: [],
    containers,
    modules: [],
    config: { envKeys: [], urls: [] },
    extraPaths: [],
    ...extra,
  });
}

test('DSV-C1 没有 systemd unit 的容器也要成为服务（独立业务系统不被丢弃）', () => {
  const out = make([attendanceContainer, openrestyContainer, odooContainer]);
  const names = out.map((s) => s.service);
  assert.ok(names.includes('attendance'), `缺少 attendance，实际：${names.join(',')}`);
  assert.ok(names.includes('1Panel-openresty-OI6y'), `缺少 openresty，实际：${names.join(',')}`);
});

test('DSV-C2 容器服务标 origin=container 且 standalone=true，link 恒为 unknown', () => {
  const out = make([attendanceContainer, odooContainer]);
  const att = out.find((s) => s.service === 'attendance');
  assert.equal(att.origin, 'container');
  assert.equal(att.standalone, true);
  // 没有任何模块引用它 —— 但正因为如此才必须显式标 unknown，而不是从报告里消失
  assert.equal(att.link, 'unknown');
  assert.deepEqual(att.modules, []);
});

test('DSV-C3 Odoo 自己的容器不重复成第二条服务', () => {
  const out = make([odooContainer]);
  const odooish = out.filter((s) => /1Panel-odoo-kwnb/.test(s.service));
  assert.equal(odooish.length, 1, `Odoo 容器被重复计入：${odooish.map((s) => s.service).join(',')}`);
  assert.equal(odooish[0].origin, 'odoo');
});

test('DSV-C4 已有同名 systemd unit 时不重复加容器服务', () => {
  const units = [
    {
      name: 'attendance.service',
      load: 'loaded',
      active: 'active',
      sub: 'running',
      description: 'Attendance',
      workingDirectory: '/root/attendance-system',
      environmentFile: '',
      execStart: '/root/attendance-system/venv/bin/python app.py',
      enabled: 'enabled',
    },
  ];
  const out = make([attendanceContainer], { units });
  const hits = out.filter((s) => s.service === 'attendance');
  assert.equal(hits.length, 1, `重复：${hits.length}`);
  assert.equal(hits[0].origin, 'systemd');
});

test('DSV-C5 容器挂载源进 files 类，且跳过系统发布件与日志目录', () => {
  const out = make([attendanceContainer, openrestyContainer]);
  const att = out.find((s) => s.service === 'attendance');
  const files = (att.assets.files ?? []).map((a) => a.path);
  assert.ok(files.includes('/root/attendance-system'), `files 缺 app 目录：${files.join(',')}`);
  assert.ok(files.includes('/opt/1panel/runtime/python/attendance/.env'));

  const ors = out.find((s) => s.service === '1Panel-openresty-OI6y');
  const ofiles = (ors.assets.files ?? []).map((a) => a.path);
  // /etc/localtime 是系统发布件、openresty/log 是日志目录 —— 都不该作为业务资产出现
  assert.ok(!ofiles.includes('/etc/localtime'), '系统发布件不该进 files');
  assert.ok(!ofiles.includes('/opt/1panel/apps/openresty/openresty/log'), '日志目录不该进 files');
  assert.ok(ofiles.includes('/opt/1panel/apps/openresty/openresty/1pwaf/data'), 'WAF 数据目录应进 files');
});

test('DSV-C6 容器 env 只记键名与 shape=***，绝不出现值', () => {
  const withSecret = {
    ...attendanceContainer,
    envKeys: ['EXEC_SCRIPT'],
    // 故意塞一个看起来像值的字段，验证装配层不把它带出去
    env: { EXEC_SCRIPT: 'super-secret-value-1234567890' },
  };
  const out = make([withSecret]);
  const att = out.find((s) => s.service === 'attendance');
  const api = JSON.stringify(att.assets.api ?? []);
  assert.match(api, /EXEC_SCRIPT/);
  assert.doesNotMatch(api, /super-secret-value/);
});

test('DSV-C7 报告必须给出「独立业务系统」小节，即使它没有任何模块关联', () => {
  const services = make([attendanceContainer, odooContainer]);
  const graph = buildDependencyGraph({ services });
  const report = buildReport({
    server: 'toogel',
    tier: { counts: {}, coverageCounts: {}, covered: [], suggest: [], confirm: [], overflow: [], capacity: {} },
    graph,
  });
  assert.match(report, /独立业务系统/);
  assert.match(report, /attendance/);
});

test('DSV-C9 镜像自带安装树不算业务资产（openresty 真机噪声）', () => {
  // 真机实测：openresty 容器 15 个挂载里，`root` / `conf/*` / `modules` 都是镜像自带，
  // 由容器镜像重建，不随备份恢复。把它们列进 files 会让「独立业务系统」的资产表失去意义。
  const out = make([openrestyContainer]);
  const ors = out.find((s) => s.service === '1Panel-openresty-OI6y');
  const files = (ors.assets.files ?? []).map((a) => a.path);
  assert.ok(
    !files.some((f) => /\/openresty\/openresty\/(root|modules|conf)(\/|$)/.test(f)),
    `安装树不该进 files：${files.filter((f) => /root|modules|conf/.test(f)).join(',')}`,
  );
  // 但 WAF 数据与站点配置是真的业务资产，必须留下
  assert.ok(files.includes('/opt/1panel/apps/openresty/openresty/1pwaf/data'));
});

test('DSV-C10 镜像自带 env 键不算 API 资产（PATH/PYTHON_SHA256 等）', () => {
  const imgEnv = {
    ...attendanceContainer,
    envKeys: ['PATH', 'LANG', 'PYTHON_VERSION', 'PYTHON_SHA256', 'GPG_KEY', 'SECRET_KEY'],
  };
  const out = make([imgEnv]);
  const att = out.find((s) => s.service === 'attendance');
  const keys = (att.assets.api ?? []).map((a) => a.key);
  for (const noise of ['PATH', 'LANG', 'PYTHON_VERSION', 'PYTHON_SHA256', 'GPG_KEY']) {
    assert.ok(!keys.includes(noise), `镜像自带 env 键 ${noise} 不该进 api 类（实际：${keys.join(',')}）`);
  }
  // 业务自己的键必须留下——它是「恢复时要重新配什么」的线索
  assert.ok(keys.includes('SECRET_KEY'), `业务 env 键 SECRET_KEY 被误删（实际：${keys.join(',')}）`);
  // 只留键名 + shape，值永不出现
  assert.equal(att.assets.api.find((a) => a.key === 'SECRET_KEY').shape, '***');
  assert.ok(!('value' in att.assets.api.find((a) => a.key === 'SECRET_KEY')));
});

test('DSV-C11 attendance 有恢复配方：数据/配置/恢复方式齐全', () => {
  const out = make([attendanceContainer]);
  const att = out.find((s) => s.service === 'attendance');
  const data = (att.assets.data ?? []).map((a) => a.path);
  const config = (att.assets.config ?? []).map((a) => a.path);
  const recovery = (att.assets.recovery ?? []).map((r) => `${r.target} → ${r.action}`).join('\n');

  assert.ok(data.some((d) => d.includes('attendance.db')), `缺数据库资产：${data.join(',')}`);
  assert.ok(config.length > 0, '缺配置资产');
  // 用户 m05214 要求：必须说清「一致性快照」而不是 tar 直拷活动库
  assert.match(recovery, /一致性|Online Backup|integrity_check/, `恢复方式没提一致性：${recovery}`);
});

test('DSV-C12 Odoo 依赖的数据库容器不算「独立业务系统」（它是主备份的一部分）', () => {
  // 真机实测：报告里出现了 `1Panel-postgresql-3eaO（postgres:18.4-alpine）` 并标成
  // 「独立业务系统」，但它是 Odoo 的 pgContainer——数据已由主包 dump.zip 的逻辑导出覆盖。
  // 把它列成「独立系统」会让报告自相矛盾：一边说 suggest=0 全覆盖，一边说它没恢复方式。
  const pgContainer = {
    name: '1Panel-postgresql-3eaO',
    image: 'postgres:18.4-alpine',
    status: 'running',
    mounts: [{ source: '/opt/1panel/apps/postgresql/postgresql/data', destination: '/var/lib/postgresql/data' }],
    envKeys: ['POSTGRES_USER', 'POSTGRES_PASSWORD'],
    workDir: '',
  };
  const out = buildServices({
    instance: { ...instance, pgContainer: '1Panel-postgresql-3eaO' },
    units: [],
    ports: [],
    containers: [pgContainer, attendanceContainer],
    modules: [],
    config: { envKeys: [], urls: [] },
    extraPaths: [],
  });
  const pgAsStandalone = out.find((s) => s.service === '1Panel-postgresql-3eaO' && s.standalone);
  assert.ok(!pgAsStandalone, 'Odoo 的 pg 容器不该被当成独立业务系统');
  // 但 attendance 仍必须出现（它才是真独立的）
  assert.ok(out.some((s) => s.service === 'attendance' && s.standalone));
});

test('DSV-C13 配方要能按镜像前缀命中（openresty 容器名带随机后缀）', () => {
  // 真机实测：容器名是 `1Panel-openresty-OI6y`，镜像 `1panel/openresty:1.31.1.1-2-1-noble`，
  // 配方键写的是 `1panel-openresty` —— 精确相等匹配不上，于是 config/data 全显示「未发现」。
  // 镜像前缀匹配必须成立，否则「自定义规则在哪」这个问题永远答不出来。
  const out = make([openrestyContainer]);
  const ors = out.find((s) => s.service === '1Panel-openresty-OI6y');
  const config = (ors.assets.config ?? []).map((c) => c.path).join(',');
  const data = (ors.assets.data ?? []).map((d) => d.path).join(',');
  assert.match(config, /1pwaf\/data\/sites/, `配方未命中，config=${config}`);
  assert.match(data, /1pwaf\/data\/geo/, `配方未命中，data=${data}`);
});

test('DSV-C14 同一类资产缺恢复方式只汇总一条，不逐条重复', () => {
  // 真机实测：attendance 的 recovery 里有 10 条，其中 9 条是同一句话重复
  // （「... 的 files 类资产未声明恢复方式」×3、「api 类」×1 ...）。
  // 报告是给人读的，重复 9 遍等于没写。
  const graph = buildDependencyGraph({ services: make([attendanceContainer]) });
  const att = graph.services.find((s) => s.service === 'attendance');
  const missingRec = (att.assets.recovery ?? []).filter((r) => r.source === 'missing');
  const perClass = {};
  for (const r of missingRec) {
    const m = r.action.match(/的 (\w+) 类资产未声明恢复方式/);
    const cls = m ? m[1] : 'other';
    perClass[cls] = (perClass[cls] ?? 0) + 1;
  }
  for (const [cls, n] of Object.entries(perClass)) {
    assert.equal(n, 1, `${cls} 类缺恢复方式的条目重复了 ${n} 次`);
  }
});

test('DSV-C15 镜像名对不上时，靠容器名去掉随机后缀命中配方', () => {
  // 1Panel 给容器名加 4 位随机后缀（`attendance-Ab3x`），而配方键是人写的 `attendance`。
  // 镜像名（`python:3.14.0` → `python`）跟配方无关，所以只有「去后缀」这条回退能命中。
  // M22 变异存活说明 DSV-C13 没锁住这条路径（那里镜像名恰好也能对上），补这一条补上。
  const c = {
    name: 'attendance-Ab3x',
    image: 'python:3.14.0',
    status: 'running',
    mounts: [{ source: '/root/attendance-system', destination: '/app' }],
    envKeys: [],
    workDir: '/app',
  };
  const out = buildServices({
    instance,
    units: [],
    ports: [],
    containers: [c],
    modules: [],
    config: { envKeys: [], urls: [] },
    extraPaths: [],
    recipes: {
      attendance: {
        config: [{ path: '/root/attendance-system/requirements.txt', note: 't' }],
        data: [{ path: '/root/attendance-system/attendance.db', note: 't', recovery: 'r' }],
        recovery: [{ target: '/root/attendance-system', action: 'a' }],
      },
    },
  });
  const svc = out.find((s) => s.service === 'attendance-Ab3x');
  const config = (svc.assets.config ?? []).map((x) => x.path).join(',');
  assert.match(config, /requirements\.txt/, `去后缀回退没生效，config=${config}`);
});

test('DSV-C8 独立系统即使六类资产不全也必须出现（缺类写未发现，不整条丢弃）', () => {
  const bare = {
    name: 'lonely',
    image: 'alpine:3.20',
    status: 'running',
    mounts: [],
    envKeys: [],
    workDir: '',
  };
  const services = make([bare]);
  const graph = buildDependencyGraph({ services });
  const lonely = graph.services.find((s) => s.service === 'lonely');
  assert.ok(lonely, '六类全空的容器被整条丢弃了');
  assert.equal(lonely.link, 'unknown');
  assert.ok((lonely.missing ?? []).length > 0);
  assert.ok((lonely.assets.recovery ?? []).length > 0, 'recovery 必填：没有也要写未知');
});


