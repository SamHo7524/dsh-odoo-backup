import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * 恢复演练脚本（只在测试主机 odoo.toogel.cn / 134.175.51.9 上跑）。
 *
 * 生产主机 47.121.205.143 全程只读 —— 本脚本硬编码了 TARGET_HOST，
 * 若传入的主机不是测试机，直接拒绝执行。
 */

const TARGET_HOST = '134.175.51.9';

const LIB = 'C:/Users/Ho/.dsh/remote-workspaces/wmv8yhew3a4r8/dsh-odoo-backup/lib';
const { discover } = await import(pathToFileURL(`${LIB}/discover.js`).href);
const { runRestore } = await import(pathToFileURL(`${LIB}/restore.js`).href);

// 口令：只读长度，绝不打印值
const credText = readFileSync('C:/Users/Ho/.dsh/.credentials.yaml', 'utf8');
const m = credText.match(/ODOO_BACKUP_PASSPHRASE\s*:\s*["']?([^"'\r\n]+)["']?/);
if (!m) throw new Error('未找到 ODOO_BACKUP_PASSPHRASE');
const passphrase = m[1].trim();
console.log(`口令已载入（长度 ${passphrase.length}，不打印）`);

const server = {
  name: 'odoo.toogel.cn',
  host: TARGET_HOST,
  port: 22,
  user: 'root',
  keyPath: 'H:/odoo/key/odoo-backup',
  pinnedFingerprint: 'SHA256:Yty1O6gmuMyQ3i7vUqiZy0gomEAF/Ssg2h9uNNC0qn0',
  // 必须显式给：discover 读的是 /etc/odoo/odoo.conf（容器内那份几乎是空注释），
  // 真正生效的是 ODOO_RC=/etc/odoo/odoo-hardening.conf，见本轮记录的缺陷。
  dbName: 'toogel',
  dbPort: 5432,
};

if (server.host !== TARGET_HOST) throw new Error('拒绝：本脚本只允许在测试主机执行');

const packagePath = process.argv[2];
if (!packagePath) throw new Error('用法: node restore.mjs <备份包路径>');
console.log(`备份包 ${packagePath}`);

console.log('正在探测实例…');
const found = await discover(server);
if (!found?.instances?.length) throw new Error('测试主机上未发现 Odoo 实例');
const instance = found.instances[0];
console.log(
  `实例 ${instance.odooContainer} / ${instance.odooVersion} / db=${instance.dbName} / ` +
    `addons=${instance.addonsPath} / data=${instance.dataPath} / uid=${instance.uid}:${instance.gid}`,
);

let last = '';
const onProgress = (p) => {
  const line = `${p.phase} ${p.percent}% ${p.message ?? ''}`;
  if (line !== last) {
    last = line;
    console.log('PROG', line);
  }
};

const res = await runRestore({
  server,
  instance,
  packagePath,
  options: {
    passphrase,
    rotateSecret: true,
    neutralize: true,
  },
  onProgress,
});

console.log('=== RESTORE RESULT ===');
console.log(JSON.stringify(res, null, 2));
