# ============================================================
# Cerelay Server — Docker 镜像
# 基础镜像：Node.js 22 LTS（slim 变体减小体积）
# 内含：Node.js + claude CLI + cerelay-server TypeScript 依赖
# ============================================================

# ---- 依赖阶段：解析 workspace 并安装编译所需依赖 ----
FROM node:22-slim AS deps

WORKDIR /app

# 先复制 workspace 根配置，再复制各包 package.json，利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY web/package.json ./web/

# 安装所有依赖（包括 devDependencies 以便编译 TypeScript）
RUN npm ci

# ---- 构建阶段：复制源码并编译 server ----
FROM deps AS builder

COPY server/src ./server/src
COPY server/tsconfig.json ./server/

RUN npm run build --workspace server

# ---- 运行阶段：仅保留生产依赖和编译产物 ----
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/home/node

ARG SINGBOX_VERSION=1.11.4

# 运行阶段仍需完整 workspace 清单，否则 npm workspace 安装会失败
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY web/package.json ./web/

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fuse3 \
    iproute2 \
    libfuse2 \
    nftables \
    procps \
    python3 \
    python3-pip \
    util-linux \
  && pip3 install --break-system-packages fusepy \
  && ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in amd64) SB_ARCH=amd64;; arm64) SB_ARCH=arm64;; *) echo "unsupported arch: $ARCH" >&2; exit 1;; esac \
  && curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}.tar.gz" \
    | tar xzO "sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}/sing-box" > /usr/local/bin/sing-box \
  && chmod 0755 /usr/local/bin/sing-box \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --workspace server --include-workspace-root=false \
  && npm install -g @anthropic-ai/claude-code

COPY --from=builder /app/server/dist ./server/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker/socks-proxy-config.mjs /opt/cerelay/socks-proxy-config.mjs

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && chmod 0755 /opt/cerelay/socks-proxy-config.mjs \
  && mkdir -p /opt/cerelay-runtime \
  && mkdir -p /etc/sing-box \
  && mkdir -p /home/node/.claude \
  && chown -R root:root /app /home/node /opt/cerelay-runtime

# 暴露 WebSocket 端口（默认 8765）
EXPOSE 8765

# 健康检查：直接用 Node 发起 HTTP 请求，避免依赖 curl / shell 展开
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const port=Number(process.env.PORT||8765);const req=http.get({host:'127.0.0.1',port,path:'/health',timeout:4000},res=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});"]

# 容器入口
ENTRYPOINT ["docker-entrypoint.sh"]
