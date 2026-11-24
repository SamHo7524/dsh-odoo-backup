#!/usr/bin/env bash
# 恢复演练：还原 8 条 extraPaths + 2 个加密单文件（只在测试主机 134.175.51.9 执行）
#
# 落盘策略：**全部原位还原**，但遵循三条纪律
#  1. 先备份再覆盖 —— 每个已存在的目标目录先 tar 到 /tmp/drill-pre-<TS>/，
#     出问题可整体回滚（这是真实恢复该有的做法，不是演练特例）
#  2. 只增不删 —— cp -a 合并语义，绝不 rm 目标里已有的东西。
#     测试主机自己那套 systemd 单元 / nginx 站点不会被我们的恢复抹掉。
#  3. 覆盖后必须复查既有文件还在 —— 「恢复了生产的，弄丢了本机的」同样是失败
#
# 其它纪律：不用 set -e、禁 | head、绝不打印任何文件内容（只打印大小/哈希/权限）
set -uo pipefail

TS=20261124-150923
SRC=/srv/drill-extras
STAGE=/tmp/drill-stage-$TS
PREBAK=/tmp/drill-pre-$TS
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS  $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
note() { echo "NOTE  $*"; }

rm -rf "$STAGE" "$PREBAK"
mkdir -p "$STAGE" "$PREBAK"

# name|target|archive
ENTRIES="
vault|/root/Documents/Obsidian Vault|vault-$TS.tar.zst
web-cs|/opt/web_cs|web-cs-$TS.tar.zst
hermes-profile|/root/.hermes/profiles/cs-main|hermes-profile-$TS.tar.zst
hermes-home|/root/.hermes|hermes-home-$TS.tar.zst
web-stack|/opt/1panel/www|web-stack-$TS.tar.zst
sys-units|/etc/systemd/system|sys-units-$TS.tar.zst
attendance-system|/root/attendance-system|attendance-system-$TS.tar.zst
waf-data|/opt/1panel/apps/openresty/openresty/1pwaf/data|waf-data-$TS.tar.zst
"

echo "=== STEP 1 归档 sha256 校验（对照 MANIFEST.json，不信任传输过程）==="
sha_check() {
  local f="$1" want="$2" label="$3" got
  if [ ! -f "$SRC/$f" ]; then bad "$label 归档缺失 $f"; return; fi
  got=$(sha256sum "$SRC/$f" | awk '{print $1}')
  if [ "$got" = "$want" ]; then ok "$label sha256 相符"; else bad "$label sha256 不符 want=$want got=$got"; fi
}
sha_check vault-$TS.tar.zst              a75a01c7492e3a8cbc108b02eceb44bf9ed874e28dac6de74d847461ae3b4e4e vault
sha_check web-cs-$TS.tar.zst             faeabcb3be1b528f0e5c90efe657cd0c529553c0147223c3c4d1ea4b26b4f1cc web-cs
sha_check hermes-profile-$TS.tar.zst     773608aa0f55be53f7b9c46c4174ecc1ebeb0adc7d1ff10f179c0e53bb8ab53d hermes-profile
sha_check web-stack-$TS.tar.zst          82ba31b0041a4618c56ffbd487a8c15b59e66132b59a43df805b9900ef002c0c web-stack
sha_check sys-units-$TS.tar.zst          bfc5e35a336cb0d4db7416b95b4bb44f9633b65beb89897783e9686977d8e7af sys-units
sha_check hermes-home-$TS.tar.zst        64a70d2b8295e8b468782510c8bbde2c4b872dc26e799fe3eb97d55f424f9cd4 hermes-home
sha_check attendance-system-$TS.tar.zst  8fbc41597c41ec60e30f5eeb2121de139b5e57996827a504d1d6eba6570fcc4a attendance-system
sha_check waf-data-$TS.tar.zst           08fe1f78032246357dcebcc0f3c4d6a787c66cdb3e5916580365761f931ada0c waf-data
sha_check extra-files-$TS.tar.gz         2348303063802c5a2732e42fefb0ccca7960196f4a896084fa7288df85474494 extra-files

echo
echo "=== STEP 2 解到暂存区（先证明压缩包能解，再谈落盘）==="
while IFS='|' read -r name target arch; do
  [ -z "$name" ] && continue
  mkdir -p "$STAGE/$name"
  if tar --zstd -xf "$SRC/$arch" -C "$STAGE/$name" 2>"$STAGE/$name.err"; then
    ok "$name 解包成功，条目 $(find "$STAGE/$name" -mindepth 1 | wc -l)"
  else
    bad "$name 解包失败：$(tail -c 300 "$STAGE/$name.err")"
  fi
