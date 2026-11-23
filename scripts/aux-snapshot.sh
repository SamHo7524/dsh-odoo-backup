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
  ls -1t "$OUT"/aux-*.manifest.txt 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

  rm -f "$OUT"/.tarerr*."$TS"
  # 保留 LIST/SIZES 供审计（小文件），MISS 转为永久记录
  cp -f "$MISS" "$OUT/aux-$TS.missing.txt" 2>/dev/null || true

  printf 'SNAPSHOT_OK ts=%s aux=%s(%sB) kbs=%s(%sB) ops=%s(%sB) files=%s missing=%s secretwarn=%s\n' \
    "$TS" "$(basename "$P1")" "$(stat -c '%s' "$P1")" \
    "$(basename "$P2")" "$(stat -c '%s' "$P2")" \
    "$(basename "$P3")" "$(stat -c '%s' "$P3")" \
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
