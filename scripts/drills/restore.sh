#!/bin/bash
# attendance 恢复演练（非破坏性）——只写 /tmp，不碰生产容器/生产目录
# 步骤：校验包 → 解包 → 用 L2 一致性快照当数据库 → 建 venv 装依赖
#       → 用包内 SECRET_KEY.txt 启动 gunicorn(127.0.0.1:18080) → HTTP 验证 → 清理
set -uo pipefail

PKG=/tmp/drill-pack/attendance-system-drill1.tar.zst
SNAP=/tmp/drill-attendance/attendance-snapshot-20261123-192801.db
D=/tmp/drill-restore
PORT=18080
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS  $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
step() { echo; echo "=== $* ==="; }

step "0. 前置检查"
[ -f "$PKG" ]  && ok "包存在 $(stat -c %s "$PKG") B" || bad "包不存在 $PKG"
[ -f "$SNAP" ] && ok "L2 快照存在 $(stat -c %s "$SNAP") B" || bad "快照不存在 $SNAP"
command -v zstd >/dev/null && ok "zstd 可用 $(zstd --version 2>/dev/null | head -n1)" || bad "zstd 不可用"
command -v gunicorn >/dev/null || true

step "1. 校验包 sha256（对照打包回执 7b99a8b1…）"
ACT=$(sha256sum "$PKG" | awk '{print $1}')
WRAP_KIT=7b99a8b17832380d91de39faa3d011cd49eabb3f852403b5e0dcba38bf3774a6
[ "$ACT" = "$WRAP_KIT" ] && ok "sha256 与打包回执一致 $ACT" || bad "sha256 不符 actual=$ACT"

step "2. 解包"
rm -rf "$D"; mkdir -p "$D"
tar --use-compress-program="zstd -d -q" -xf "$PKG" -C "$D" 2>/tmp/drill.tar.err
RC=$?
tail -c 300 /tmp/drill.tar.err
[ $RC -eq 0 ] && ok "解包成功" || bad "解包失败 rc=$RC"
N=$(find "$D" -type f | wc -l)
echo "解出文件数: $N"
for f in app.py config.py db.py auth.py requirements.txt requirements-full.txt SECRET_KEY.txt templates static; do
  [ -e "$D/$f" ] && ok "存在 $f" || bad "缺失 $f"
done
[ -d "$D/venv" ] && bad "venv 竟然在包里（应被排除）" || ok "venv 未进包"
[ -f "$D/attendance.db" ] && bad "活动数据库竟在包里（应走一致性快照）" || ok "attendance.db 未直接进包"
[ -d "$D/.git" ] && ok ".git 在包内（$(find "$D/.git" -type f | wc -l) 个文件）" || bad ".git 不在包内"

step "3. 用 L2 一致性快照作为恢复库"
cp -f "$SNAP" "$D/attendance.db"
python3 - "$D/attendance.db" <<'PY'
import sys, sqlite3, json
p = sys.argv[1]
con = sqlite3.connect(f'file:{p}?mode=ro', uri=True); cur = con.cursor()
print('integrity_check:', cur.execute('PRAGMA integrity_check').fetchone()[0])
tabs = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print('counts:', json.dumps({t: cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tabs}, ensure_ascii=False, sort_keys=True))
row = cur.execute('SELECT * FROM attendance LIMIT 1').fetchone()
print('sample_row_cols:', len(row) if row else 0)
con.close()
PY
[ $? -eq 0 ] && ok "快照作为恢复库可读" || bad "快照不可读"

step "4. 建 venv 并安装依赖（requirements-full.txt）"
python3 -m venv "$D/venv" >/tmp/drill.venv.log 2>&1
[ -x "$D/venv/bin/python" ] && ok "venv 建好 $("$D/venv/bin/python" -V 2>&1)" || bad "venv 创建失败"
"$D/venv/bin/pip" install -q -r "$D/requirements-full.txt" >/tmp/drill.pip.log 2>&1
PIPRC=$?
[ $PIPRC -eq 0 ] && ok "依赖安装成功" || { bad "依赖安装失败 rc=$PIPRC"; tail -n 15 /tmp/drill.pip.log; }

