import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExistenceProbeScript,
  parseExistenceProbe,
} from '../lib/discovery/probe.js';
import {
  L2_SCOPE,
  buildCoverageContext,
  collectCandidates,
  tierCandidates,
  buildReport,
} from '../lib/discovery/scan.js';

// ---------- 存在性探针（AC：不存在或不可读的路径不能进建议） ----------

test('DSC-P1 探针脚本只读，禁 | head，走 stdin 读路径', () => {
  const s = buildExistenceProbeScript();
  assert.match(s, /read -r/);
  assert.match(s, /PROBE_RC=/);
  assert.doesNotMatch(s, /\| head/);
  assert.doesNotMatch(s, /rm -rf|mkfs|tee |sed -i/);
});

test('DSC-P2 解析存在性：存在/大小/可读', () => {
  const out = [
    'P\t1\t4096\t1\t/opt/web_cs',
    'P\t0\t-1\t0\t/opt/gone',
    'P\t1\t0\t0\t/root/locked',
    'PROBE_RC=0',
  ].join('\n');
  const r = parseExistenceProbe(out);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 3);
  // 4 列是旧格式：没有「是目录」这一位，isDir 必须是 null（未知），
  // 不能猜成 true/false——猜错要么误杀单文件候选，要么把单文件建议进配置。
  assert.deepEqual(r.entries[0], { path: '/opt/web_cs', exists: true, bytes: 4096, readable: true, isDir: null });
  assert.equal(r.entries[1].exists, false);
  assert.equal(r.entries[2].readable, false);
});

test('DSC-P2b 解析存在性：5 列格式带「是目录」位', () => {
  const out = [
    'P\t1\t4096\t1\t1\t/opt/web_cs',
    'P\t1\t223\t1\t0\t/root/.hermes/secrets/deepseek.env',
    'PROBE_RC=0',
  ].join('\n');
  const r = parseExistenceProbe(out);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].isDir, true);
  assert.equal(r.entries[1].isDir, false);
  assert.equal(r.entries[1].path, '/root/.hermes/secrets/deepseek.env');
});

