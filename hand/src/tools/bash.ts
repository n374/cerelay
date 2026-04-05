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

  return new Promise<BashOutput>((resolve, reject) => {
    const timeoutMs = timeoutSeconds * 1000;
    let timedOut = false;

    const child = exec(
      input.command,
      {
        shell: "/bin/sh",
        cwd,
        timeout: timeoutMs,
        // exec 的 timeout 会在超时后 kill 进程，killSignal 默认 SIGTERM
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    // 设置手动超时检测标志
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      // 超时后 exec 会 kill 进程，signal 为 SIGTERM 或 SIGKILL
      if (timedOut || signal === "SIGTERM" || signal === "SIGKILL") {
        reject(
          new Error(`Bash 执行超时: ${timeoutSeconds} 秒`)
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        // 非零退出码不算错误，与 Go 实现保持一致
        exit_code: code ?? 0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`执行 Bash 命令失败: ${err.message}`));
    });
  });
}
