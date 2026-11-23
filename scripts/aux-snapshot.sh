#!/usr/bin/env bash
# aux-snapshot.sh — 补齐 extraPaths 覆盖不到的散文件（L2 层）
#
# 设计约束（来自 2026-11-23 用户裁决）：
#   - 保留原始文件路径结构（tar -C / 打包，成员为绝对路径去掉前导 /）
#   - 记录文件清单、大小、SHA-256（MANIFEST 内）
#   - 缺失文件明确记录，不得静默跳过（.missing + manifest.missing[]）
#   - 不覆盖生产文件（本脚本只读源，只写 /srv/backups/aux）
#   - set -uo pipefail，不用 set -e（管道 SIGPIPE 会提前退出）
#
# 用法：
#   bash aux-snapshot.sh                # 全量：prepare-secret + files + kb-scripts
#   bash aux-snapshot.sh prepare-secret # 只做密钥提取（主备份前必须先跑这个）
#   bash aux-snapshot.sh snapshot       # 只打包（假定 secret 已就绪）
#
# 退出码：0 成功 / 1 有缺失项但包已生成 / 2 致命
set -uo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
OUT="/srv/backups/aux"
KEEP=12
MODE="${1:-all}"

ENV_SRC="/root/.hermes/profiles/cs-main/.env"
SECRET_OUT="/root/.hermes/secrets/deepseek.env"
SECRET_KEY="DEEPSEEK_API_KEY"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------- prepare-secret
# 从 .env 只提取 DEEPSEEK_API_KEY 一行 → SECRET_OUT（umask 077，不留临时文件）
# 绝不 echo 密钥内容；只打印长度。
do_prepare_secret() {
  [ -f "$ENV_SRC" ] || die "找不到 $ENV_SRC"

  local line val
  # 用 -m1 只取第一条；用 grep -F 精确键名（避免 DEEPSEEK_API_KEY_OLD 之类误命中）
  line="$(grep -m1 -E "^[[:space:]]*${SECRET_KEY}[[:space:]]*=" "$ENV_SRC" || true)"
  if [ -z "$line" ]; then
    die "$ENV_SRC 中找不到 $SECRET_KEY"
  fi
  val="${line#*=}"
  # 去掉可能的包裹引号（不打印值）
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  [ -n "$val" ] || die "$SECRET_KEY 为空，拒绝写入"

  # 原子写：先写目标同目录的临时文件再 mv（同分区 mv 是原子的），但仍 umask 077
  ( umask 077
    mkdir -p "$(dirname "$SECRET_OUT")"
    printf '# 由 aux-snapshot.sh 于 %s 从 %s 提取\n# 仅含 %s；QQ_* 不在此文件\n%s=%s\n' \
      "$TS" "$ENV_SRC" "$SECRET_KEY" "$SECRET_KEY" "$val" > "$SECRET_OUT.tmp.$$"
    chmod 600 "$SECRET_OUT.tmp.$$"
    mv -f "$SECRET_OUT.tmp.$$" "$SECRET_OUT"
  )
  chmod 600 "$SECRET_OUT"

  unset val line
  printf 'SECRET_OK path=%s key=%s len=%s mode=%s\n' \
    "$SECRET_OUT" "$SECRET_KEY" "$(awk -F= '/^DEEPSEEK_API_KEY=/{print length($2)}' "$SECRET_OUT")" \
    "$(stat -c '%a' "$SECRET_OUT")"
}

