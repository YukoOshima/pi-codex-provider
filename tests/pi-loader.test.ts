import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

interface LoaderResult {
  extensions: unknown[];
  errors: Array<{ path: string; error: string }>;
}

interface PiLoaderModule {
  loadExtensions(paths: string[], cwd: string): Promise<LoaderResult>;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const loaderUrl = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
  import.meta.url,
).href;

test("Pi 0.83 jiti loader can import the packaged TypeScript extension", async () => {
  const loaderSpecifier = loaderUrl;
  const { loadExtensions } = await import(loaderSpecifier) as PiLoaderModule;
  const result = await loadExtensions([extensionPath], repositoryRoot);

  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
});

test("pi-ai bridge dependency survives Pi git install with --omit=dev", async () => {
  const [manifest, lockfile] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]) as [
    { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
    { packages?: Record<string, { version?: string; dev?: boolean }> },
  ];

  assert.equal(manifest.dependencies?.["@earendil-works/pi-ai"], "0.83.0");
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-ai"], undefined);
  const piAiLockEntry = lockfile.packages?.["node_modules/@earendil-works/pi-ai"];
  assert.equal(piAiLockEntry?.version, "0.83.0");
  assert.equal(piAiLockEntry?.dev, undefined);
});
