#!/bin/bash
# WAF 恢复演练·真加载版（非破坏性）
#
# 目的：证明「规则恢复 + geo 重新获取后，服务能正常启动并加载规则」(m05214 第④条)。
# 做法：用一次性容器 1panel/openresty，把「恢复出来的 data 目录」挂进去，让真实
#       openresty + 1pwaf 去加载它 —— 而不是只看文件在不在。
#
# 两个场景：
#   S1：只有备份里有的东西（sites/conf/db/rules，**没有 geo**）
#       → 回答「恢复后第一刻能不能起来」
#   S2：再把 geo 从生产复制一份进来（模拟「重新获取 geo」）
#       → 回答「补齐 geo 后能不能正常加载规则并拦截」
#
# 安全：端口只绑 127.0.0.1，容器名带 drill 前缀，结束即删；生产 openresty 全程不碰。
set -uo pipefail

PKG=/tmp/drill-pack/waf-data-waf1.tar.zst
BASE=/tmp/drill-waf
D1=$BASE/data-nogeo
D2=$BASE/data-withgeo
PROD=/opt/1panel/apps/openresty/openresty/1pwaf/data
IMG=1panel/openresty:1.31.1.1-2-1-noble
PORT1=18081
PORT2=18082
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS  $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
step() { echo; echo "=== $* ==="; }

cleanup() {
  docker rm -f dsh-drill-waf-nogeo dsh-drill-waf-withgeo >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "0. 准备两份恢复目录"
cleanup
rm -rf "$BASE"; mkdir -p "$D1" "$D2"
tar --use-compress-program="zstd -d -q" -xf "$PKG" -C "$D1" 2>/dev/null
[ -d "$D1/sites" ] && ok "S1 目录（无 geo）就绪，文件 $(find "$D1" -type f | wc -l) 个" || bad "S1 解包失败"
cp -a "$D1/." "$D2/"
[ -d "$PROD/geo" ] && cp -a "$PROD/geo" "$D2/geo" && ok "S2 目录已补 geo（$(find "$D2/geo" -type f | wc -l) 个文件，$(du -sb "$D2/geo" | awk '{print $1}') B）" || bad "生产 geo 不存在，无法构造 S2"
[ ! -d "$D1/geo" ] && ok "S1 确实没有 geo（备份排除生效）" || bad "S1 意外有 geo"
chmod -R a+rX "$BASE"

step "S1. 只有备份内容（无 geo）—— 恢复后第一刻能起来吗"
docker run -d --rm --name dsh-drill-waf-nogeo \
  -p "127.0.0.1:$PORT1:80" \
  -v "$D1:/usr/local/openresty/1pwaf/data:ro" \
  "$IMG" >/dev/null 2>&1
SLEEP=0
for i in $(seq 1 15); do
  sleep 1; SLEEP=$i
  ST=$(docker inspect -f '{{.State.Status}}' dsh-drill-waf-nogeo 2>/dev/null || echo gone)
  [ "$ST" != "running" ] && break
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT1/" 2>/dev/null; then break; fi
done
ST=$(docker inspect -f '{{.State.Status}}' dsh-drill-waf-nogeo 2>/dev/null || echo gone)
echo "状态: $ST  （等待 ${SLEEP}s）"
if [ "$ST" = "running" ]; then
  ok "S1 容器 running —— 没有 geo 也能启动"
  C=$(curl -sS -o /tmp/s1.out -w '%{http_code}' "http://127.0.0.1:$PORT1/" 2>/dev/null || echo 000)
  echo "S1 HTTP: $C"
  docker exec dsh-drill-waf-nogeo openresty -t 2>&1 | tail -n 3
else
  bad "S1 容器未运行（$ST）"
  echo "--- S1 日志 ---"
  docker logs dsh-drill-waf-nogeo 2>&1 | tail -n 25
fi

step "S2. 补齐 geo 后 —— 规则能加载并拦截吗"
docker run -d --rm --name dsh-drill-waf-withgeo \
  -p "127.0.0.1:$PORT2:80" \
  -v "$D2:/usr/local/openresty/1pwaf/data:ro" \
  "$IMG" >/dev/null 2>&1
SLEEP=0
for i in $(seq 1 15); do
  sleep 1; SLEEP=$i
  ST2=$(docker inspect -f '{{.State.Status}}' dsh-drill-waf-withgeo 2>/dev/null || echo gone)
  [ "$ST2" != "running" ] && break
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT2/" 2>/dev/null; then break; fi
done
ST2=$(docker inspect -f '{{.State.Status}}' dsh-drill-waf-withgeo 2>/dev/null || echo gone)
echo "状态: $ST2  （等待 ${SLEEP}s）"
if [ "$ST2" = "running" ]; then
  ok "S2 容器 running —— 补齐 geo 后启动成功"
  echo "--- openresty -t ---"
  docker exec dsh-drill-waf-withgeo openresty -t 2>&1 | tail -n 4
  echo "--- HTTP 探针 ---"
  for path in "/" "/login" "/?id=1%27%20OR%20%271%27%3D%271" "/../../etc/passwd"; do
    C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT2$path" 2>/dev/null || echo 000)
    echo "  $path → $C"
  done
  echo "--- 容器日志（1pwaf 加载痕迹）---"
  docker logs dsh-drill-waf-withgeo 2>&1 | grep -iE "error|waf|1pwaf|rule|geo|lua" | tail -n 20
  # 只统计「1pwaf/lua 加载失败」类错误。普通 404（open() ... failed (2: No such file
  # or directory)）是探针访问不存在路径造成的，与规则加载无关，不能算失败。
  ERRS=$(docker logs dsh-drill-waf-withgeo 2>&1 \
    | grep -iE "\[error\]|failed to load|lua entry thread aborted" \
    | grep -viE "open\(\) .* failed \(2: No such file or directory\)" \
    | grep -ciE "error|failed" || true)
  [ "${ERRS:-0}" -eq 0 ] && ok "S2 无 1pwaf/lua 加载错误（排除普通 404 后 errcount=$ERRS）" || bad "S2 有 $ERRS 条加载类错误"
else
  bad "S2 容器未运行（$ST2）"
  echo "--- S2 日志 ---"
  docker logs dsh-drill-waf-withgeo 2>&1 | tail -n 25
fi

step "3. 两场景对比结论"
echo "S1(无 geo): $ST"
echo "S2(有 geo): $ST2"
if [ "$ST" = "running" ]; then
  echo "结论：geo 缺失不阻断启动 —— 恢复顺序可以「先恢复规则，后补 geo」"
else
  echo "结论：geo 缺失会阻断启动 —— 恢复时必须先补齐 geo 再启动（这一点要写进恢复手册）"
fi

step "4. 清理"
cleanup
for p in $PORT1 $PORT2; do
  ss -lnt 2>/dev/null | grep -q ":$p " && bad "端口 $p 仍占用" || ok "端口 $p 已释放"
done
rm -rf "$BASE" /tmp/s1.out
[ -d "$BASE" ] && bad "临时目录未清理" || ok "临时目录已清理"
docker ps --format '{{.Names}}' | grep -q drill && bad "仍有 drill 容器残留" || ok "无 drill 容器残留"
docker inspect -f '{{.State.Status}} started={{.State.StartedAt}}' 1Panel-openresty-OI6y | sed 's/^/生产 openresty: /'

echo
echo "DRILL_SUMMARY pass=$PASS fail=$FAIL"
