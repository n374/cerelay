import { exec } from "node:child_process";

// ============================================================
// 输入/输出类型定义（与 Go internal/hand/tools_bash.go 对齐）
// ============================================================

export interface BashInput {
  command: string;
  timeout?: number;
}

export interface BashOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
}

const DEFAULT_BASH_TIMEOUT = 120; // 秒

// ============================================================
// Bash 工具实现
// ============================================================

// 通过系统 sh 执行命令，返回 stdout/stderr/exit_code
export async function executeBash(
  input: BashInput,
  cwd: string
): Promise<BashOutput> {
  if (!input.command) {
    throw new Error("Bash 缺少 command");
  }

  const timeoutSeconds =
    input.timeout !== undefined ? input.timeout : DEFAULT_BASH_TIMEOUT;

  if (timeoutSeconds <= 0) {
    throw new Error("Bash 的 timeout 必须大于 0");
  }

  const timeoutMs = timeoutSeconds * 1000;

  return new Promise<BashOutput>((resolve) => {
    exec(
      input.command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        shell: "/bin/bash",
        killSignal: "SIGTERM",
      },
      (error, stdout, stderr) => {
        // exec timeout 会设置 error.killed = true
        if (error && (error as any).killed) {
          // 超时：保留已采集的输出
          resolve({
            stdout: stdout + `\n[超时截断: ${timeoutSeconds}s]`,
            stderr,
            exit_code: 124, // 与 Go 的 timeout exit code 对齐
          });
          return;
        }

        // 正常完成（包括非零退出码）
        resolve({
          stdout,
          stderr,
          exit_code: error ? (error as any).code ?? 1 : 0,
        });
      }
    );
  });
}
