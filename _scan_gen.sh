
set -uo pipefail
read -r ADDONS

echo "===MODULES==="
if [ -d "$ADDONS" ]; then
  find "$ADDONS" -maxdepth 2 -name '__manifest__.py' 2>/dev/null | while read -r m; do
    dirname "$m"
  done
else
  echo "ADDONS_MISSING"
fi

echo "===IMPORTS==="
if [ -d "$ADDONS" ]; then
  find "$ADDONS" -maxdepth 3 -name '*.py' 2>/dev/null | while read -r f; do
    rel="${f#"$ADDONS"/}"
    # 顶层 import：行首无空白，且不是续行
    grep -hE '^(import|from)[[:space:]]' "$f" 2>/dev/null | while IFS= read -r line; do
      # 带上文件归属：调用方要按「哪个模块的哪个文件」判断本地兄弟名，
      # 旧的裸行协议分不清 tests/ 里的 import 与运行时 import（v0.3.0 修）
      printf 'IMP\t%s\t%s\n' "$rel" "$line"
    done
  done
fi

echo "===END==="
