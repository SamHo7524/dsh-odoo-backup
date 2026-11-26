/**
 * v0.4.0 — 服务器用途（备份源 / 恢复目标）互斥分类。
 *
 * 为什么单独一个模块：这条规则要被三处用到（服务层闸门、Host 保存校验、GUI 过滤），
 * 而它是纯数据判断——没有 IO、没有配置、没有远端。塞进 service.js 则 GUI 拿不到；
 * 塞进 client.js 则服务层拿不到（Agent 工具不经过界面）。
 *
 * 两个函数的职责必须分开（spec §5）：
 *  - normalizeServerRole：配置**写入时**严格校验，拼错就拒绝保存，让错误在入口暴露。
 *  - roleOf：**运行时**判定，只认精确 'restore'，其余一律 'backup'，
 *    且不修改入参、不自动修复、不持久化。容错方向是安全侧——
 *    配置坏了的结果是「恢复页少一台机器」，而不是「生产出现在恢复页」。
 */

export const SERVER_ROLES = ['backup', 'restore'];

export const ROLE_LABELS = {
  backup: '备份服务器',
  restore: '恢复目标',
};

function displayName(server) {
  const n = typeof server?.name === 'string' ? server.name.trim() : '';
  return n || '(未命名服务器)';
}

/** 配置写入时严格校验：缺失 → backup；非法 → 拒绝保存。 */
export function normalizeServerRole(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, role: 'backup' };
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (v === 'backup' || v === 'restore') return { ok: true, role: v };
  }
  return {
    ok: false,
    reason: '服务器用途只能是 backup（备份服务器）或 restore（恢复目标），'
      + `收到：${JSON.stringify(value)}`,
  };
}

/** 运行时判定：纯函数，只认精确 'restore'。 */
export function roleOf(server) {
  return server?.role === 'restore' ? 'restore' : 'backup';
}

export function canBackup(server) {
  return roleOf(server) === 'backup';
}

export function canRestore(server) {
  return roleOf(server) === 'restore';
}

/** 破坏性入口：备份源校验。 */
export function assertBackupServer(server) {
  if (canBackup(server)) return server;
  throw new Error(
    `服务器「${displayName(server)}」的用途是「${ROLE_LABELS.restore}」，不能作为备份源。`
    + '恢复目标的内容来自备份包，对它备份会产生一份「看起来像生产、其实不是」的快照。'
    + `请到「服务器」页把用途改为「${ROLE_LABELS.backup}」。`,
  );
}

/** 破坏性入口：恢复目标校验。 */
export function assertRestoreTarget(server) {
  if (canRestore(server)) return server;
  throw new Error(
    `服务器「${displayName(server)}」的用途是「${ROLE_LABELS.backup}」，不能作为恢复目标。`
    + '恢复会执行 ALTER DATABASE ... RENAME 覆盖目标库并替换 filestore（原库改名为 <库>-old-<时间戳>），'
    + `因此只允许用途为「${ROLE_LABELS.restore}」的服务器执行。`
    + `如果这台机器确实是演练机，请到「服务器」页把用途改为「${ROLE_LABELS.restore}」`
    + '（该改动需要输入服务器名确认）。',
  );
}

/** 界面分类：保持原顺序，对脏输入返回两个空数组。 */
export function partitionServers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const backup = [];
  const restore = [];
  for (const s of list) (roleOf(s) === 'restore' ? restore : backup).push(s);
  return { backup, restore };
}