# --------------------------------------------------------------- attendance 快照
# 2026-11-23 用户裁决：/root/attendance-system 纳入完整灾备，但
#   「attendance.db 正在写入，不能直接把正在使用的 SQLite 文件当普通静态文件复制」
#   「建议使用 SQLite Online Backup API……备份完成后检查数据库完整性 PRAGMA integrity_check; 结果必须为 ok」
#   「先做一致性快照，再把快照纳入 L2 包」
# 因此：extraPaths 里显式排除了 attendance.db/-shm/-wal（tar 直接复制活动库会拿到不一致页），
# 一致性快照由本函数产出，随 L2 包一起保管。
#
# 注意（安全）：SECRET_KEY.txt **不** 进 L2（L2 包是未加密的 tar.gz）；它随
# extraPaths→主备份→AES-256-GCM 加密包走。本函数只处理数据库。
#
# 依赖：python3（无 sqlite3 CLI 也可用；源库以 mode=ro 打开，绝不写源）
do_snapshot_attendance() {
  local SRC_DIR="/root/attendance-system"
  local SRC_DB="$SRC_DIR/attendance.db"
  local TMP_DB="$OUT/.attendance-snap-$TS.db"
  local META="$OUT/attendance-meta-$TS.txt"

  if [ ! -f "$SRC_DB" ]; then
    printf '%s\n' "$SRC_DB" >> "$MISS"
    log "MISSING: $SRC_DB（跳过一致性快照）"
    return 0
  fi
  command -v python3 >/dev/null 2>&1 || die "缺少 python3，无法做 SQLite 一致性快照"

  # 1) Online Backup API 一致性快照 + integrity_check
  local vout
  vout="$(python3 - "$SRC_DB" "$TMP_DB" <<'PY'
import sqlite3, sys, json
src_path, dst_path = sys.argv[1], sys.argv[2]
out = {}
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
try:
    out["src_journal_mode"] = src.execute("PRAGMA journal_mode").fetchone()[0]
    dst = sqlite3.connect(dst_path)
    try:
        src.backup(dst)          # 在线备份，WAL 下也包含未 checkpoint 的数据
    finally:
        dst.close()
finally:
    src.close()

chk = sqlite3.connect(f"file:{dst_path}?mode=ro", uri=True)
try:
    out["integrity_check"] = chk.execute("PRAGMA integrity_check").fetchone()[0]
    tables = [r[0] for r in chk.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    counts = {}
    for t in tables:
        try:
            counts[t] = chk.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except Exception as e:
            counts[t] = f"ERR:{type(e).__name__}"
    out["tables"] = tables
    out["counts"] = counts
finally:
    chk.close()
print(json.dumps(out, ensure_ascii=False))
PY
)" || die "attendance 一致性快照失败"

  local ok
  ok="$(printf '%s' "$vout" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("integrity_check",""))' 2>/dev/null)"
  if [ "$ok" != "ok" ]; then
    log "integrity_check 未通过：${ok:-<空>}"
    rm -f "$TMP_DB"
    die "attendance.db 一致性校验失败，拒绝出包"
  fi

  # 2) 记录元信息（Python 版本 / 依赖版本 / 表行数）——用户要求「记录 Python 版本和依赖版本」
  {
    printf '# attendance 快照元信息  ts=%s\n' "$TS"
    printf 'SOURCE_DB\t%s\n' "$SRC_DB"
    printf 'SOURCE_BYTES\t%s\n' "$(stat -c '%s' "$SRC_DB")"
    printf 'SNAPSHOT\t%s\n' "$vout"
    local pyv reqf
    pyv="$(python3 --version 2>&1)"
    printf 'PYTHON_%s\n' "$pyv"
    if [ -f "$SRC_DIR/venv/pyvenv.cfg" ]; then
      printf 'VENV_PYVENV_CFG\t%s\n' "$(tr '\n' ';' < "$SRC_DIR/venv/pyvenv.cfg")"
    fi
    for reqf in requirements.txt requirements-full.txt; do
      if [ -f "$SRC_DIR/$reqf" ]; then
        printf 'REQ\t%s\t%s\n' "$reqf" "$(tr '\n' ';' < "$SRC_DIR/$reqf")"
      else
        printf 'REQ\t%s\tMISSING\n' "$reqf"
      fi
    done
    if [ -d "$SRC_DIR/.git" ]; then
      printf 'GIT_HEAD\t%s\n' "$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo UNAVAILABLE)"
      printf 'GIT_DIRTY\t%s\n' "$(git -C "$SRC_DIR" status --porcelain 2>/dev/null | wc -l)"
    fi
  } > "$META"
  sha256sum "$META" | awk '{print $1}' > "$META.sha256"

  # 3) 快照打成独立包（不加密的 L2 层；密钥不在其中）
  mv -f "$TMP_DB" "$OUT/attendance-snapshot-$TS.db"
  local SNAP="$OUT/attendance-snapshot-$TS.db"
  local P4="$OUT/attendance-db-$TS.tar.gz"
  tar -C "$OUT" --numeric-owner -czf "$P4" "attendance-snapshot-$TS.db" 2>"$OUT/.tarerr4.$TS"
  local rc4=$?
  if [ $rc4 -ne 0 ]; then
    log "tar(attendance) rc=$rc4"
    tail -c 500 "$OUT/.tarerr4.$TS"
    die "attendance 快照打包失败"
  fi
  sha256sum "$P4" | awk '{print $1}' > "$P4.sha256"
  local FL4="$OUT/attendance-db-$TS.filelist.txt"
  tar -tzf "$P4" > "$FL4" 2>/dev/null || log "WARN: 无法生成 $FL4"
  sha256sum "$FL4" | awk '{print $1}' > "$FL4.sha256"

  # 未压缩快照本身也保留（便于直接核对），并记录 sha
  sha256sum "$SNAP" | awk '{print $1}' > "$SNAP.sha256"

  ATTN_P4="$P4"; ATTN_SNAP="$SNAP"; ATTN_META="$META"; ATTN_FL="$FL4"
  ATTN_SUM="$vout"
  log "ATTENDANCE_OK snapshot=$(basename "$SNAP")( $(stat -c '%s' "$SNAP")B ) pkg=$(basename "$P4")( $(stat -c '%s' "$P4")B ) integrity=ok"
}