done <<< "$ENTRIES"

echo
echo "=== STEP 3 覆盖前先备份既有目标（可整体回滚）==="
while IFS='|' read -r name target arch; do
  [ -z "$name" ] && continue
  if [ -e "$target" ]; then
    b="$PREBAK/$name.tar.zst"
    if tar --zstd -cf "$b" -C / "${target#/}" 2>"$PREBAK/$name.err"; then
      ok "$name 既有内容已备份 $(stat -c %s "$b") B（$(find "$target" -mindepth 1 | wc -l) 个条目）"
    else
      bad "$name 备份失败：$(tail -c 300 "$PREBAK/$name.err")"
    fi
    # 记下既有文件清单，覆盖后要复查全都还在
    find "$target" -mindepth 1 2>/dev/null | sort > "$PREBAK/$name.list"
  else
    note "$name 目标原本不存在（$target）→ 纯新增恢复"
    : > "$PREBAK/$name.list"
  fi
done <<< "$ENTRIES"

echo
echo "=== STEP 4 原位还原（cp -a 合并语义，只增不删）==="
while IFS='|' read -r name target arch; do
  [ -z "$name" ] && continue
  [ -d "$STAGE/$name" ] || { bad "$name 暂存缺失，跳过"; continue; }
  mkdir -p "$target"
  if cp -a "$STAGE/$name/." "$target/" 2>"$STAGE/$name.cp.err"; then
    ok "$name 已还原 → $target（现有 $(find "$target" -mindepth 1 | wc -l) 个条目）"
  else
    bad "$name 还原失败：$(tail -c 300 "$STAGE/$name.cp.err")"
  fi
done <<< "$ENTRIES"

echo
echo "=== STEP 5 只增不删：覆盖前存在的文件必须一条不少 ==="
while IFS='|' read -r name target arch; do
  [ -z "$name" ] && continue
  list="$PREBAK/$name.list"
  [ -s "$list" ] || continue
  missing=$(comm -23 "$list" <(find "$target" -mindepth 1 2>/dev/null | sort) | wc -l)
  if [ "$missing" -eq 0 ]; then
    ok "$name 既有 $(wc -l < "$list") 个条目全部保留"
  else
    bad "$name 覆盖后丢了 $missing 个既有条目：$(comm -23 "$list" <(find "$target" -mindepth 1 2>/dev/null | sort) | tr '\n' ' ' | cut -c1-240)"
  fi
done <<< "$ENTRIES"

echo
echo "=== STEP 6 两个加密单文件（保留绝对路径 / 权限 / 属主）==="
mkdir -p /opt/1panel/runtime/python/attendance
if tar -xzf "$SRC/extra-files-$TS.tar.gz" -C / 2>"$STAGE/ef.err"; then
  ok "extra-files 已按绝对路径还原"
else
  bad "extra-files 还原失败：$(tail -c 300 "$STAGE/ef.err")"
fi
check_file() {
  local f="$1" want_bytes="$2" want_mode="$3" want_sha="$4"
  if [ ! -f "$f" ]; then bad "$f 不存在"; return; fi
  local b m s
  b=$(stat -c %s "$f"); m=$(stat -c %a "$f"); s=$(sha256sum "$f" | awk '{print $1}')
  [ "$b" = "$want_bytes" ] && ok "$f 大小 $b" || bad "$f 大小 $b ≠ $want_bytes"
  [ "$m" = "$want_mode" ]  && ok "$f 权限 $m"  || bad "$f 权限 $m ≠ $want_mode"
  [ "$s" = "$want_sha" ]   && ok "$f sha256 相符" || bad "$f sha256 不符 got=$s"
}
check_file /opt/1panel/runtime/python/attendance/.env    197 600 d85739bd0424670f751557f4ff0d39801fc2ee42c2966379890093ed08b007c0
check_file /opt/1panel/runtime/python/attendance/run.sh  50  644 03ea394af3f994916efdad799693afb3b8d638344f604d15a4a861868c8ab88b

