#!/usr/bin/env bash
# ============================================================================
# init-proxy.sh — Tool Proxy 初始化脚本
#
# 功能：
#   1. 创建所有必要目录
#   2. 扫描项目中的敏感文件，生成脱敏副本到 proxy-data/mock/
#   3. 更新 .gitignore
#   4. 设置脚本可执行权限
#   5. 输出报告
#
# 用法：bash .claude/proxy/init-proxy.sh [-f] [project_dir]
#
# 幂等：重复运行不会破坏已有的 mock 数据或自定义代理脚本。
#       已有 mock 文件不会被覆盖（用 -f 参数强制覆盖）。
# ============================================================================
set -euo pipefail

FORCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) FORCE="-f"; shift ;;
    *)  CLAUDE_PROJECT_DIR="$1"; shift ;;
  esac
done

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROXY_DIR="$PROJECT_DIR/.claude/proxy"
DATA_DIR="$PROJECT_DIR/.claude/proxy-data"
MOCK_DIR="$DATA_DIR/mock"
PATTERNS_FILE="$PROXY_DIR/sensitive-patterns.txt"

echo "=== Tool Proxy 初始化 ==="
echo "项目目录: $PROJECT_DIR"
echo ""

# --- 1. 创建目录 ---
echo "📁 创建目录结构..."
mkdir -p "$PROXY_DIR" "$MOCK_DIR" "$DATA_DIR"
echo "  ✓ proxy/"
echo "  ✓ proxy-data/mock/"

# --- 2. 设置可执行权限 ---
echo ""
echo "🔧 设置脚本权限..."
for f in "$PROXY_DIR"/*.sh; do
  if [[ -f "$f" ]]; then
    chmod +x "$f"
    echo "  ✓ $(basename "$f")"
  fi
done

# --- 3. 扫描敏感文件并生成 mock ---
echo ""
echo "🔍 扫描敏感文件..."

# 加载模式
if [[ -f "$PATTERNS_FILE" ]]; then
  PATTERNS=$(grep -v '^[[:space:]]*$' "$PATTERNS_FILE" | grep -v '^#' | tr '\n' '|' | sed 's/|$//')
else
  PATTERNS='\.env$|\.env\.|secrets/|credentials/|private/|\.pem$|\.key$|\.p12$|\.jks$|\.pfx$|config/prod|config/production'
fi

MOCK_COUNT=0
SKIP_COUNT=0

# 扫描项目目录（排除 .git, node_modules, .claude 等）
while IFS= read -r filepath; do
  [[ -z "$filepath" ]] && continue
  [[ ! -f "$filepath" ]] && continue

  # 计算相对路径
  rel_path="${filepath#"$PROJECT_DIR"/}"
  mock_path="$MOCK_DIR/$rel_path"

  # 幂等：已有 mock 不覆盖（除非 -f）
  if [[ -f "$mock_path" ]] && [[ "$FORCE" != "-f" ]]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    echo "  ⏭ $rel_path (已有 mock，跳过)"
    continue
  fi

  # 创建 mock 目录
  mkdir -p "$(dirname "$mock_path")"

  # 根据文件类型生成脱敏副本
  case "$filepath" in
    *.env|*.env.*)
      # .env 文件：保留键名，值替换为 <REDACTED>
      sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1=<REDACTED>/' "$filepath" > "$mock_path"
      ;;
    *.json)
      # JSON 文件：jq 替换敏感键值
      if command -v jq &>/dev/null; then
        jq '
          walk(
            if type == "object" then
              with_entries(
                if (.key | test("password|secret|token|key|credential|api_key"; "i"))
                then .value = "<REDACTED>"
                else .
                end
              )
            else .
            end
          )
        ' "$filepath" > "$mock_path" 2>/dev/null || cp "$filepath" "$mock_path"
      else
        # 无 jq 时用 sed 粗略替换
        sed -E 's/("(password|secret|token|key|credential|api_key)"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"<REDACTED>"/gi' \
          "$filepath" > "$mock_path"
      fi
      ;;
    *.yaml|*.yml)
      # YAML 文件：sed 替换敏感键后的值
      sed -E 's/(^[[:space:]]*(password|secret|token|key|credential|api_key)[[:space:]]*:[[:space:]]*).+/\1<REDACTED>/i' \
        "$filepath" > "$mock_path"
      ;;
    *.pem|*.key|*.p12|*.pfx|*.jks)
      # 证书/密钥文件：替换为占位符
      echo "# REDACTED: This file has been sanitized by Tool Proxy" > "$mock_path"
      echo "# Original: $rel_path" >> "$mock_path"
      ;;
    *)
      # 其他文件：完整复制（用户可手动编辑脱敏）
      cp "$filepath" "$mock_path"
      echo "  ⚠ $rel_path (已复制，请手动检查脱敏)"
      MOCK_COUNT=$((MOCK_COUNT + 1))
      continue
      ;;
  esac

  echo "  ✓ $rel_path → mock/$rel_path"
  MOCK_COUNT=$((MOCK_COUNT + 1))

done < <(find "$PROJECT_DIR" \
  -not -path '*/.git/*' \
  -not -path '*/.claude/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/vendor/*' \
  -not -path '*/__pycache__/*' \
  -type f 2>/dev/null | grep -iE "$PATTERNS" 2>/dev/null || true)

echo ""
echo "  生成 mock: $MOCK_COUNT 个文件"
echo "  跳过: $SKIP_COUNT 个文件（已存在）"

# --- 4. 更新 .gitignore ---
echo ""
echo "📝 检查 .gitignore..."
GITIGNORE="$PROJECT_DIR/.gitignore"

add_to_gitignore() {
  local pattern="$1"
  if [[ -f "$GITIGNORE" ]]; then
    if ! grep -qF "$pattern" "$GITIGNORE"; then
      echo "$pattern" >> "$GITIGNORE"
      echo "  ✓ 添加: $pattern"
    else
      echo "  ⏭ 已存在: $pattern"
    fi
  else
    echo "$pattern" > "$GITIGNORE"
    echo "  ✓ 创建 .gitignore 并添加: $pattern"
  fi
}

add_to_gitignore ".claude/proxy-data/"

# --- 5. 报告 ---
echo ""
echo "=== 初始化完成 ==="
echo ""
echo "启用代理的方法："
echo "  1. 复制需要的代理脚本（去掉 .example 后缀）："
echo "     cd $PROXY_DIR"
echo "     cp Read.sh.example Read.sh"
echo "     cp Bash.sh.example Bash.sh"
echo "     # ... 按需启用"
echo ""
echo "  2. 复制 hook 配置到项目的 settings.local.json："
echo "     cp $PROXY_DIR/settings.local.json.example $PROJECT_DIR/.claude/settings.local.json"
echo ""
echo "  3. 重启 Claude Code 使 hook 生效"
echo ""
echo "  提示：编辑 sensitive-patterns.txt 可调整敏感文件范围"
