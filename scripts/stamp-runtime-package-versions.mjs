import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Source checkouts retain development package versions. Release images must
// identify those first-party packages with the same real release as health.
// Never rewrite dependency ranges, the lockfile, or third-party packages.
export function stampRuntimePackageVersions(root, version, commit, entries) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) ||
      !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Runtime release metadata requires a version and full source commit");
  }
  const manifests = entries.map(({ dir, name }) => {
    const path = resolve(root, dir, "package.json");
    const inside = relative(resolve(root), path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Package path escapes release root");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (pkg.name !== name) throw new Error("Release manifest package identity mismatch");
    return { path, pkg };
  });
  for (const { path, pkg } of manifests) {
    writeFileSync(path, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  }
  return { version, commit, packages: manifests.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entries = JSON.parse(readFileSync(join(root, "scripts/release-package-manifest.json"), "utf8"));
  console.log(JSON.stringify(stampRuntimePackageVersions(root, process.argv[2], process.argv[3], entries)));
}