test('DSC-P3 缺 PROBE_RC 视为失败，不能返回空结果冒充成功', () => {
  const r = parseExistenceProbe('P\t1\t10\t1\t/opt/a\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /PROBE_RC/);
});

// ---------- L2 覆盖线 ----------

test('DSC-L1 L2 覆盖线覆盖 /root/scripts 与 11 个单文件中的代表', () => {
  const paths = L2_SCOPE.map((i) => i.path);
  assert.ok(paths.includes('/root/scripts'));
  assert.ok(paths.includes('/etc/systemd/system/webchat.service'));
  assert.ok(paths.includes('/root/.hermes/cron/jobs.json'));
  assert.ok(paths.includes('/root/.hermes/secrets/kb_mail.env'));
  // 三个 scripts 目录必须在 /root/scripts 这条前缀之下
  assert.equal(L2_SCOPE.find((i) => i.path === '/root/scripts').kind, 'prefix');
});

// ---------- 候选收集 ----------

test('DSC-C1 容器挂载 Source 是最硬的路径证据（L3-runtime）', () => {
  const c = collectCandidates({
    runtime: {
      containers: [
        {
          name: 'odoo',
          mounts: [{ source: '/opt/1panel/apps/odoo/odoo19/data/data', destination: '/var/lib/odoo' }],
          envKeys: ['HOST'],
          workDir: '/usr/lib/python3/dist-packages/odoo',
        },
      ],
    },
  });
  const hit = c.find((i) => i.path === '/opt/1panel/apps/odoo/odoo19/data/data');
  assert.ok(hit, '挂载源必须成为候选');
  assert.ok(hit.sources.includes('L3-runtime'));
});

test('DSC-C2 容器内 WorkingDir 不是宿主机路径，不得成为候选', () => {
  const c = collectCandidates({
    runtime: {
      containers: [
        {
          name: 'odoo',
          mounts: [],
          envKeys: [],
          workDir: '/usr/lib/python3/dist-packages/odoo',
        },
      ],
    },
  });
  assert.equal(c.filter((i) => i.path === '/usr/lib/python3/dist-packages/odoo').length, 0);
});

test('DSC-C3 systemd 的 WorkingDirectory 与 EnvironmentFile 进入候选（L4）', () => {
  const c = collectCandidates({
    systemd: {
      units: [
        {
          name: 'webchat.service',
          workingDirectory: '/opt/web_cs',
          environmentFile: '/root/.hermes/profiles/cs-main/.env',
          execStart: '/opt/web_cs/venv/bin/python3 /opt/web_cs/server.py',
        },
      ],
    },
  });
  const paths = c.map((i) => i.path);
  assert.ok(paths.includes('/opt/web_cs'));
  // EnvironmentFile 是文件级证据：取它的父目录作为候选目录
  assert.ok(paths.includes('/root/.hermes/profiles/cs-main'));
  // ExecStart 的解释器路径不进候选（那是可执行文件不是数据目录）
  assert.equal(paths.includes('/opt/web_cs/venv/bin/python3'), false);
});

test('DSC-C4 静态配置扫描只产生低置信线索，来源标 L2-config', () => {
  const c = collectCandidates({
    config: { pathLiterals: [{ file: '/opt/web_cs/server.py', value: '/srv/kb_data' }] },
  });
  const hit = c.find((i) => i.path === '/srv/kb_data');
  assert.ok(hit);
  assert.deepEqual(hit.sources, ['L2-config']);
  assert.equal(hit.confidence, 'low');
});

test('DSC-C5 过宽路径与系统目录被策略排除，不混进普通候选', () => {
  const c = collectCandidates({
    runtime: {
      containers: [
        {
          name: 'x',
          mounts: [
            { source: '/', destination: '/host' },
            { source: '/proc', destination: '/p' },
            { source: '/var/lib/docker', destination: '/d' },
            { source: '/opt/good', destination: '/g' },
          ],
          envKeys: [],
          workDir: '',
        },
      ],
    },
  });
  const paths = c.map((i) => i.path);
  assert.ok(paths.includes('/opt/good'));
  assert.equal(paths.includes('/'), false);
  assert.equal(paths.includes('/proc'), false);
  assert.equal(paths.includes('/var/lib/docker'), false);
});

test('DSC-C6 祖先吞并：/opt/web_cs 与 /opt/web_cs/scripts 只留祖先', () => {
  const c = collectCandidates({
    runtime: {
      containers: [
        {
          name: 'x',
          mounts: [
            { source: '/opt/web_cs', destination: '/a' },
            { source: '/opt/web_cs/scripts', destination: '/b' },
          ],
          envKeys: [],
          workDir: '',
        },
      ],
    },
  });
  const paths = c.map((i) => i.path);
  assert.ok(paths.includes('/opt/web_cs'));
  assert.equal(paths.includes('/opt/web_cs/scripts'), false);
});

// ---------- 四档分类 ----------

const CTX = buildCoverageContext({
  instance: {
    addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons',
    dataPath: '/opt/1panel/apps/odoo/odoo19/data/data',
    pydepsPath: '/opt/1panel/apps/odoo/odoo19/data/data/.local',
    confPath: '/etc/odoo/odoo.conf',
  },
  extraPaths: [
    { name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'] },
    { name: 'web-cs', path: '/opt/web_cs', exclude: ['./venv'] },
    { name: 'hermes-profile', path: '/root/.hermes/profiles/cs-main', exclude: ['./.env'] },
  ],
});

test('DSC-T1 已覆盖的进 covered，且带 coverage 五态值', () => {
  const r = tierCandidates({
    candidates: [
      { path: '/opt/1panel/apps/odoo/odoo19/data/addons', sources: ['L3-runtime'] },
      { path: '/opt/web_cs', sources: ['L4-systemd'] },
      { path: '/root/scripts/toogel', sources: ['L2-config'] },
    ],
    context: CTX,
    probe: { ok: true, entries: [] },
    maxExtras: 8,
    configuredCount: 3,
  });
  assert.equal(r.covered.length, 3);
  assert.deepEqual(
    r.covered.map((i) => i.coverage).sort(),
    ['extraPaths', 'l2', 'main'],
  );
  assert.equal(r.suggest.length, 0);
});

test('DSC-T2 未覆盖且存在可读 → suggest；被 extraPaths 排除的子目录 → coverage=none 且归入待确认（主动排除，不静默消失）', () => {
  const r = tierCandidates({
    candidates: [
      { path: '/opt/kb_data', sources: ['L3-runtime'] },
      { path: '/opt/web_cs/venv', sources: ['L3-runtime'] },
    ],
    context: CTX,
    probe: {
      ok: true,
      entries: [
        { path: '/opt/kb_data', exists: true, bytes: 1024, readable: true },
        { path: '/opt/web_cs/venv', exists: true, bytes: 2048, readable: true },
      ],
    },
    maxExtras: 8,
    configuredCount: 3,
  });
  assert.equal(r.suggest.length, 1);
  assert.equal(r.suggest[0].path, '/opt/kb_data');
  // web_cs/venv 在 extraPaths 之下但命中 exclude → 未覆盖。
  // 它同时被判为 REBUILDABLE_DEPENDENCY，所以落在 inventory（第五档）而不是 confirm：
  // 排除规则与职责判定一致，没有需要人决定的事。但「不能静默消失」这条必须继续守住，
  // 所以这里把 inventory 也纳入查找范围。
  const venv = [...r.suggest, ...r.confirm, ...r.overflow, ...r.inventory].find(
    (i) => i.path === '/opt/web_cs/venv',
  );
  assert.ok(venv, '被排除的子目录必须仍然出现在报告里，不能静默消失');
  assert.equal(venv.coverage, 'none');
  assert.equal(venv.disposition, 'REBUILDABLE_DEPENDENCY');
  assert.match(venv.reasons.join(' '), /与职责判定一致/);
});

test('DSC-T3 AC-10 只有静态扫描证据的路径绝不出现在 suggest', () => {
  const r = tierCandidates({
    candidates: [{ path: '/srv/kb_data', sources: ['L2-config'], confidence: 'low' }],
    context: CTX,
    probe: { ok: true, entries: [{ path: '/srv/kb_data', exists: true, bytes: 10, readable: true }] },
    maxExtras: 8,
    configuredCount: 3,
  });
  assert.equal(r.suggest.length, 0);
  assert.equal(r.confirm.length, 1);
  assert.match(r.confirm[0].reasons.join(' '), /静态扫描/);
});

test('DSC-T4 不存在或不可读 → confirm，绝不进 suggest', () => {
  const r = tierCandidates({
    candidates: [
      { path: '/opt/gone', sources: ['L3-runtime'] },
      { path: '/root/locked', sources: ['L3-runtime'] },
    ],
    context: CTX,
    probe: {
      ok: true,
      entries: [
        { path: '/opt/gone', exists: false, bytes: -1, readable: false },
        { path: '/root/locked', exists: true, bytes: 0, readable: false },
      ],
    },
    maxExtras: 8,
    configuredCount: 3,
  });
  assert.equal(r.suggest.length, 0);
  assert.equal(r.confirm.length, 2);

  // 必须**分别**命中「不存在」与「不可读」两条分支，理由要能区分开。
  // 只断言「都进了 confirm」不够：把 `!entry.exists` 那条判定删掉，/opt/gone 会
  // 顺着落到 `!entry.readable` 上，confirm 数量不变、测试照样绿——但用户看到的
  // 理由从「路径不存在」变成「路径不可读」，排查方向完全不同。
  const gone = r.confirm.find((i) => i.path === '/opt/gone');
  const locked = r.confirm.find((i) => i.path === '/root/locked');
  assert.match(gone.reasons.join(' '), /路径不存在/);
  assert.doesNotMatch(gone.reasons.join(' '), /不可读/);
  assert.match(locked.reasons.join(' '), /不可读/);
  assert.doesNotMatch(locked.reasons.join(' '), /不存在/);
});

test('DSC-T5 AC-5 超出 MAX_EXTRAS 的完整保留在 overflow，不静默截断', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ path: `/opt/extra${i}`, sources: ['L3-runtime'] }));
  const r = tierCandidates({
    candidates: many,
    context: CTX,
    probe: {
      ok: true,
      entries: many.map((m) => ({ path: m.path, exists: true, bytes: 100, readable: true })),
    },
    maxExtras: 5,
    configuredCount: 3,
  });
  assert.equal(r.suggest.length, 2, '剩余容量 = 5 - 3 = 2');
  assert.equal(r.overflow.length, 4);
  assert.equal(r.counts.suggest + r.counts.covered + r.counts.confirm + r.counts.overflow, 6);
});

