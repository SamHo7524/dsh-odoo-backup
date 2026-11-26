import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';

const ZERO_KEYS = [
  'credentials', 'guardHostKey', 'discover', 'execRemote',
  'scpUpload', 'scpDownload', 'stat', 'detectFormat', 'readPackageMeta',
];

/** 每个依赖都被计数；任何非零即证明闸门没站在最前面。 */
function makeCounters() {
  const n = Object.fromEntries(ZERO_KEYS.map((k) => [k, 0]));
  const deps = {
    credentials: {
      resolve: async () => {
        n.credentials += 1;
        return { value: 'passphrase-20-chars!!' };
      },
    },
    guardHostKey: async () => {
      n.guardHostKey += 1;
      return { ok: true };
    },
    discover: async () => {
      n.discover += 1;
      return {
        instances: [{
          dbName: 'toogel',
          odooContainer: 'oc',
          pgContainer: 'pc',
          pgSuperUser: 'pgsql',
          dataPath: '/d',
          addonsPath: '/a',
          odooVersion: '19.0-test',
        }],
      };
    },
    execRemote: async () => {
      n.execRemote += 1;
      return { stdout: '', stderr: '', code: 0 };
    },
    scpUpload: async () => { n.scpUpload += 1; },
    scpDownload: async () => { n.scpDownload += 1; },
    stat: async () => {
      n.stat += 1;
      return { size: 10 };
    },
    detectFormat: async () => {
      n.detectFormat += 1;
      return 'encrypted';
    },
    readPackageMeta: async () => {
      n.readPackageMeta += 1;
      return { ok: true, sourceDbName: 'tg-odoo' };
    },
    runBackup: async () => { throw new Error('不该跑到 runBackup'); },
    runRestore: async () => { throw new Error('不该跑到 runRestore'); },
  };
  return { n, deps };
}

function makeService(servers) {
  const { n, deps } = makeCounters();
  const svc = createService({ config: { servers }, deps });
  return { svc, n };
}

const PROD = { name: 'toogel', host: '47.121.205.143', user: 'root', role: 'backup' };
const DRILL = { name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' };

function assertAllZero(n, label) {
  for (const k of ZERO_KEYS) {
    assert.equal(n[k], 0, `${label}：${k} 调用次数必须为 0，实际 ${n[k]}`);
  }
}

const PKG = 'K:\\Backup\\odoo\\x.tar.enc';

test('GATE-1 对备份源执行 restore → 拒绝且九类依赖调用为 0', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(
    () => svc.restore('toogel', undefined, PKG, {}),
    (e) => /toogel/.test(e.message) && /用途/.test(e.message),
  );
  assertAllZero(n, 'restore');
});

test('GATE-2 对备份源执行 inspectRestore → 拒绝且零调用', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.inspectRestore('toogel', PKG), /用途/);
  assertAllZero(n, 'inspectRestore');
});

test('GATE-3 对备份源执行 neutralizeStatus → 拒绝且零调用', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.neutralizeStatus('toogel'), /用途/);
  assertAllZero(n, 'neutralizeStatus');
});

test('GATE-4 对备份源执行 applyNeutralize(release) → 拒绝且零调用', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.applyNeutralize('toogel', 'release'), /用途/);
  assertAllZero(n, 'applyNeutralize/release');
});

test('GATE-5 applyNeutralize(keep) 同样被拒（不留「keep 成功 / release 被拒」割裂）', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.applyNeutralize('toogel', 'keep'), /用途/);
  assertAllZero(n, 'applyNeutralize/keep');
});

test('GATE-6 keep 对不存在的服务器名也抛错（行为收紧）', async () => {
  const { svc } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.applyNeutralize('no-such-server', 'keep'), /未找到服务器/);
});

test('GATE-7 对恢复目标执行 backup → 拒绝且九类依赖调用为 0', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.backup('odoo.toogel.cn'), /用途/);
  assertAllZero(n, 'backup');
});

test('GATE-8 对备份源执行 backup 不被用途闸门拦住（生产备份不受影响）', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  let err = null;
  try {
    await svc.backup('toogel');
  } catch (e) {
    err = e;
  }
  assert.equal(n.credentials, 1, '合法用途下口令校验应当发生');
  assert.equal(n.guardHostKey, 1, '合法用途下指纹闸门应当发生');
  assert.ok(!err || !/用途/.test(err.message), '合法用途不该被用途闸门拦住');
});

test('GATE-9 老配置（无 role）按备份源处理：restore 被拒', async () => {
  const legacy = { name: 'legacy', host: 'h', user: 'root' };
  const { svc } = makeService([legacy]);
  await assert.rejects(() => svc.restore('legacy', undefined, PKG, {}), /用途/);
});
