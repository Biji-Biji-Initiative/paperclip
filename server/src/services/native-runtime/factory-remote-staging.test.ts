import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTORY_COMPANY_ID } from "@paperclipai/adapter-utils/factory-worker-lease";
import { FACTORY_STAGE_PROGRAM, stageFactoryRemoteRunnerFile } from "./factory-remote-staging.js";

type Entry = { name: string; kind?: string; target?: string; content?: string; mode?: number };
function archive(entries: Entry[]) {
  return execFileSync("/usr/bin/python3", ["-I", "-S", "-c", `
import io,json,sys,tarfile
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:gz') as archive:
 for entry in json.loads(sys.argv[1]):
  info=tarfile.TarInfo(entry['name']);info.mode=entry.get('mode',0o755)
  kind=entry.get('kind','file')
  info.type={'file':tarfile.REGTYPE,'directory':tarfile.DIRTYPE,'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'device':tarfile.CHRTYPE}[kind]
  info.linkname=entry.get('target','')
  body=entry.get('content','fixture').encode()
  if kind=='file':info.size=len(body)
  archive.addfile(info,io.BytesIO(body) if kind=='file' else None)
sys.stdout.buffer.write(out.getvalue())
`, JSON.stringify(entries)]);
}

describe("Factory remote staging with actual local filesystem operations", () => {
  let scratch: string;
  let workspace: string;
  let runtime: string;
  let outside: string;
  beforeEach(() => {
    scratch = mkdtempSync("/data/tmp/factory-staging-test-");
    workspace = join(scratch, "workspace"); runtime = join(workspace, ".paperclip-runtime");
    outside = join(scratch, "outside");
    mkdirSync(runtime, { recursive: true, mode: 0o700 }); mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "canary"), "unchanged");
  });
  afterEach(() => {
    function writable(path: string) {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) writable(join(path, entry));
    }
    writable(scratch);
    rmSync(scratch, { recursive: true, force: true });
  });
  function stage(relativePath: string, payload = Buffer.from("updated"), kind = "file", root = workspace) {
    return spawnSync("/usr/bin/python3", ["-I", "-S", "-c", FACTORY_STAGE_PROGRAM,
      JSON.stringify({ workspaceRoot: root, relativePath, kind, mode: kind === "file" ? 0o600 : kind === "ensure_directory" ? 0o700 : 0o555 })],
    { input: payload.toString("base64"), encoding: "utf8", timeout: 10_000 });
  }
  function rejected(result: ReturnType<typeof stage>) {
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("factory_remote_staging_unverified");
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("unchanged");
  }

  it("creates nested files and replaces an existing inode atomically", () => {
    expect(stage(".paperclip-runtime/nested/config").status).toBe(0);
    const target = join(runtime, "nested/config"); const inode = lstatSync(target).ino;
    expect(stage(".paperclip-runtime/nested/config", Buffer.from("second")).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(lstatSync(target).ino).not.toBe(inode);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(runtime, "nested"))).toEqual(["config"]);
  });
  it("ensures private directories without replacing their existing state", () => {
    expect(stage(".paperclip-runtime/state/home", Buffer.alloc(0), "ensure_directory").status).toBe(0);
    const directory = join(runtime, "state/home");
    const inode = lstatSync(directory).ino;
    writeFileSync(join(directory, "retained"), "preserved");
    expect(stage(".paperclip-runtime/state/home", Buffer.alloc(0), "ensure_directory").status).toBe(0);
    expect(lstatSync(directory).ino).toBe(inode);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(directory, "retained"), "utf8")).toBe("preserved");
  });
  it("refuses linked directory setup before changing the link target", () => {
    const mode = lstatSync(outside).mode;
    symlinkSync(outside, join(runtime, "linked-home"));
    rejected(stage(".paperclip-runtime/linked-home", Buffer.alloc(0), "ensure_directory"));
    symlinkSync(outside, join(runtime, "linked-parent"));
    rejected(stage(".paperclip-runtime/linked-parent/new-home", Buffer.alloc(0), "ensure_directory"));
    expect(lstatSync(outside).mode).toBe(mode);
    expect(readdirSync(outside)).toEqual(["canary"]);
  });
  it("rejects destination symlinks and hardlinks without changing their target", () => {
    symlinkSync(join(outside, "canary"), join(runtime, "linked"));
    rejected(stage(".paperclip-runtime/linked"));
    linkSync(join(outside, "canary"), join(runtime, "hardlinked"));
    rejected(stage(".paperclip-runtime/hardlinked"));
  });
  it("rejects symlink ancestors and workspace roots", () => {
    symlinkSync(outside, join(runtime, "ancestor"));
    rejected(stage(".paperclip-runtime/ancestor/canary"));
    const alias = join(scratch, "alias"); symlinkSync(workspace, alias);
    rejected(stage(".paperclip-runtime/new", undefined, "file", alias));
  });
  it.each(["../outside/canary", ".paperclip-runtime/../canary", ".paperclip-runtime//canary", ".paperclip-runtime/canary\n", ".paperclip-runtime/canary\\name", "/absolute"]) ("rejects noncanonical relative destination %j", path => rejected(stage(path)));
  it("rejects a writable workspace and destination directory links", () => {
    chmodSync(workspace, 0o777); rejected(stage(".paperclip-runtime/config")); chmodSync(workspace, 0o700);
    symlinkSync(outside, join(runtime, "bundle"));
    rejected(stage(".paperclip-runtime/bundle", archive([{ name: "canary" }]), "directory"));
  });
  it("restores confined package links and replaces read-only directories", () => {
    const payload = archive([
      { name: "node_modules/.bin", kind: "directory", mode: 0o555 },
      { name: "node_modules/tool", content: "executable" },
      { name: "node_modules/.bin/tool", kind: "symlink", target: "../tool" },
    ]);
    expect(stage(".paperclip-runtime/bundle", payload, "directory").status).toBe(0);
    expect(readFileSync(join(runtime, "bundle/node_modules/.bin/tool"), "utf8")).toBe("executable");
    expect(stage(".paperclip-runtime/bundle", archive([{ name: "new", content: "replacement" }]), "directory").status).toBe(0);
    expect(readdirSync(join(runtime, "bundle"))).toEqual(["new"]);
    expect(readdirSync(runtime)).toEqual(["bundle"]);
  });
  it("keeps the previous directory when replacement validation fails", () => {
    mkdirSync(join(runtime, "bundle"), { mode: 0o700 });
    writeFileSync(join(runtime, "bundle/previous"), "preserved");
    rejected(stage(".paperclip-runtime/bundle", archive([{ name: "../invalid" }]), "directory"));
    expect(readFileSync(join(runtime, "bundle/previous"), "utf8")).toBe("preserved");
    expect(readdirSync(runtime)).toEqual(["bundle"]);
  });
  it.each([
    [{ name: "../canary" }], [{ name: "/canary" }],
    [{ name: "link", kind: "hardlink", target: "canary" }],
    [{ name: "device", kind: "device" }],
    [{ name: "link", kind: "symlink", target: "/outside" }],
    [{ name: "link", kind: "symlink", target: "../outside" }],
    [{ name: "root", kind: "symlink", target: "." }, { name: "link", kind: "symlink", target: "root/../outside" }],
    [{ name: "a", kind: "symlink", target: "b" }, { name: "b", kind: "symlink", target: "a" }],
    [{ name: "link", kind: "symlink", target: "safe" }, { name: "link/child" }],
    [{ name: "same" }, { name: "same" }],
  ] satisfies Entry[][])("rejects unsafe archive %# before installing it", (...entries) => {
    rejected(stage(".paperclip-runtime/bundle", archive(entries), "directory"));
    expect(existsSync(join(runtime, "bundle"))).toBe(false);
    expect(readdirSync(runtime)).toEqual([]);
  });
  it("validates the production workspace boundary before reading a source", async () => {
    const execute = vi.fn();
    const root = `/workspace/${FACTORY_COMPANY_ID}/11111111-1111-1111-1111-111111111111`;
    await expect(stageFactoryRemoteRunnerFile({ runner: { execute } as never, workspaceRoot: root,
      targetPath: `${root}/../other/config`, sourcePath: join(scratch, "missing"), mode: 0o600 })).rejects.toThrow("factory_remote_staging_unverified");
    expect(execute).not.toHaveBeenCalled();
  });
});
