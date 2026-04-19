import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadClaudeMcpServerConfigs } from "../src/claude-mcp-config.js";

test("loadClaudeMcpServerConfigs merges Claude global and local settings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cerelay-claude-mcp-config-"));
  const homeDir = path.join(root, "home");
  const workspaceDir = path.join(root, "workspace");
  const claudeDir = path.join(homeDir, ".claude");
  const workspaceClaudeDir = path.join(workspaceDir, ".claude");
  const previousHome = process.env.HOME;

  t.after(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(claudeDir, { recursive: true });
  await mkdir(workspaceClaudeDir, { recursive: true });

  await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({
    mcpServers: {
      shared: {
        type: "http",
        url: "http://global.example/mcp",
      },
      override: {
        type: "http",
        url: "http://global-override.example/mcp",
      },
    },
  }), "utf8");

  await writeFile(path.join(homeDir, ".claude.json"), JSON.stringify({
    mcpServers: {
      homeOnly: {
        command: "node",
        args: ["home-server.js"],
      },
      override: {
        type: "http",
        url: "http://home-override.example/mcp",
      },
    },
  }), "utf8");

  await writeFile(path.join(workspaceClaudeDir, "settings.local.json"), JSON.stringify({
    mcpServers: {
      override: {
        type: "stdio",
        command: "uvx",
        args: ["workspace-server"],
      },
    },
  }), "utf8");

  process.env.HOME = homeDir;

  const configs = await loadClaudeMcpServerConfigs({ cwd: workspaceDir });
  assert.deepEqual(configs, {
    shared: {
      type: "http",
      url: "http://global.example/mcp",
    },
    homeOnly: {
      type: "stdio",
      command: "node",
      args: ["home-server.js"],
    },
    override: {
      type: "stdio",
      command: "uvx",
      args: ["workspace-server"],
    },
  });
});
