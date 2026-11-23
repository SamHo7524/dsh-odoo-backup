import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePath,
  isUnder,
  relativeTo,
  matchesExclude,
  isAncestorOf,
  foldPaths,
  pathKind,
} from '../lib/discovery/paths.js';

// ---------------- DP-N：normalizePath ----------------

test('DP-N1 去掉尾部斜杠、折叠重复斜杠', () => {
  assert.equal(normalizePath('/opt/web_cs/'), '/opt/web_cs');
  assert.equal(normalizePath('//opt///web_cs//'), '/opt/web_cs');
  assert.equal(normalizePath('/opt/web_cs'), '/opt/web_cs');
});

test('DP-N2 根路径保持为 /', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('///'), '/');
});

test('DP-N3 非字符串返回空串（不抛）', () => {
  assert.equal(normalizePath(null), '');
  assert.equal(normalizePath(undefined), '');
  assert.equal(normalizePath(42), '');
});

// ---------------- DP-U：isUnder ----------------

test('DP-U1 相等算覆盖', () => {
  assert.equal(isUnder('/opt/web_cs', '/opt/web_cs'), true);
});

test('DP-U2 子树算覆盖', () => {
  assert.equal(isUnder('/opt/web_cs/scripts', '/opt/web_cs'), true);
  assert.equal(isUnder('/opt/web_cs/a/b/c', '/opt/web_cs'), true);
});

test('DP-U3 前缀相同但不是子树，不算覆盖（关键）', () => {
  // 朴素的 startsWith 会把 web_cs2 误判成 web_cs 的子树
  assert.equal(isUnder('/opt/web_cs2', '/opt/web_cs'), false);
  assert.equal(isUnder('/opt/web_cs.bak', '/opt/web_cs'), false);
});

test('DP-U4 父不是子的子树', () => {
  assert.equal(isUnder('/opt', '/opt/web_cs'), false);
});

// ---------------- DP-R：relativeTo ----------------

test('DP-R1 返回相对路径', () => {
  assert.equal(relativeTo('/opt/web_cs/scripts', '/opt/web_cs'), 'scripts');
  assert.equal(relativeTo('/opt/web_cs/a/b', '/opt/web_cs'), 'a/b');
});

test('DP-R2 自身返回空串', () => {
  assert.equal(relativeTo('/opt/web_cs', '/opt/web_cs'), '');
});

test('DP-R3 不在其下返回 null', () => {
  assert.equal(relativeTo('/opt/other', '/opt/web_cs'), null);
});

// ---------------- DP-E：matchesExclude（tar 语义）----------------

test('DP-E1 ./ 前缀是顶层锚定精确排除', () => {
  assert.equal(matchesExclude('./.git', './.git'), true);
  assert.equal(matchesExclude('./.git/config', './.git'), true);
  // 顶层锚定不匹配深层同名目录之外的路径
  assert.equal(matchesExclude('./sub/.git', './.git'), false);
});

test('DP-E2 裸名按任意路径分量匹配', () => {
  assert.equal(matchesExclude('./cache', 'cache'), true);
  assert.equal(matchesExclude('./a/b/cache', 'cache'), true);
  assert.equal(matchesExclude('./a/b/cache/x.tmp', 'cache'), true);
  // 不能因为包含 cache 子串就命中
  assert.equal(matchesExclude('./cache2', 'cache'), false);
  assert.equal(matchesExclude('./mycache', 'cache'), false);
});

test('DP-E3 *.lock 裸名匹配任意层级的 lock 文件', () => {
  assert.equal(matchesExclude('./state.db.lock', '*.lock'), true);
  assert.equal(matchesExclude('./sub/gateway.lock', '*.lock'), true);
  assert.equal(matchesExclude('./sub/gateway.lock.bak', '*.lock'), false);
});

test('DP-E4 含斜杠的模式按相对路径锚定', () => {
  assert.equal(matchesExclude('./scripts/__pycache__', './scripts/__pycache__'), true);
  assert.equal(matchesExclude('./scripts/__pycache__/x.pyc', './scripts/__pycache__'), true);
  assert.equal(matchesExclude('./other/scripts/__pycache__', './scripts/__pycache__'), false);
});

test('DP-E5 排除列表为空时永不命中', () => {
  assert.equal(matchesExclude('./anything', []), false);
  assert.equal(matchesExclude('./anything', undefined), false);
});

test('DP-E6 多条排除任意一条命中即排除', () => {
  const ex = ['./.git', 'cache', '*.lock'];
  assert.equal(matchesExclude('./.git/config', ex), true);
  assert.equal(matchesExclude('./deep/cache/f', ex), true);
  assert.equal(matchesExclude('./x.lock', ex), true);
  assert.equal(matchesExclude('./normal/file.txt', ex), false);
});

test('DP-E7 路径本身的中间段被排掉 = 该路径也被排掉', () => {
  // /opt/web_cs/venv/lib 位于 venv 之下 → 被 ./venv 排除
  assert.equal(matchesExclude('./venv/lib/python3', './venv'), true);
});

// ---------------- DP-A：isAncestorOf（父子折叠用）----------------

test('DP-A1 真祖先返回 true', () => {
  assert.equal(isAncestorOf('/opt', '/opt/web_cs'), true);
});

test('DP-A2 自身不是自己的严格祖先', () => {
  assert.equal(isAncestorOf('/opt/web_cs', '/opt/web_cs'), false);
});

// ---------------- DP-F：foldPaths（父子折叠）----------------

test('DP-F1 父路径吞掉子路径，并记录包含数', () => {
  const out = foldPaths([
    { path: '/root/.hermes' },
    { path: '/root/.hermes/profiles/cs-main' },
    { path: '/root/.hermes/cron' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, '/root/.hermes');
  assert.equal(out[0].absorbed, 2);
});

test('DP-F2 互不包含时全部保留', () => {
  const out = foldPaths([
    { path: '/opt/web_cs' },
    { path: '/root/.hermes' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].absorbed, 0);
});

test('DP-F3 折叠后保留原对象其余字段', () => {
  const out = foldPaths([{ path: '/a', service: 'x' }, { path: '/a/b', service: 'y' }]);
  assert.equal(out[0].service, 'x');
});

test('DP-F4 顺序无关（子在前也能被后来的父吞掉）', () => {
  const out = foldPaths([{ path: '/a/b' }, { path: '/a' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, '/a');
});

// ---------------- DP-K：pathKind ----------------

test('DP-K1 过宽路径被标记', () => {
  assert.equal(pathKind('/'), 'too-broad');
  assert.equal(pathKind('/root'), 'too-broad');
  assert.equal(pathKind('/usr'), 'too-broad');
  assert.equal(pathKind('/var'), 'too-broad');
  assert.equal(pathKind('/var/lib/docker'), 'too-broad');
});

test('DP-K2 正常业务路径返回 ok', () => {
  assert.equal(pathKind('/opt/web_cs'), 'ok');
  assert.equal(pathKind('/root/.hermes'), 'ok');
  assert.equal(pathKind('/etc/systemd/system'), 'ok');
});
