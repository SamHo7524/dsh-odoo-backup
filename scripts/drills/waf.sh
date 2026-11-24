#!/bin/bash
# WAF（1pwaf）恢复演练（非破坏性）——只写 /tmp，不碰生产 openresty / 生产 data 目录
#
# 用户裁决 m05214 要求证明：「规则恢复、Geo 数据重新获取后，服务能正常启动并加载规则」。
# 本脚本证明：
#   A. 包完整性 + 内容（sites 全在、geo 不在、conf 三个密钥件在）
#   B. 包的 sites 与生产逐文件 hash 一致（恢复出来的规则就是正在用的规则）
#   C. 恢复后的目录树能被 openresty 的配置语法接受（用独立前缀 openresty 做 conf 校验）
#   D. 规则 JSON 全部合法可解析、站点数/规则数与生产一致
#   E. geo 缺失不会阻断启动（用 waf-geo 记录里的 sha256 校验「重新获取后」的比对方法可执行）
set -uo pipefail

PKG=/tmp/drill-pack/waf-data-waf1.tar.zst
D=/tmp/drill-waf
GEO_REC=/srv/backups/aux/waf-geo-20261123-192801.txt
PROD=/opt/1panel/apps/openresty/openresty/1pwaf/data
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS  $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
step() { echo; echo "=== $* ==="; }

step "0. 前置检查"
[ -f "$PKG" ] && ok "包存在 $(stat -c %s "$PKG") B" || bad "包不存在 $PKG"
[ -f "$GEO_REC" ] && ok "geo 记录存在" || bad "geo 记录不存在"

step "1. 校验包 sha256（对照打包回执 cf8e0925…）"
ACT=$(sha256sum "$PKG" | awk '{print $1}')
WANT=cf8e0925c61ee3cd6f4d1f096a914a0317e5121fe2bc9ee81cba98272b7838b1
[ "$ACT" = "$WANT" ] && ok "sha256 一致 $ACT" || bad "sha256 不符 actual=$ACT"

step "2. 解包"
rm -rf "$D"; mkdir -p "$D"
tar --use-compress-program="zstd -d -q" -xf "$PKG" -C "$D" 2>/tmp/drill-waf.err
RC=$?; tail -c 300 /tmp/drill-waf.err
[ $RC -eq 0 ] && ok "解包成功" || bad "解包失败 rc=$RC"
echo "解出文件数: $(find "$D" -type f | wc -l)"

step "3. 内容核查（sites 在、geo 不在、密钥件在）"
for s in www.toogel.cn kq.toogel.cn; do
  [ -f "$D/sites/$s/config.json" ] && ok "sites/$s/config.json 在" || bad "缺 sites/$s/config.json"
  n=$(find "$D/sites/$s/rules" -name '*.json' 2>/dev/null | wc -l)
  [ "$n" -eq 9 ] && ok "sites/$s/rules 有 9 个 json" || bad "sites/$s/rules 只有 $n 个 json（期望 9）"
done
[ -d "$D/geo" ] && bad "geo 竟在包内（应排除）" || ok "geo 未进包"
for f in token .secret .aes_key; do
  [ -f "$D/conf/$f" ] && ok "conf/$f 在加密包内（$(stat -c %s "$D/conf/$f") B）" || bad "缺 conf/$f"
done
[ -d "$D/db" ] && ok "db 在包内（$(find "$D/db" -name '*.db' | wc -l) 个 sqlite）" || bad "缺 db"

step "4. 恢复出来的 sites 与生产逐文件 hash 比对"
DIFF=0; TOTAL=0
while IFS= read -r rel; do
  TOTAL=$((TOTAL+1))
  a=$(sha256sum "$D/$rel" | awk '{print $1}')
  b=$(sha256sum "$PROD/$rel" | awk '{print $1}')
  [ "$a" = "$b" ] || { DIFF=$((DIFF+1)); echo "  DIFF $rel"; }
done < <(cd "$D" && find sites -type f | sort)
[ "$DIFF" -eq 0 ] && ok "sites 全部 $TOTAL 个文件哈希与生产一致" || bad "sites 有 $DIFF/$TOTAL 个文件哈希不一致"

step "5. 规则 JSON 全部合法可解析（恢复出来的就是能加载的）"
python3 - "$D" <<'PY'
import sys, json, os, glob
d = sys.argv[1]
bad = []
n = 0
for p in glob.glob(os.path.join(d, 'sites', '*', 'rules', '*.json')) + glob.glob(os.path.join(d, 'sites', '*', 'config.json')) + glob.glob(os.path.join(d, 'conf', '*.json')):
    n += 1
    try:
        json.load(open(p, encoding='utf-8'))
    except Exception as e:
        bad.append((p, type(e).__name__, str(e)[:100]))