# ---------------------------------------------------------------------- snapshot
do_snapshot() {
  mkdir -p "$OUT" || die "无法创建 $OUT"

  local LIST="$OUT/.list.$TS"
  local MISS="$OUT/.missing.$TS"
  local SIZES="$OUT/.sizes.$TS"
  : > "$LIST"; : > "$MISS"; : > "$SIZES"

  # 11 个单文件：/etc/cron.d 3 个（不整个目录，避免带入 e2scrub_all/sysstat 等系统项）、
  # jobs.json、kb_mail.env、4 个 profile wrapper、2 个 unit
  local F=""
  F="$F /etc/cron.d/kb-governance"
  F="$F /etc/cron.d/rag-backup"
  F="$F /etc/cron.d/vault-sync"
  F="$F /root/.hermes/cron/jobs.json"
  F="$F /root/.hermes/secrets/kb_mail.env"
  F="$F /root/.local/bin/cs-main"
  F="$F /root/.local/bin/hermes"
  F="$F /root/.local/bin/hermes-acp"
  F="$F /root/.local/bin/hermes-agent"
  F="$F /etc/systemd/system/webchat.service"
  F="$F /etc/systemd/system/socat-odoo-proxy.service"

  local f
  for f in $F; do
    if [ -e "$f" ]; then
      # tar --files-from 用相对 / 的路径，保留原始结构
      printf '%s\n' "${f#/}" >> "$LIST"
      printf '%s\t%s\n' "$(stat -c '%s' "$f")" "${f#/}" >> "$SIZES"
    else
      printf '%s\n' "$f" >> "$MISS"
      log "MISSING: $f"
    fi
  done

  local nlist
  nlist="$(wc -l < "$LIST")"
  log "清单 $nlist 项，缺失 $(wc -l < "$MISS") 项"

  # --- 包 1：散文件
  local P1="$OUT/aux-$TS.tar.gz"
  tar -C / --numeric-owner --files-from="$LIST" -czf "$P1" 2>"$OUT/.tarerr.$TS"
  local rc1=$?
  if [ $rc1 -ne 0 ]; then
    log "tar(aux) rc=$rc1"
    tail -c 500 "$OUT/.tarerr.$TS"
    die "aux 打包失败"
  fi
  sha256sum "$P1" | awk '{print $1}' > "$P1.sha256"

  # --- 包 2：/root/scripts/kb 全目录（排 __pycache__）
  local P2="$OUT/kb-scripts-$TS.tar.gz"
  tar -C /root --numeric-owner --exclude=scripts/kb/__pycache__ -czf "$P2" scripts/kb 2>"$OUT/.tarerr2.$TS"
  local rc2=$?
  if [ $rc2 -ne 0 ]; then
    log "tar(kb) rc=$rc2"
    tail -c 500 "$OUT/.tarerr2.$TS"
    die "kb-scripts 打包失败"
  fi
  sha256sum "$P2" | awk '{print $1}' > "$P2.sha256"

  # --- 包 3：/root/scripts 其余运维脚本（目录级，不逐个挑文件）
  # 2026-11-23 补入。此前只打 kb/，漏了 odoo19-website-translator/ 412,897 B、
  # toogel/ 58,432 B、toogel-v20/ 42,627 B 与 7 个散落 .py/.sh。
  # 排除：scripts/kb（已由包 2 独立打包，避免重复）、__pycache__（任意层级）。
  # 保留：odoo19-website-translator/.git（本地仓库、无 remote，是历史唯一副本）。
  local P3="$OUT/ops-scripts-$TS.tar.gz"
  tar -C /root --numeric-owner \
      --exclude=scripts/kb \
      --exclude=__pycache__ \
      -czf "$P3" scripts 2>"$OUT/.tarerr3.$TS"
  local rc3=$?
  if [ $rc3 -ne 0 ]; then
    log "tar(ops) rc=$rc3"
    tail -c 500 "$OUT/.tarerr3.$TS"
    die "ops-scripts 打包失败"
  fi
  sha256sum "$P3" | awk '{print $1}' > "$P3.sha256"

  # 包 3 的逐文件清单（目录级打包需要文件级可审计清单）
  local FL="$OUT/ops-scripts-$TS.filelist.txt"
  tar -tzf "$P3" > "$FL" 2>/dev/null || log "WARN: 无法生成 $FL"
  sha256sum "$FL" | awk '{print $1}' > "$FL.sha256"

  # --- 明文口令预警扫描（2026-11-23 用户裁决：照原样打包，但必须在 MANIFEST 标记）
  # 只记录「哪个文件哪几行」，绝不打印口令值，也绝不修改源文件。
  # 命中条件：password/passwd/PGPASSWORD/_PG 等赋值号右侧是**引号字面量**且 ≥6 字符；
  # 排除：$var / '$(cmd)' 变量引用；<占位符> 形式的文档示例（如 <db密码>）；
  #       xxxx / **** / your_password 等明显占位串。
  local SW="$OUT/ops-scripts-$TS.secretwarn.txt"
  : > "$SW"
  local pat
  pat='(PGPASSWORD|password|passwd|_PG|DBPASSWORD|db_password)[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"'`$][^"'"'"'`]{5,}["'"'"']'
  grep -rnIiE "$pat" /root/scripts 2>/dev/null \
    | grep -v '/__pycache__/' \
    | grep -v '^/root/scripts/kb/' \
    | grep -viE '<[^>]*>|xxxx|\*\*\*|your[_-]?(password|pass|pwd)|change[_-]?me|placeholder' \
    | grep -vE '\{[A-Za-z_][A-Za-z_0-9]*\}' \
    | awk -F: '{sub(/^\//,"",$1); print $1"\t"$2}' \
    | sort -k1,1 -k2,2n \
    | awk -F'\t' '{ if($1==p){ln=ln","$2} else { if(p!="")printf "%s\t%s\n",p,ln; p=$1; ln=$2 } } END{ if(p!="")printf "%s\t%s\n",p,ln }' \
    > "$SW" || true
  local nsw
  nsw="$(wc -l < "$SW")"
  if [ "$nsw" -gt 0 ]; then
    log "SECRET_WARN：$nsw 个文件含明文口令字面量（值未读取、未打印；见 MANIFEST）"
    while IFS=$'\t' read -r sp sl; do
      [ -n "${sp:-}" ] || continue
      log "  含明文口令：$sp（行 $sl）"
    done < "$SW"
  else
    log "SECRET_WARN：未检出明文口令字面量"
  fi
  sha256sum "$SW" | awk '{print $1}' > "$SW.sha256"

  # --- 包 4：attendance 一致性快照（2026-11-23 用户裁决：活动 SQLite 不能 tar 直拷）
  ATTN_P4=""; ATTN_SNAP=""; ATTN_META=""; ATTN_FL=""; ATTN_SUM=""
  do_snapshot_attendance

  # --- WAF geo 记录（2026-11-23 用户裁决：geo 不进常规包，但必须记录来源/版本/校验/恢复验证）
  local GEO="$OUT/waf-geo-$TS.txt"
  {
    printf '# WAF geo 数据记录  ts=%s\n' "$TS"
    printf '# 用户裁决：geo 约 27.9 MB 可重新下载，不进入常规备份包；但必须记录版本与恢复方式。\n'
    local GEO_DIR="/opt/1panel/apps/openresty/openresty/1pwaf/data/geo"
    if [ -d "$GEO_DIR" ]; then
      local g
      for g in "$GEO_DIR"/*; do
        [ -f "$g" ] || continue
        printf 'GEO_FILE\t%s\t%s\t%s\n' \
          "$(basename "$g")" "$(stat -c '%s' "$g")" "$(sha256sum "$g" | awk '{print $1}')"
        # mmdb 内嵌构建时间（只读 strings 抓 build_epoch 线索，失败则跳过）
        printf 'GEO_FILE_MTIME\t%s\t%s\n' "$(basename "$g")" "$(date -r "$g" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || echo UNAVAILABLE)"
      done
      printf 'GEO_DIR_BYTES\t%s\n' "$(du -sb "$GEO_DIR" 2>/dev/null | awk '{print $1}')"
    else
      printf 'GEO_DIR\tMISSING\t%s\n' "$GEO_DIR"
    fi
    # 自建站点配置（才是真正要备份的 WAF 自定义资产）
    local SITES="/opt/1panel/apps/openresty/openresty/1pwaf/data/sites"
    if [ -d "$SITES" ]; then
      printf 'SITES_BYTES\t%s\n' "$(du -sb "$SITES" 2>/dev/null | awk '{print $1}')"
      printf 'SITES_FILES\t%s\n' "$(find "$SITES" -type f | wc -l)"
      printf 'SITES_SHA\t%s\n' "$(cd "$SITES" && find . -type f -print0 | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
    else
      printf 'SITES\tMISSING\t%s\n' "$SITES"
    fi
    printf 'RECOVER_HOW\t从官方渠道重新下载 GeoIP/BlackIP/SpiderIP mmdb，按上面 GEO_FILE 的 sha256 校验后再启动 openresty\n'
    printf 'RECOVER_VERIFY\t重启 openresty 后确认 1pwaf 加载 geo 无报错，并在面板/日志检查 WAF 正常拦截\n'
    printf 'CONF_SENSITIVE\tconf/{token,.secret,.aes_key} 属密钥类，已随 extraPaths→主备份加密包，不在本未加密 L2 包内\n'
  } > "$GEO"
  sha256sum "$GEO" | awk '{print $1}' > "$GEO.sha256"
  log "WAF_GEO：已记录 $(basename "$GEO")（geo 本身不进包）"

  # --- MANIFEST（纯文本，逐行：类型<TAB>字节<TAB>sha256<TAB>路径）
  local MAN="$OUT/aux-$TS.manifest.txt"
  {
    printf '# aux-snapshot manifest  ts=%s  host=%s\n' "$TS" "$(hostname)"
    printf '# 格式：KIND<TAB>BYTES<TAB>SHA256<TAB>PATH\n'
    printf 'ARCHIVE\t%s\t%s\t%s\n' \
      "$(stat -c '%s' "$P1")" "$(cat "$P1.sha256")" "${P1#/}"
    printf 'ARCHIVE\t%s\t%s\t%s\n' \
      "$(stat -c '%s' "$P2")" "$(cat "$P2.sha256")" "${P2#/}"
    printf 'ARCHIVE\t%s\t%s\t%s\n' \
      "$(stat -c '%s' "$P3")" "$(cat "$P3.sha256")" "${P3#/}"
    printf 'ARTIFACT\t%s\t%s\t%s\n' \
      "$(stat -c '%s' "$FL")" "$(cat "$FL.sha256")" "${FL#/}"
    printf 'ARTIFACT\t%s\t%s\t%s\n' \
      "$(stat -c '%s' "$GEO")" "$(cat "$GEO.sha256")" "${GEO#/}"
    if [ -n "${ATTN_P4:-}" ]; then
      printf 'ARCHIVE\t%s\t%s\t%s\n' \
        "$(stat -c '%s' "$ATTN_P4")" "$(cat "$ATTN_P4.sha256")" "${ATTN_P4#/}"
      printf 'ARTIFACT\t%s\t%s\t%s\n' \
        "$(stat -c '%s' "$ATTN_META")" "$(cat "$ATTN_META.sha256")" "${ATTN_META#/}"
      printf 'ARTIFACT\t%s\t%s\t%s\n' \
        "$(stat -c '%s' "$ATTN_FL")" "$(cat "$ATTN_FL.sha256")" "${ATTN_FL#/}"
      printf 'ATTENDANCE\t%s\t%s\t%s\t%s\n' \
        "$(stat -c '%s' "$ATTN_SNAP")" "$(cat "$ATTN_SNAP.sha256")" "${ATTN_SNAP#/}" "$ATTN_SUM"
    fi
    # 明文口令预警：SECRETWARN<TAB>0<TAB>行号列表<TAB>文件路径
    while IFS=$'\t' read -r sp sl; do
      [ -n "${sp:-}" ] || continue
      printf 'SECRETWARN\t0\t%s\t%s\n' "$sl" "$sp"
    done < "$SW"
    # 逐文件条目
    while IFS=$'\t' read -r sz path; do
      [ -n "${path:-}" ] || continue
      local sum
      sum="$(sha256sum "/$path" 2>/dev/null | awk '{print $1}')"
      printf 'FILE\t%s\t%s\t%s\n' "$sz" "${sum:-UNAVAILABLE}" "$path"
    done < "$SIZES"
    # 缺失项
    while IFS= read -r m; do
      [ -n "${m:-}" ] || continue
      printf 'MISSING\t0\t-\t%s\n' "${m#/}"
    done < "$MISS"
  } > "$MAN"
  sha256sum "$MAN" | awk '{print $1}' > "$MAN.sha256"

  # --- 保留最近 KEEP 份
  ls -1t "$OUT"/aux-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/kb-scripts-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/ops-scripts-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/attendance-db-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/attendance-snapshot-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/attendance-meta-*.txt 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/waf-geo-*.txt 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$OUT"/aux-*.manifest.txt 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

  rm -f "$OUT"/.tarerr*."$TS"
  # 保留 LIST/SIZES 供审计（小文件），MISS 转为永久记录
  cp -f "$MISS" "$OUT/aux-$TS.missing.txt" 2>/dev/null || true

  local attn_name attn_size
  if [ -n "${ATTN_P4:-}" ]; then
    attn_name="$(basename "$ATTN_P4")"
    attn_size="$(stat -c '%s' "$ATTN_P4")"
  else
    attn_name="none"
    attn_size=0
  fi
  printf 'SNAPSHOT_OK ts=%s aux=%s(%sB) kbs=%s(%sB) ops=%s(%sB) attn=%s(%sB) files=%s missing=%s secretwarn=%s\n' \
    "$TS" "$(basename "$P1")" "$(stat -c '%s' "$P1")" \
    "$(basename "$P2")" "$(stat -c '%s' "$P2")" \
    "$(basename "$P3")" "$(stat -c '%s' "$P3")" \
    "$attn_name" "$attn_size" \
    "$nlist" "$(wc -l < "$MISS")" "$nsw"

  local nmiss
  nmiss="$(wc -l < "$MISS")"
  [ "$nmiss" -eq 0 ] && return 0 || return 1
}

case "$MODE" in
  prepare-secret) do_prepare_secret ;;
  snapshot)       do_snapshot ;;
  all)
    do_prepare_secret
    # prepare-secret 产物必须落在 hermes-home 覆盖范围内，主备份才会带上
    case "$SECRET_OUT" in
      /root/.hermes/*) : ;;
      *) die "$SECRET_OUT 不在 /root/.hermes 下，不会被 hermes-home 那条 extraPaths 覆盖" ;;
    esac
    do_snapshot
    ;;
  *) die "未知模式：$MODE（可用 all|prepare-secret|snapshot）" ;;
esac
