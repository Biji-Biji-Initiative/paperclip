import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";
const { hooks } = createRequire(import.meta.url)("../.pnpmfile.cjs");

test("runtime peer policy excludes only the pinned optional development tools", () => {
  const pkg = {
    name: "better-auth", version: "1.7.2",
    peerDependencies: { "drizzle-kit": ">=0.31.4", vitest: "^4", "drizzle-orm": "^0.45", react: "^19" },
    peerDependenciesMeta: { "drizzle-kit": { optional: true }, vitest: { optional: true }, "drizzle-orm": { optional: true } },
  };
  const other = structuredClone({ ...pkg, name: "another-library" });
  assert.equal(hooks.readPackage(other), other);
  assert.ok(other.peerDependencies.vitest);
  const required = structuredClone(pkg);
  required.peerDependenciesMeta.vitest.optional = false;
  assert.throws(() => hooks.readPackage(required), /contract changed/);
  const result = hooks.readPackage(pkg);
  assert.deepEqual(result.peerDependencies, { "drizzle-orm": "^0.45", react: "^19" });
  assert.deepEqual(result.peerDependenciesMeta, { "drizzle-orm": { optional: true } });
  assert.equal(hooks.readPackage(result), result);
});
