#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3007}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
PYTHON_BIN=""

if [[ -x ".venv/bin/python" ]]; then
  PYTHON_BIN=".venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "未找到 Python3。请先安装 Python 3。"
  read -r "?按回车退出..."
  exit 1
fi

if [[ ! -f "app.py" ]]; then
  echo "未找到 app.py，请确认脚本位于项目根目录。"
  read -r "?按回车退出..."
  exit 1
fi

if [[ "$PYTHON_BIN" == "python3" && ! -d ".venv" ]]; then
  echo "提示：未发现 .venv，正在使用系统 python3 启动。"
  echo "如缺少依赖，请先执行：pip3 install -r requirements.txt"
fi

echo "项目目录: $SCRIPT_DIR"
echo "启动地址: http://$BIND_HOST:$PORT"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

"$PYTHON_BIN" -u -c "from app import app; app.run(host='$BIND_HOST', port=$PORT, debug=False, use_reloader=False)" &
SERVER_PID=$!

# 给服务一个短暂启动时间，再打开浏览器
sleep 1
URL="http://$BIND_HOST:$PORT"
/usr/bin/open "$URL" >/dev/null 2>&1 || true

wait "$SERVER_PID"
