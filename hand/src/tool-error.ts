export class ToolError extends Error {
  code: string;
  tool: string;

  constructor(code: string, tool: string, message: string) {
    super(`${code}(${tool}): ${message}`);
    this.name = "ToolError";
    this.code = code;
    this.tool = tool;
  }

  toJSON(): object {
    return {
      code: this.code,
      tool: this.tool,
      message: this.message,
    };
  }
}
