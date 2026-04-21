#!/bin/bash
# 在 Docker 容器中构建 Client 单文件 bundle。
# 产物：dist/cerelay-bundle.mjs（仅依赖 Node.js >= 18 即可运行）
#
# Build the Client as a single-file bundle inside Docker.
# Output: dist/cerelay-bundle.mjs (only requires Node.js >= 18 to run)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$CLIENT_DIR/.." && pwd)"
BUNDLE_OUTPUT="$CLIENT_DIR/dist/cerelay-bundle.mjs"
IMAGE="node:20-slim"
CONTAINER_NAME="cerelay-bundle-$$"

echo "=== Cerelay Client Docker Bundle ==="
echo "Using image: $IMAGE"
echo ""

# 启动临时构建容器 / Start temporary build container
docker run --rm -d \
  --name "$CONTAINER_NAME" \
  -v "$PROJECT_DIR":/workspace:ro \
  "$IMAGE" \
  bash -c "sleep 300" >/dev/null

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 在容器内执行构建 / Build inside container
docker exec "$CONTAINER_NAME" bash -c "
  set -euo pipefail

  # 复制源码到临时目录（挂载是只读的）/ Copy source to temp dir (mount is read-only)
  cp -r /workspace/client /tmp/client
  cd /tmp/client

  # 安装依赖 / Install dependencies
  echo '[1/3] Installing dependencies...'
  npm install --ignore-scripts 2>&1 | tail -1

  # 类型检查 / Type check
  echo '[2/3] Type checking...'
  npx tsc --noEmit

  # Bundle / Bundle
  echo '[3/3] Bundling with esbuild...'
  npx esbuild src/index.ts \
    --bundle \
    --platform=node \
    --target=node18 \
    --format=esm \
    --banner:js='import{createRequire}from\"module\";const require=createRequire(import.meta.url);' \
    --outfile=/tmp/cerelay-bundle.mjs

  echo ''
  echo 'Bundle size:'
  ls -lh /tmp/cerelay-bundle.mjs | awk '{print \"  \" \$5 \"  \" \$NF}'
"

# 提取产物 / Extract artifact
mkdir -p "$CLIENT_DIR/dist"
docker cp "$CONTAINER_NAME":/tmp/cerelay-bundle.mjs "$BUNDLE_OUTPUT"
chmod +x "$BUNDLE_OUTPUT"

echo ""
echo "=== Done ==="
echo "Output: $BUNDLE_OUTPUT"
echo ""
echo "Usage (only requires Node.js >= 18):"
echo "  node $BUNDLE_OUTPUT --help"
echo "  node $BUNDLE_OUTPUT --server localhost:8765"
echo ""
echo "Install to ~/.local/bin:"
echo "  cp $BUNDLE_OUTPUT ~/.local/bin/cerelay.mjs"
echo "  printf '#!/bin/sh\\nexec node \"\$HOME/.local/bin/cerelay.mjs\" \"\$@\"\\n' > ~/.local/bin/cerelay"
echo "  chmod +x ~/.local/bin/cerelay"
