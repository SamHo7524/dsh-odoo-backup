import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeScanScript,
  parseRuntimeScan,
  buildSystemdScanScript,
  parseSystemdScan,
  buildOdooModuleScript,
  parseOdooModules,
  buildConfigScanScript,
  parseConfigScan,
} from '../lib/discovery/collectors.js';

// ---------------- DKS：脚本契约（防「静默写操作」与「管道提前退出」）----------------

test('DKS-1 运行时扫描脚本禁写操作、禁 | head（pipefail 下 SIGPIPE 会提前退出）', () => {
  const s = buildRuntimeScanScript();
  assert.doesNotMatch(s, /\brm\s+-rf\b|\bmkfs\b|>\s*\/etc\/|>\s*\/root\//);
  assert.doesNotMatch(s, /\|\s*head\b/);
  assert.match(s, /set -uo pipefail/);
  // 不用 set -e：要自己判每一段的退出码
  assert.doesNotMatch(s, /set -euo|set -eu\b/);
});

test('DKS-2 运行时脚本采集 docker mounts / 容器 env 键名 / ss / ps', () => {
  const s = buildRuntimeScanScript();
  assert.match(s, /docker ps/);
  assert.match(s, /\.Mounts/);
  assert.match(s, /Config\.Env/);
  assert.match(s, /WorkingDir/);
  assert.match(s, /ss -lntp|ss -lnt/);
  assert.match(s, /ps -eo/);
});

test('DKS-3 systemd 脚本读 list-units + cat + is-enabled', () => {
  const s = buildSystemdScanScript();
  assert.match(s, /systemctl list-units/);
  assert.match(s, /systemctl cat/);
  assert.match(s, /is-enabled/);
  assert.match(s, /WorkingDirectory/);
  assert.doesNotMatch(s, /\|\s*head\b/);
});

test('DKS-4 Odoo 模块脚本只读 SELECT，绝不写库', () => {
  const s = buildOdooModuleScript();
  assert.match(s, /ir_module_module/);
  assert.match(s, /ir_config_parameter/);
  assert.doesNotMatch(s, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
  assert.doesNotMatch(s, /\|\s*head\b/);
});

test('DKS-5 配置扫描脚本只 grep，不改文件', () => {
  const s = buildConfigScanScript();
  assert.match(s, /grep/);
  assert.doesNotMatch(s, /\bsed\s+-i\b|\btee\b|>\s*\/opt\/|>\s*\/root\//);
  assert.doesNotMatch(s, /\|\s*head\b/);
});

test('DKS-6 四个脚本都幂等（同参数两次输出一致）', () => {
  for (const fn of [buildRuntimeScanScript, buildSystemdScanScript, buildOdooModuleScript, buildConfigScanScript]) {
    assert.equal(fn(), fn());
  }
});

// ---------------- DKR：运行时输出解析 ----------------

const RUNTIME_SAMPLE = [
  '===DOCKER===',
  '1Panel-odoo-kwnb|odoo:19.0|Up 3 days',
  '1Panel-postgresql-3eaO|postgres:16|Up 3 days',
  '===MOUNTS===',
  '1Panel-odoo-kwnb\t/opt/1panel/apps/odoo/odoo19/data/addons=>/mnt/extra-addons',
  '1Panel-odoo-kwnb\t/opt/1panel/apps/odoo/odoo19/data/data=>/var/lib/odoo',
  '1Panel-odoo-kwnb\t/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf=>/etc/odoo/odoo.conf',
  '===ENVKEYS===',
  '1Panel-odoo-kwnb\tHOST\tpostgresql',
  '1Panel-odoo-kwnb\tUSER\ttugou',
  '===WORKDIR===',
  '1Panel-odoo-kwnb\t/',
  '===PORTS===',
  '0.0.0.0:8069\t1Panel-odoo-kwnb',
  '0.0.0.0:8766\twebchat',
  '===PROCS===',
  'root\t1699378\t/opt/web_cs/venv/bin/python3 /opt/web_cs/server.py',
  'root\t3903300\t/usr/local/bin/hermes gateway run',
  '===RUNTIME_RC=0===',
].join('\n');

test('DKR-1 解析容器清单', () => {
  const r = parseRuntimeScan(RUNTIME_SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.containers.length, 2);
  assert.equal(r.containers[0].name, '1Panel-odoo-kwnb');
  assert.equal(r.containers[0].image, 'odoo:19.0');
});

test('DKR-2 解析挂载 Source→Destination（最硬的路径证据）', () => {
  const r = parseRuntimeScan(RUNTIME_SAMPLE);
  const c = r.containers.find((x) => x.name === '1Panel-odoo-kwnb');
  assert.equal(c.mounts.length, 3);
  assert.deepEqual(c.mounts[0], {
    source: '/opt/1panel/apps/odoo/odoo19/data/addons',
    destination: '/mnt/extra-addons',
  });
});

test('DKR-3 env 只保留键名，不保留值（AC-7）', () => {
  const r = parseRuntimeScan(RUNTIME_SAMPLE);
  const c = r.containers.find((x) => x.name === '1Panel-odoo-kwnb');
  assert.deepEqual(c.envKeys, ['HOST', 'USER']);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /postgresql\t|tugou/);
});

test('DKR-4 解析进程与监听端口', () => {
  const r = parseRuntimeScan(RUNTIME_SAMPLE);
  assert.equal(r.processes.length, 2);
  assert.equal(r.processes[0].pid, 1699378);
  assert.equal(r.processes[0].cmd, '/opt/web_cs/venv/bin/python3 /opt/web_cs/server.py');
  assert.equal(r.ports.length, 2);
  assert.equal(r.ports[1].port, 8766);
  assert.equal(r.ports[1].who, 'webchat');
});

test('DKR-5 无 docker 时降级但不失败（ok=true + dockerAvailable=false）', () => {
  const r = parseRuntimeScan('===DOCKER===\n===MOUNTS===\n===RUNTIME_RC=0===\n');
  assert.equal(r.ok, true);
  assert.equal(r.dockerAvailable, false);
  assert.deepEqual(r.containers, []);
});

test('DKR-6 缺 RUNTIME_RC 视为失败（不能返回空报告冒充成功）', () => {
  const r = parseRuntimeScan('===DOCKER===\nx|y|z\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有输出|不完整/);
});

test('DKR-7 非 0 退出码报出来', () => {
  const r = parseRuntimeScan('===DOCKER===\n===RUNTIME_RC=1===\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /1/);
});

// ---------------- DKSY：systemd 解析 ----------------

const SYSTEMD_SAMPLE = [
  '===UNITS===',
  'webchat.service loaded active running WebChat KB Service',
  'socat-odoo-proxy.service loaded active running socat proxy',
  '===CAT===',
  '###UNIT:webchat.service',
  'WorkingDirectory=/opt/web_cs',
  'EnvironmentFile=/root/.hermes/profiles/cs-main/.env',
  'ExecStart=/opt/web_cs/venv/bin/python3 /opt/web_cs/server.py',
  '###UNIT:socat-odoo-proxy.service',
  'ExecStart=/usr/bin/socat TCP-LISTEN:7890,bind=172.18.0.1,fork,reuseaddr TCP:127.0.0.1:7890',
  '===ENABLED===',
  'webchat.service\tenabled',
  'socat-odoo-proxy.service\tenabled',
  '===SYSTEMD_RC=0===',
].join('\n');

test('DKSY-1 解析运行中的 unit 清单', () => {
  const r = parseSystemdScan(SYSTEMD_SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.units.length, 2);
  assert.equal(r.units[0].name, 'webchat.service');
  assert.equal(r.units[0].active, 'active');
});

test('DKSY-2 解析 WorkingDirectory 与 EnvironmentFile（最有价值的一对）', () => {
  const r = parseSystemdScan(SYSTEMD_SAMPLE);
  const u = r.units.find((x) => x.name === 'webchat.service');
  assert.equal(u.workingDirectory, '/opt/web_cs');
  assert.equal(u.environmentFile, '/root/.hermes/profiles/cs-main/.env');
});

test('DKSY-3 解析 ExecStart 与 enabled 状态', () => {
  const r = parseSystemdScan(SYSTEMD_SAMPLE);
  const u = r.units.find((x) => x.name === 'socat-odoo-proxy.service');
  assert.match(u.execStart, /socat TCP-LISTEN:7890/);
  assert.equal(u.enabled, 'enabled');
});

test('DKSY-4 EnvironmentFile 只留路径，不留内容', () => {
  const r = parseSystemdScan(SYSTEMD_SAMPLE);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /DEEPSEEK|QQ_CLIENT/);
});

// ---------------- DKOD：Odoo 模块解析 ----------------

const ODOO_SAMPLE = [
  '===MODULES===',
  'chatbot_ai_hermes|19.0.1.1.1|installed',
  'tugou_payment_airwallex|19.0.1.0.0|installed',
  'base|19.0.1.0|installed',
  '===CONFPARAMS===',
  'web.base.url|https://www.toogel.cn',
  '===ODOO_RC=0===',
].join('\n');

test('DKOD-1 解析模块清单', () => {
  const r = parseOdooModules(ODOO_SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.modules.length, 3);
  assert.equal(r.modules[0].name, 'chatbot_ai_hermes');
  assert.equal(r.modules[0].version, '19.0.1.1.1');
});

test('DKOD-2 官方模块被标记（供上层过滤，不在解析层丢）', () => {
  const r = parseOdooModules(ODOO_SAMPLE);
  const base = r.modules.find((m) => m.name === 'base');
  assert.equal(base.official, true);
  const chat = r.modules.find((m) => m.name === 'chatbot_ai_hermes');
  assert.equal(chat.official, false);
});

test('DKOD-3 系统参数只留键名与 URL 形状，不留完整查询串', () => {
  const r = parseOdooModules(ODOO_SAMPLE);
  assert.equal(r.configParams.length, 1);
  assert.equal(r.configParams[0].key, 'web.base.url');
  assert.match(r.configParams[0].valueShape, /^https:\/\/www\.toogel\.cn$/);
});

test('DKOD-4 缺 ODOO_RC 视为失败', () => {
  const r = parseOdooModules('===MODULES===\nx|1|installed\n');
  assert.equal(r.ok, false);
});

// ---------------- DKCF：配置扫描解析 ----------------

const CONFIG_SAMPLE = [
  '===ENVKEYS===',
  '/root/.hermes/profiles/cs-main/.env\tDEEPSEEK_API_KEY',
  '/root/.hermes/profiles/cs-main/.env\tQQ_APP_ID',
  '===PATHLIT===',
  '/opt/web_cs/server.py\t/root/Documents/Obsidian Vault/01-客服知识库',
  '===URL===',
  '/opt/web_cs/server.py\thttps://api.deepseek.com/v1/chat/completions',
  '===CONFIG_RC=0===',
].join('\n');

test('DKCF-1 解析 env 键名（只有键名，没有值）', () => {
  const r = parseConfigScan(CONFIG_SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.envKeys.length, 2);
  assert.equal(r.envKeys[0].key, 'DEEPSEEK_API_KEY');
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /sk-/);
});

test('DKCF-2 解析路径字面量与 URL 字面量（低置信线索）', () => {
  const r = parseConfigScan(CONFIG_SAMPLE);
  assert.equal(r.pathLiterals.length, 1);
  assert.match(r.pathLiterals[0].value, /Obsidian Vault/);
  assert.equal(r.urls.length, 1);
  assert.match(r.urls[0].value, /api\.deepseek\.com/);
});

test('DKCF-3 配置扫描结果标记为 low 置信（AC-10 基础）', () => {
  const r = parseConfigScan(CONFIG_SAMPLE);
  assert.equal(r.confidence, 'low');
});
