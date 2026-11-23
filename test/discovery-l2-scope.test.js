import assert from 'node:assert/strict';
import test from 'node:test';

import { collectCandidates, collectCandidatesDetailed, L2_SCOPE } from '../lib/discovery/scan.js';

// ---------- L2 覆盖线的自证：L2 备了什么，扫描器必须知道 ----------

test('DSC-L2 L2 覆盖范围本身进入候选，证据标 L2-scope', () => {
  const detailed = collectCandidatesDetailed({
    runtime: { containers: [] },
    systemd: { units: [] },
    config: null,
    odoo: null,
  });
  const paths = detailed.candidates.map((c) => c.path);

  // L2 打的是目录级 ops-scripts 包（-C /root scripts），所以 /root/scripts 必须在候选里。
  const scripts = detailed.candidates.find((c) => c.path === '/root/scripts');
  assert.ok(scripts, '/root/scripts 必须进入候选，否则 L2 覆盖在报告里永远是 0');
  assert.ok(scripts.sources.includes('L2-scope'));

  // 三个子目录不单独进候选（它们是 prefix 类覆盖线的下级），
  // 但必须能被覆盖判定算作 l2——覆盖才是目的，进不进候选只是手段。
  assert.equal(paths.includes('/root/scripts/toogel'), false);

  // 单文件类的 L2 目标也要进候选（它们不会被任何祖先吞并）
  assert.ok(paths.includes('/root/.hermes/cron/jobs.json'));
  assert.ok(paths.includes('/etc/systemd/system/webchat.service'));
});

test('DSC-L2b L2-scope 是低置信证据：不能凭它单独产出建议', () => {
  // L2 已经备过的东西，即使没被任何运行时证据提到，也应该是「已覆盖」而不是「建议新增」。
  const detailed = collectCandidatesDetailed({ runtime: { containers: [] } });
  const scripts = detailed.candidates.find((c) => c.path === '/root/scripts');
  assert.equal(scripts.confidence, 'low', 'L2-scope 是已知清单不是活性证据，必须低置信');
});

test('DSC-L2c L2_SCOPE 里每条都真的进得了候选（不能有死条目）', () => {
  const detailed = collectCandidatesDetailed({ runtime: { containers: [] } });
  const paths = new Set(detailed.candidates.map((c) => c.path));
  for (const item of L2_SCOPE) {
    const covered =
      paths.has(item.path) ||
      detailed.candidates.some((c) => c.path === item.path) ||
      // prefix 类被祖先吞并时，父路径在候选里
      detailed.candidates.some((c) => item.path.startsWith(`${c.path}/`));
    assert.ok(covered, `L2_SCOPE 条目 ${item.path} 没有进入候选，那条覆盖线是死的`);
  }
});
