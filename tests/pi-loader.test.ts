import assert from "node:assert/strict";
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
