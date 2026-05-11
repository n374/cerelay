<!-- doc-init template version: v1.0 -->
# PTY / Shell 支持 / PTY Session

> **Owner**: server 架构组
> **Reviewers**: 全员

**文件**：`server/src/pty-session.ts`、`server/src/pty-host-script.ts`

- 为复杂 Shell 操作提供 PTY
- 支持交互式命令（如 `git`、`npm` 交互式提示）
- 通过 host script 与 Client 交互

## 关联资源

- [架构总览](../README.md)
- [Shadow MCP & Hook 拦截](./shadow-mcp.md)
- [Session Runtime](./session-runtime.md)
