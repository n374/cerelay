#!/bin/bash
# 安装 cerelay 命令到 ~/.local/bin
# Install cerelay CLI to ~/.local/bin

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_LIB="$HOME/.local/lib/cerelay"
INSTALL_BIN="$HOME/.local/bin"

cd "$CLIENT_DIR"

# 编译 / Build
echo "Building..."
npm run build

# 仅安装生产依赖到临时目录 / Install production deps
echo "Preparing production dependencies..."
TEMP_DIR=$(mktemp -d)
cp package.json "$TEMP_DIR/"
(cd "$TEMP_DIR" && npm install --omit=dev --ignore-scripts 2>/dev/null)

# 复制到 ~/.local/lib/cerelay / Copy to install dir
echo "Installing to $INSTALL_LIB ..."
mkdir -p "$INSTALL_LIB" "$INSTALL_BIN"
rm -rf "$INSTALL_LIB"
mkdir -p "$INSTALL_LIB"
cp -r dist package.json "$INSTALL_LIB/"
cp -r "$TEMP_DIR/node_modules" "$INSTALL_LIB/"
rm -rf "$TEMP_DIR"

# 写 wrapper 脚本 / Write wrapper script
cat > "$INSTALL_BIN/cerelay" << 'WRAPPER'
#!/bin/sh
exec node "$HOME/.local/lib/cerelay/dist/index.js" "$@"
WRAPPER
chmod +x "$INSTALL_BIN/cerelay"

echo ""
echo "Installed: $INSTALL_BIN/cerelay"
echo ""

# 检查 PATH / Check PATH
case ":$PATH:" in
  *":$INSTALL_BIN:"*) ;;
  *)
    echo "WARNING: $INSTALL_BIN is not in your PATH."
    echo "Add this to your ~/.zshrc or ~/.bashrc:"
    echo ""
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    ;;
esac