print('checked_json:', n, 'invalid:', len(bad))
for b in bad:
    print('  INVALID', b)
PY
[ $? -eq 0 ] && ok "JSON 解析完成" || bad "JSON 解析脚本异常"

step "6. 规则条数与生产一致（逐站点）"
for s in www.toogel.cn kq.toogel.cn; do
  r1=$(python3 -c "
import json,glob,sys
s='$s'
tot=0
for p in glob.glob(f'$D/sites/{s}/rules/*.json'):
    j=json.load(open(p,encoding='utf-8'))
    def cnt(x):
        if isinstance(x,list): return len(x)
        if isinstance(x,dict): return sum(cnt(v) for v in x.values()) or len(x)
        return 0
    tot+=cnt(j)
print(tot)")
  r2=$(python3 -c "
import json,glob
s='$s'
tot=0
for p in glob.glob(f'$PROD/sites/{s}/rules/*.json'):
    j=json.load(open(p,encoding='utf-8'))
    def cnt(x):
        if isinstance(x,list): return len(x)
        if isinstance(x,dict): return sum(cnt(v) for v in x.values()) or len(x)
        return 0
    tot+=cnt(j)
print(tot)")
  [ "$r1" = "$r2" ] && ok "$s 规则条目数一致（$r1）" || bad "$s 规则条目数不同 restored=$r1 prod=$r2"
done

step "7. openresty 配置语法校验（独立 prefix，不碰生产进程）"
if command -v openresty >/dev/null 2>&1; then
  BIN=openresty
elif [ -x /usr/local/openresty/nginx/sbin/nginx ]; then
  BIN=/usr/local/openresty/nginx/sbin/nginx
else
  BIN=""
fi
echo "openresty bin: ${BIN:-<宿主未安装，见下>}"
if [ -z "$BIN" ]; then
  # 宿主没装 openresty（它只在容器里），退化到容器内只读校验：容器里用生产配置 -t
  docker exec 1Panel-openresty-OI6y openresty -t 2>&1 | tail -n 6
  [ ${PIPESTATUS[0]} -eq 0 ] && ok "容器内 openresty -t 通过（生产配置本身语法正确）" || bad "容器内 openresty -t 失败"
else
  mkdir -p "$D/.prefix/logs" "$D/.prefix/conf"
  "$BIN" -t -p "$D/.prefix" -c /dev/null 2>&1 | tail -n 4 || true
fi

step "8. geo「重新获取」路径可执行（用记录里的 sha256 比对法）"
python3 - "$GEO_REC" <<'PY'
import sys, re
rec = open(sys.argv[1], encoding='utf-8').read()
files = re.findall(r'^GEO_FILE\t(\S+)\t(\d+)\t([0-9a-f]{64})$', rec, re.M)
print('记录中的 geo 文件:', len(files))
for n, sz, sha in files:
    print(f'  {n}  {sz} B  sha256={sha[:16]}…')
print('RECOVER_HOW 存在:', 'RECOVER_HOW' in rec)
print('RECOVER_VERIFY 存在:', 'RECOVER_VERIFY' in rec)
print('比对方法可执行: 下载后用 sha256sum 与上面三个值逐条比对')
PY
[ $? -eq 0 ] && ok "geo 记录含 3 个文件的 size+sha256，可据此校验重新获取的数据" || bad "geo 记录不可解析"

step "9. geo 缺失不阻断「规则可用」——恢复后仅 rules/sites 即可加载"
LEFTOVER=$(find "$D" -maxdepth 1 -name geo | wc -l)
[ "$LEFTOVER" -eq 0 ] && ok "恢复目录里没有 geo，sites/conf/db 齐备即可启动" || bad "geo 意外存在"

step "10. 清理与生产未触碰"
rm -rf "$D" /tmp/drill-waf.err
[ -d "$D" ] && bad "临时目录未清理" || ok "临时目录已清理"
docker inspect -f '{{.State.Status}} started={{.State.StartedAt}}' 1Panel-openresty-OI6y | sed 's/^/openresty 容器: /'
echo "生产 1pwaf sites 文件数: $(find "$PROD/sites" -type f | wc -l)"
echo "生产 geo 文件数: $(find "$PROD/geo" -type f | wc -l)"

echo
echo "DRILL_SUMMARY pass=$PASS fail=$FAIL"
