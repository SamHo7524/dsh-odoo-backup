// LOSS-1~LOSS-3：工具返回值必须能无损通过 JSON 往返。
//
// 为什么需要这组测试：
// v0.2.6 首次真机调用 `odoo_backup action=scanExternalDeps` 直接报
//   `Error: tool "odoo_backup" returned invalid output: value is not lossless JSON`
// 根因是 `tierCandidates` 里 `category` 取了 `deriveCategory()` 的返回值，而它在
// 大多数路径上返回 `undefined`。`JSON.stringify` 会把值为 `undefined` 的**自有字段
// 整个丢掉**，于是 DSH 拿到的「结构化值」和「序列化后的值」形状不一致，判为不可无损往返。
//
// 这类缺陷单元测试全绿也抓不到——因为测试只断言字段内容，从没做过一次 JSON 往返。
// 所以这里改成直接断言往返恒等：这是 DSH 实际执行的那一项检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanExternalDeps } from '../lib/discovery/index.js';

/** 造一份最小的四层输出，让扫描能跑完全程（不连远端）。 */
function fakeExec() {
  const script = {
    runtime: `===RUNTIME_RC=0===\n===CONTAINERS===\nc1\todoo:19.0\trunning\n===MOUNTS=c1===\n/opt/web_cs=>/mnt/web_cs\n===ENVKEYS=c1===\n===PORTS===\n===PS===\n`,
    systemd: `===SYSTEMD_RC=0===\n===UNITS===\nwebchat.service\tloaded\tactive\trunning\tWeb chat\n===CAT=webchat.service===\nWorkingDirectory=/opt/web_cs\n===ENABLED=webchat.service===\nenabled\n`,
    odoo: `===ODOO_RC=0===\n===MODULES===\nchatbot_ai_hermes\t19.0.1.1.1\tinstalled\n===PARAMS===\n`,
    probe: `P\t1\t4096\t1\t1\t/opt/web_cs\nP\t1\t1024\t1\t1\t/opt/other\nPROBE_RC=0\n`,
  };
  return async (_server, s) => {
    for (const [name, out] of Object.entries(script)) {
      if (s.includes(`===${name.toUpperCase()}`) || s.includes(name)) return { code: 0, stdout: out, stderr: '' };
    }
    // 兜底：按调用顺序返回
    return { code: 0, stdout: '', stderr: '' };
  };
}

const server = { name: 'toogel', host: 'h', port: 22, user: 'root' };
const extraPaths = [{ name: 'web-cs', path: '/opt/web_cs', exclude: [], maxBytes: null }];

/** 不连远端：注入假的 discoverInstance，否则测试会真的去 SSH。 */
const fakeDiscover = async () => ({
  instances: [{
    odooContainer: 'c1', odooVersion: '19.0', dbName: 'tg-odoo',
    addonsPath: '/opt/odoo/addons', dataPath: '/opt/odoo/data', pydepsPath: '/opt/odoo/pydeps',
    confPath: '/etc/odoo/odoo.conf',
  }],
});

const scan = () => scanExternalDeps({
  server, extraPaths, exec: fakeExec(), discoverInstance: fakeDiscover,
});

test('LOSS-1 扫描结果能无损 JSON 往返（DSH 的 lossless 检查）', async () => {
  const res = await scan();
  const round = JSON.parse(JSON.stringify(res));
  assert.deepEqual(round, res,
    '返回值里存在值为 undefined 的字段：JSON.stringify 会丢弃它，DSH 会报 "value is not lossless JSON"');
});

test('LOSS-2 四档里的每一项都能无损往返（category 等可选字段必须是 null 而非 undefined）', async () => {
  const res = await scan();
  const buckets = [...res.covered, ...res.suggest, ...res.confirm, ...res.overflow];
  assert.ok(buckets.length > 0, '示例数据应至少产出一条');
  for (const item of buckets) {
    const round = JSON.parse(JSON.stringify(item));
    assert.deepEqual(round, item, `path=${item.path} 的条目含 undefined 字段`);
    // 显式钉住 category：缺省必须是 null，用 undefined 会让整个字段消失
    assert.ok('category' in item, `path=${item.path} 缺少 category 字段`);
    assert.notEqual(item.category, undefined, `path=${item.path} 的 category 不能是 undefined`);
  }
});

test('LOSS-3 报告文本与 warnings 不含 undefined，且 warnings 可无损往返', async () => {
  const res = await scan();
  assert.equal(typeof res.report, 'string', 'report 必须是字符串（render 直接输出它）');
  assert.ok(!res.report.includes('undefined'), '报告正文里不应出现 undefined 字样');
  assert.deepEqual(JSON.parse(JSON.stringify(res.discoveryWarnings)), res.discoveryWarnings);
});
