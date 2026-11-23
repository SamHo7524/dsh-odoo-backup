import test from 'node:test';
import assert from 'node:assert/strict';

import { scanExternalDeps } from '../lib/discovery/index.js';

/** 按脚本指纹分发假远端输出。 */
function makeFakeExec(overrides = {}) {
  const calls = [];
  const fake = async (server, script, opts = {}) => {
    calls.push({ script, stdin: opts.stdin ?? '' });

    if (script.includes('PROBE_RC=')) {
      if (overrides.probe) return { code: 0, stdout: overrides.probe, stderr: '' };
      const paths = String(opts.stdin ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const lines = paths.map((p) =>
        // 默认：除 /opt/gone 外都存在且可读
        p === '/opt/gone' ? `P\t0\t-1\t0\t${p}` : `P\t1\t1024\t1\t${p}`,
      );
      return { code: 0, stdout: `${lines.join('\n')}\nPROBE_RC=0\n`, stderr: '' };
    }

    if (script.includes('===RUNTIME_RC=0===')) {
      if (overrides.runtime) return { code: 0, stdout: overrides.runtime, stderr: '' };
      return { code: 0, stdout: '===DOCKER===\n===MOUNTS===\n===ENVKEYS===\n===WORKDIR===\n===PORTS===\n===PROCS===\n===RUNTIME_RC=0===\n', stderr: '' };
    }

    if (script.includes('===SYSTEMD_RC=0===')) {
      if (overrides.systemd) return { code: 0, stdout: overrides.systemd, stderr: '' };
      return { code: 0, stdout: '===UNITS===\n===CAT===\n===ENABLED===\n===SYSTEMD_RC=0===\n', stderr: '' };
    }

    if (script.includes('===ODOO_RC=0===')) {
      if (overrides.odoo) return { code: 0, stdout: overrides.odoo, stderr: '' };
      return { code: 0, stdout: '===MODULES===\n===CONFPARAMS===\n===ODOO_RC=0===\n', stderr: '' };
    }

    if (script.includes('===CONFIG_RC=0===')) {
      if (overrides.config) return { code: 0, stdout: overrides.config, stderr: '' };
      return { code: 0, stdout: '===ENVKEYS===\n===PATHLIT===\n===URL===\n===CONFIG_RC=0===\n', stderr: '' };
    }

    return { code: 0, stdout: '', stderr: '' };
  };
  fake.calls = calls;
  return fake;
}

const INSTANCE = {
  odooContainer: '1Panel-odoo-kwnb',
  odooVersion: '19.0-20260619',
  dbName: 'tg-odoo',
  pgContainer: '1Panel-postgresql-3eaO',
  pgSuperUser: 'toogel',
  addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons',
  dataPath: '/opt/1panel/apps/odoo/odoo19/data/data',
  pydepsPath: '/opt/1panel/apps/odoo/odoo19/data/data/.local',
  confPath: '/etc/odoo/odoo.conf',
};

const SERVER = { name: 'toogel', host: '47.121.205.143' };

function fakeDiscover(instances = [INSTANCE]) {
  return async () => ({ server: 'toogel', instances, found: instances.length > 0 });
}

test('DSE-1 全链路：四层都成功，返回四档清单与报告文本', async () => {
  const exec = makeFakeExec({
    runtime: [
      '===DOCKER===',
      'odoo|odoo:19.0|Up 3 days',
      '===MOUNTS===',
      'odoo\t/opt/1panel/apps/odoo/odoo19/data/data=>/var/lib/odoo',
      '===ENVKEYS===',
      'odoo\tHOST',
      '===WORKDIR===',
      '===PORTS===',
      '127.0.0.1:8766\twebchat',
      '===PROCS===',
      'root 123 /usr/bin/python3 /opt/web_cs/server.py',
      '===RUNTIME_RC=0===',
    ].join('\n'),
    systemd: [
      '===UNITS===',
      'webchat.service loaded active running WebChat CS',
      '===CAT===',
      '###UNIT:webchat.service',
      'WorkingDirectory=/opt/web_cs',
      'EnvironmentFile=/root/.hermes/profiles/cs-main/.env',
      'ExecStart=/opt/web_cs/venv/bin/python3 /opt/web_cs/server.py',
      '===ENABLED===',
      'webchat.service\tenabled',
      '===SYSTEMD_RC=0===',
    ].join('\n'),
    odoo: [
      '===MODULES===',
      'chatbot_ai_hermes|19.0.1.1.1|installed',
      'base|19.0.1.3|installed',
      '===CONFPARAMS===',
      'web.base.url|https://www.toogel.cn/page/1?token=abc',
      '===ODOO_RC=0===',
    ].join('\n'),
    config: [
      '===ENVKEYS===',
      '/root/.hermes/profiles/cs-main/.env\tDEEPSEEK_API_KEY',
      '===PATHLIT===',
      '/opt/web_cs/server.py\t/srv/kb_hint',
      '===URL===',
      '/opt/web_cs/server.py\thttps://www.toogel.cn/webchat/api/chat',
      '===CONFIG_RC=0===',
    ].join('\n'),
  });

  const r = await scanExternalDeps({
    server: SERVER,
    extraPaths: [
      { name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'] },
      { name: 'web-cs', path: '/opt/web_cs', exclude: ['./venv'] },
    ],
    maxExtras: 8,
    exec,
    discoverInstance: fakeDiscover(),
  });

  assert.equal(r.ok, true);
  assert.equal(r.readOnly, true);

  // 四档之和 == 发现总数
  const sum = r.counts.suggest + r.counts.covered + r.counts.confirm + r.counts.overflow;
  assert.equal(sum, r.covered.length + r.suggest.length + r.confirm.length + r.overflow.length);

  // dataPath 被主备份覆盖
  const coveredPaths = r.covered.map((c) => c.path);
  assert.ok(coveredPaths.includes('/opt/1panel/apps/odoo/odoo19/data/data'));
  // /opt/web_cs 被 extraPaths 覆盖
  const webcs = r.covered.find((c) => c.path === '/opt/web_cs');
  assert.equal(webcs.coverage, 'extraPaths');
  // /root/.hermes/profiles/cs-main 不在任何覆盖线里（本次只配了 vault 与 web-cs 两条）
  // → 必须出现在四档之一，且 coverage 诚实标 none。这正是「不能因为配了
  // hermes-home 就以为 cs-main 一定被覆盖」的机械保证。
  const csMain = [...r.covered, ...r.suggest, ...r.confirm, ...r.overflow].find(
    (c) => c.path === '/root/.hermes/profiles/cs-main',
  );
  assert.ok(csMain, 'EnvironmentFile 父目录必须出现在报告里');
  assert.equal(csMain.coverage, 'none', '没配 hermes-profile/hermes-home 时它就是未覆盖');

  // 静态扫描线索不得进 suggest
  const hint = r.suggest.find((c) => c.path === '/srv/kb_hint');
  assert.equal(hint, undefined);
  const hint2 = [...r.confirm, ...r.overflow, ...r.covered].find((c) => c.path === '/srv/kb_hint');
  assert.ok(hint2, '/srv/kb_hint 必须出现在非 suggest 的某一档');

  assert.equal(r.discoveryWarnings.length, 0);
  assert.match(r.report, /建议新增：/);
  assert.match(r.report, /覆盖分布：main \d+ \/ extraPaths \d+ \/ l2 \d+ \/ none \d+/);
});

test('DSE-2 某层失败不中断整体，失败原因进 warnings', async () => {
  const exec = async (server, script, opts = {}) => {
    if (script.includes('===SYSTEMD_RC=0===')) {
      return { code: 2, stdout: 'boom', stderr: 'systemd not available' };
    }
    if (script.includes('PROBE_RC=')) return { code: 0, stdout: '\nPROBE_RC=0\n', stderr: '' };
    if (script.includes('===RUNTIME_RC=0===')) return { code: 0, stdout: '===RUNTIME_RC=0===\n', stderr: '' };
    if (script.includes('===ODOO_RC=0===')) return { code: 0, stdout: '===ODOO_RC=0===\n', stderr: '' };
    if (script.includes('===CONFIG_RC=0===')) return { code: 0, stdout: '===CONFIG_RC=0===\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  const r = await scanExternalDeps({
    server: SERVER,
    exec,
    discoverInstance: fakeDiscover([]),
  });
  assert.equal(r.ok, true, '一层失败不能让整次扫描失败');
  assert.ok(r.discoveryWarnings.some((w) => /L4-systemd/.test(w)));
  assert.ok(r.discoveryWarnings.some((w) => /未发现 Odoo 实例/.test(w)));
});

test('DSE-3 探针失败时 suggest 必须为空（不能凭猜测建议写配置）', async () => {
  const exec = makeFakeExec({
    // 一个明确未覆盖的挂载源 → 正常情况它会进 suggest；探针失败后必须降级到 confirm
    runtime: [
      '===DOCKER===',
      'odoo|odoo:19.0|Up 3 days',
      '===MOUNTS===',
      'odoo\t/opt/kb_data=>/data',
      '===ENVKEYS===',
      '===WORKDIR===',
      '===PORTS===',
      '===PROCS===',
      '===RUNTIME_RC=0===',
    ].join('\n'),
    probe: 'garbage without marker\n',
  });
  const r = await scanExternalDeps({
    server: SERVER,
    exec,
    discoverInstance: fakeDiscover(),
    extraPaths: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.suggest.length, 0);
  assert.ok(r.discoveryWarnings.some((w) => /存在性探针/.test(w)));
  assert.ok(r.confirm.length > 0);
  const kb = r.confirm.find((c) => c.path === '/opt/kb_data');
  assert.ok(kb, '/opt/kb_data 必须进 confirm');
  // 必须命中「探针整体失败」这条分支，而不是「探针未覆盖该路径」。
  // 两者都写「无法验证」，但前者意味着远端根本没跑完，后者只是没问过——
  // 理由不同会导致用户采取不同行动（重试扫描 vs 无需处理）。
  assert.match(kb.reasons.join(' '), /存在性探针整体失败/);
  assert.doesNotMatch(kb.reasons.join(' '), /探针未覆盖该路径/);
});

test('DSE-4 扫描只读：发给远端的四段脚本都不含写操作', async () => {
  const exec = makeFakeExec();
  await scanExternalDeps({ server: SERVER, exec, discoverInstance: fakeDiscover() });
  for (const c of exec.calls) {
    assert.doesNotMatch(c.script, /rm -rf|mkfs|sed -i|tee |>> {1,2}\//);
  }
});

test('DSE-5 依赖图进了报告，且 Odoo 自身作为服务出现', async () => {
  const exec = makeFakeExec({
    systemd: [
      '===UNITS===',
      'webchat.service loaded active running WebChat CS',
      '===CAT===',
      '###UNIT:webchat.service',
      'WorkingDirectory=/opt/web_cs',
      '===ENABLED===',
      'webchat.service\tenabled',
      '===SYSTEMD_RC=0===',
    ].join('\n'),
  });
  const r = await scanExternalDeps({ server: SERVER, exec, discoverInstance: fakeDiscover() });
  assert.match(r.report, /模块 → 服务 → 六类资产/);
  assert.match(r.report, /Odoo/);
  assert.match(r.report, /webchat/);
});