step "5. 关键依赖可导入性（weasyprint 需要系统库）"
"$D/venv/bin/python" - <<'PY' 2>&1 | tail -n 12
mods = ['flask', 'gunicorn', 'werkzeug', 'flask_session', 'sqlalchemy', 'weasyprint']
for m in mods:
    try:
        __import__(m); print('IMPORT_OK', m)
    except Exception as e:
        print('IMPORT_FAIL', m, type(e).__name__, str(e)[:160])
PY

step "6. 用包内 SECRET_KEY.txt 启动（不打印值）"
cd "$D" || exit 1
set -a
# shellcheck disable=SC1091
. "$D/SECRET_KEY.txt"
set +a
export DATABASE="$D/attendance.db"
export DEBUG=false
echo "SECRET_KEY 已从包内载入，长度=${#SECRET_KEY}"
"$D/venv/bin/python" -c "
from config import Config
print('flask_uses_default=', Config.SECRET_KEY == 'change-this-in-production-please')
print('secret_len=', len(Config.SECRET_KEY))
print('database=', Config.DATABASE)
print('debug=', Config.DEBUG)
"

"$D/venv/bin/gunicorn" -w 1 -b "127.0.0.1:$PORT" app:app >/tmp/drill.gunicorn.log 2>&1 &
GPID=$!
echo "gunicorn pid=$GPID 端口=$PORT"
for i in $(seq 1 30); do
  sleep 1
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" 2>/dev/null; then break; fi
done
if kill -0 "$GPID" 2>/dev/null; then ok "gunicorn 进程存活"; else bad "gunicorn 已退出"; tail -n 25 /tmp/drill.gunicorn.log; fi

step "7. HTTP 验证"
C1=$(curl -sS -o /tmp/drill.login.html -w '%{http_code}' "http://127.0.0.1:$PORT/login")
[ "$C1" = "200" ] && ok "GET /login → 200（$(stat -c %s /tmp/drill.login.html) B）" || bad "GET /login → $C1"
grep -qi '登录\|password\|用户名' /tmp/drill.login.html && ok "登录页含预期文案" || bad "登录页文案异常"
C2=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dashboard")
[ "$C2" = "302" ] && ok "GET /dashboard 未登录 → 302（鉴权生效）" || bad "GET /dashboard → $C2（期望 302）"
C3=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/attendance")
[ "$C3" = "302" ] && ok "GET /attendance 未登录 → 302" || bad "GET /attendance → $C3"

step "8. 恢复库数据可读（经应用同一份 DB 文件）"
python3 - "$D/attendance.db" <<'PY'
import sys, sqlite3, json
con = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True); cur = con.cursor()
for t in ['attendance', 'members', 'users', 'roles', 'settings']:
    n = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    print(f'{t}: {n}')
r = cur.execute('SELECT * FROM attendance ORDER BY rowid DESC LIMIT 1').fetchone()
print('latest_attendance_rowid_cols:', len(r) if r else 0)
con.close()
PY

step "9. 清理（停进程、删临时目录）"
kill "$GPID" 2>/dev/null; wait "$GPID" 2>/dev/null
pkill -f "gunicorn.*:$PORT" 2>/dev/null
sleep 1
ss -lntp 2>/dev/null | grep -q ":$PORT" && bad "端口 $PORT 仍被占用" || ok "端口 $PORT 已释放"
rm -rf "$D" /tmp/drill.login.html /tmp/drill.pip.log /tmp/drill.venv.log /tmp/drill.gunicorn.log /tmp/drill.tar.err
[ -d "$D" ] && bad "临时目录未清理" || ok "临时目录已清理"

step "10. 生产未被触碰"
systemctl is-active --quiet webchat && ok "webchat 仍 active" || bad "webchat 异常"
docker inspect -f '{{.State.Status}} started={{.State.StartedAt}}' attendance | sed 's/^/attendance 容器: /'
md5sum /root/attendance-system/attendance.db | awk '{print "生产 attendance.db md5:", $1}'
ls -1 /root/attendance-system/attendance.db* | sed 's/^/  /'

echo
echo "DRILL_SUMMARY pass=$PASS fail=$FAIL"