test('DSC-T6 AC-4 四档计数之和 == 候选总数，且五态计数之和同样 == 总数', () => {
  const r = tierCandidates({
    candidates: [
      { path: '/opt/1panel/apps/odoo/odoo19/data/addons', sources: ['L3-runtime'] },
      { path: '/opt/web_cs', sources: ['L4-systemd'] },
      { path: '/root/scripts', sources: ['L2-config'] },
      { path: '/opt/kb_data', sources: ['L3-runtime'] },
      { path: '/opt/gone', sources: ['L3-runtime'] },
      { path: '/srv/hint', sources: ['L2-config'], confidence: 'low' },
    ],
    context: CTX,
    probe: {
      ok: true,
      entries: [
        { path: '/opt/kb_data', exists: true, bytes: 1, readable: true },
        { path: '/opt/gone', exists: false, bytes: -1, readable: false },
        { path: '/srv/hint', exists: true, bytes: 1, readable: true },
      ],
    },
    maxExtras: 8,
    configuredCount: 3,
  });
  const tierSum = r.counts.suggest + r.counts.covered + r.counts.confirm + r.counts.overflow;
  assert.equal(tierSum, 6, '四档之和必须等于发现总数');
  const covSum =
    r.coverageCounts.main + r.coverageCounts.extraPaths + r.coverageCounts.l2 + r.coverageCounts.none;
  assert.equal(covSum, 6, '五态互斥部分之和也必须等于总数');
});

