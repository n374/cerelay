import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("package scripts keep server:up on a force-recreate path", async () => {
  const packageJson = JSON.parse(await readFile(path.join(WORKDIR, "package.json"), "utf8"));
  const serverUp = packageJson?.scripts?.["server:up"];

  assert.equal(typeof serverUp, "string");
  assert.match(serverUp, /\bdocker compose up\b/);
  assert.match(serverUp, /\s--build\b/);
  assert.match(serverUp, /\s--force-recreate\b/);
  assert.match(serverUp, /\s--remove-orphans\b/);
  assert.match(serverUp, /\s-d\b/);
});