echo
echo "=== STEP 7 属主 / 可执行位 ==="
for d in "/root/Documents/Obsidian Vault" /opt/web_cs /root/.hermes /root/attendance-system; do
  [ -e "$d" ] && { chown -R root:root "$d" 2>/dev/null && ok "$d → root:root" || bad "$d 属主失败"; }
done
[ -e /root/attendance-system ] && { chown -R 100:101 /root/attendance-system 2>/dev/null && ok "attendance-system → 100:101" || bad "attendance 属主失败"; }
chown -R 100:101 /opt/1panel/www 2>/dev/null; chmod -R a+rX /opt/1panel/www 2>/dev/null
find /opt/web_cs -maxdepth 2 -name '*.sh' -exec chmod +x {} \; 2>/dev/null
systemctl daemon-reload 2>/dev/null && ok "daemon-reload 完成" || bad "daemon-reload 失败"

echo
echo "=== STEP 8 内容级抽查 ==="
probe() { [ -e "$1" ] && ok "存在 $2" || bad "缺失 $2"; }
probe "/root/Documents/Obsidian Vault/AGENTS.md"          "vault/AGENTS.md"
probe "/opt/web_cs/server.py"                            "web-cs/server.py"
probe "/opt/web_cs/kb_config.json"                       "web-cs/kb_config.json"
probe "/root/.hermes/profiles/cs-main/.env"              "hermes-profile/.env"
probe "/root/.hermes/config.yaml"                        "hermes-home/config.yaml"
probe "/root/.hermes/auth.json"                          "hermes-home/auth.json"
probe "/root/.hermes/skills"                             "hermes-home/skills"
probe "/root/attendance-system/app.py"                   "attendance/app.py"
probe "/root/attendance-system/SECRET_KEY.txt"           "attendance/SECRET_KEY.txt"
probe "/opt/1panel/www/conf.d/www.toogel.cn.conf"        "web-stack/www conf"
probe "/opt/1panel/www/sites/www.toogel.cn/ssl/privkey.pem" "web-stack/privkey"
probe "/opt/1panel/www/sites/www.toogel.cn/index/llms.txt"  "web-stack/llms.txt"
probe "/opt/1panel/apps/openresty/openresty/1pwaf/data/sites/www.toogel.cn/config.json" "waf/sites"
probe "/opt/1panel/apps/openresty/openresty/1pwaf/data/conf/global.json" "waf/global.json"
probe "/opt/1panel/apps/openresty/openresty/1pwaf/data/db/waf" "waf/db"
probe "/etc/systemd/system/webchat.service"              "sys-units/webchat"
probe "/etc/systemd/system/socat-odoo-proxy.service"     "sys-units/socat"
[ -d /opt/1panel/apps/openresty/openresty/1pwaf/data/geo ] && note "waf/geo 目录存在（可能是本机原有的，非本次恢复）"
[ -f /opt/1panel/www/conf.d/odoo.toogel.cn.conf ] && ok "本机原有 odoo.toogel.cn.conf 仍在" || bad "本机原有 odoo.toogel.cn.conf 不见了"

echo
echo "=== STEP 9 恢复后服务完好性 ==="
docker ps --format '{{.Names}} {{.Status}}'
if curl -s -o /dev/null -w '%{http_code}' -H 'Host: odoo.toogel.cn' http://127.0.0.1:8069/web/login > /tmp/_code.txt; then
  c=$(cat /tmp/_code.txt); [ "$c" = "200" ] && ok "恢复后 Odoo 站点仍 200" || bad "恢复后 Odoo 站点 $c"
else
  bad "恢复后 Odoo 站点不可达"
fi

echo
echo "=== STEP 10 清点 ==="
cnt() { find "$1" -mindepth 1 2>/dev/null | wc -l; }
echo "vault=$(cnt "/root/Documents/Obsidian Vault") web-cs=$(cnt /opt/web_cs)"
echo "hermes-profile=$(cnt /root/.hermes/profiles/cs-main) hermes-home=$(cnt /root/.hermes)"
echo "web-stack=$(cnt /opt/1panel/www) sys-units=$(cnt /etc/systemd/system)"
echo "attendance=$(cnt /root/attendance-system) waf-data=$(cnt /opt/1panel/apps/openresty/openresty/1pwaf/data)"

echo
echo "=== RESULT === PASS=$PASS FAIL=$FAIL"
echo "回滚备份在 $PREBAK"
[ "$FAIL" -eq 0 ] || exit 1