test('DSC-T7 探针整体失败时，未覆盖候选全部降级到 confirm（不能猜成 suggest）', () => {
  const r = tierCandidates({
    candidates: [{ path: '/opt/kb_data', sources: ['L3-runtime'] }],
    context: CTX,
    probe: { ok: false, reason: '远端不可达' },
    maxExtras: 8,
    configuredCount: 3,
  });
  assert.equal(r.suggest.length, 0);
  assert.equal(r.confirm.length, 1);
  assert.match(r.confirm[0].reasons.join(' '), /无法验证/);
});

// ---------- 报告 ----------

test('DSC-R1 报告头必须同时给四档计数与五态分布', () => {
  const tier = tierCandidates({
    candidates: [{ path: '/opt/kb_data', sources: ['L3-runtime'] }],
    context: CTX,
    probe: { ok: true, entries: [{ path: '/opt/kb_data', exists: true, bytes: 1, readable: true }] },
    maxExtras: 8,
    configuredCount: 3,
  });
  const text = buildReport({ server: 'toogel', tier, graph: { services: [], byModule: {} } });
  assert.match(text, /建议新增[：:]\s*1/);
  assert.match(text, /已覆盖[：:]\s*0/);
  assert.match(text, /待确认[：:]\s*0/);
  assert.match(text, /超出容量[：:]\s*0/);
  assert.match(text, /main \d+ \/ extraPaths \d+ \/ l2 \d+ \/ none \d+/);
  assert.match(text, /toogel/);
});

test('DSC-R2 报告缺类必须写「未发现」，不能省略行', () => {
  const tier = tierCandidates({
    candidates: [],
    context: CTX,
    probe: { ok: true, entries: [] },
    maxExtras: 8,
    configuredCount: 3,
  });
  const graph = {
    services: [
      {
        service: 'web_cs',
        modules: ['chatbot_ai_hermes'],
        link: 'inferred',
        assets: {
          config: [{ path: '/etc/systemd/system/webchat.service' }],
          data: [],
          files: [],
          db: [],
          api: [],
          recovery: [{ target: 'webchat', action: '重装 venv' }],
        },
        missing: ['data', 'files', 'db', 'api'],
      },
    ],
    byModule: { chatbot_ai_hermes: ['web_cs'] },
  };
  const text = buildReport({ server: 'toogel', tier, graph });
  assert.match(text, /config/);
  assert.match(text, /data[^\n]*未发现/);
  assert.match(text, /inferred/);
});

test('DSC-R3 报告不含任何密钥值形状', () => {
  const tier = tierCandidates({
    candidates: [],
    context: CTX,
    probe: { ok: true, entries: [] },
    maxExtras: 8,
    configuredCount: 3,
  });
  const text = buildReport({
    server: 'toogel',
    tier,
    graph: {
      services: [
        {
          service: 'web_cs',
          modules: ['chatbot_ai_hermes'],
          link: 'explicit',
          assets: {
            config: [],
            data: [],
            files: [],
            db: [],
            api: [{ key: 'DEEPSEEK_API_KEY', shape: '***' }],
            recovery: [],
          },
          missing: ['config', 'data', 'files', 'db', 'recovery'],
        },
      ],
    },
  });
  assert.match(text, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{10,}/);
});
