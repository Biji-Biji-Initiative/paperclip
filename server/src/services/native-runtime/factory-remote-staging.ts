import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { FACTORY_COMPANY_ID } from "@paperclipai/adapter-utils/factory-worker-lease";

const MAX_PAYLOAD = 64 * 1024 * 1024;
const FAILURE = "factory_remote_staging_unverified";

/** Trusted control-plane program. No extractall(), pathname redirects or followed destination links. */
export const FACTORY_STAGE_PROGRAM = String.raw`
import base64, io, json, os, secrets, stat, sys, tarfile
MAX_PAYLOAD = 64 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 200000
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def fail():
    raise ValueError('factory_remote_staging_unverified')

def parts(path, absolute=False):
    if not isinstance(path, str) or not path or len(path) > 4096 or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path): fail()
    if path.startswith('/') != absolute: fail()
    values = path.split('/')[1:] if absolute else path.split('/')
    if any(not p or p in ('.', '..') or len(p.encode()) > 255 for p in values): fail()
    return values

def check_dir(fd, private=True):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()) or (private and info.st_mode & 0o022): fail()

def descend(fd, names, create=False, private=True):
    current = os.dup(fd)
    try:
        for name in names:
            if create:
                try: os.mkdir(name, 0o700, dir_fd=current)
                except FileExistsError: pass
            child = os.open(name, DIR, dir_fd=current)
            try: check_dir(child, private)
            except BaseException: os.close(child); raise
            os.close(current); current = child
        return current
    except BaseException:
        os.close(current); raise

def existing(parent, name):
    try: return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError: return None

def remove_tree(parent, name):
    info = existing(parent, name)
    if info is None: return
    if not stat.S_ISDIR(info.st_mode):
        os.unlink(name, dir_fd=parent); return
    directory = os.open(name, DIR, dir_fd=parent)
    try:
        check_dir(directory)
        os.fchmod(directory, stat.S_IMODE(os.fstat(directory).st_mode) | 0o700)
        for child in os.listdir(directory): remove_tree(directory, child)
    finally: os.close(directory)
    os.rmdir(name, dir_fd=parent)

def file_into(parent, name, content, mode):
    before = existing(parent, name)
    if before and (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1): fail()
    temporary = '.factory-stage-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid(): fail()
        while True:
            chunk = content.read(1024 * 1024)
            if not chunk: break
            view = memoryview(chunk)
            while view:
                count = os.write(fd, view)
                if not count: fail()
                view = view[count:]
        os.fchmod(fd, mode); os.fsync(fd)
        # renameat replaces an entry, never follows a substituted destination link.
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(fd)
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass

def members_of(archive):
    members = []; names = set(); links = {}; expanded = 0
    for member in archive:
        if len(members) >= MAX_ENTRIES: fail()
        name = member.name
        while name.startswith('./'): name = name[2:]
        if name in ('', '.'):
            if not member.isdir(): fail()
            continue
        name = name.rstrip('/') if member.isdir() else name
        names_list = parts(name)
        name = '/'.join(names_list)
        if name in names: fail()
        names.add(name)
        if not (member.isdir() or member.isfile() or member.issym()): fail()
        if member.size < 0 or member.mode & 0o7000: fail()
        expanded += member.size
        if expanded > MAX_EXPANDED: fail()
        if member.issym():
            target = member.linkname
            if not target or target.startswith('/') or '\\' in target or len(target) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in target): fail()
            links[name] = target
        members.append((name, member))
    # Resolve links using the archive's own graph; lexical normalization alone
    # misses escapes such as a link-to-root followed by '..'. No host path is read.
    for name, member in members:
        if any('/'.join(name.split('/')[:i]) in links for i in range(1, len(name.split('/')))): fail()
        if not member.issym(): continue
        todo = name.split('/'); resolved = []; followed = 0
        while todo:
            part = todo.pop(0)
            if part in ('', '.'): continue
            if part == '..':
                if not resolved: fail()
                resolved.pop(); continue
            candidate = '/'.join(resolved + [part])
            if candidate in links:
                followed += 1
                if followed > 40: fail()
                todo = links[candidate].split('/') + todo
            else: resolved.append(part)
    return members

def restore(parent, name, payload, mode):
    before = existing(parent, name)
    if before and (not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid()): fail()
    temporary = '.factory-stage-' + secrets.token_hex(16)
    previous = '.factory-stage-previous-' + secrets.token_hex(16)
    os.mkdir(temporary, 0o700, dir_fd=parent)
    tree = os.open(temporary, DIR, dir_fd=parent)
    moved = False; installed = False
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            members = members_of(archive)
            directories = []
            for relative, member in members:
                components = relative.split('/')
                target_parent = descend(tree, components[:-1], True)
                try:
                    if member.isdir():
                        child = descend(target_parent, [components[-1]], True)
                        os.close(child); directories.append((components, member.mode & 0o755))
                    elif member.isfile():
                        content = archive.extractfile(member)
                        if content is None: fail()
                        with content: file_into(target_parent, components[-1], content, member.mode & 0o755)
                finally: os.close(target_parent)
            for relative, member in members:
                if not member.issym(): continue
                components = relative.split('/')
                target_parent = descend(tree, components[:-1], True)
                try: os.symlink(member.linkname, components[-1], dir_fd=target_parent)
                finally: os.close(target_parent)
            for components, directory_mode in sorted(directories, key=lambda item: len(item[0]), reverse=True):
                child = descend(tree, components)
                try: os.fchmod(child, directory_mode | 0o500)
                finally: os.close(child)
        os.fchmod(tree, mode); os.fsync(tree)
        # A preexisting directory is moved as an entry, never extracted through.
        # The durable staging gate protects the bounded replacement/rollback window.
        if before:
            current = existing(parent, name)
            if not current or current.st_dev != before.st_dev or current.st_ino != before.st_ino or not stat.S_ISDIR(current.st_mode): fail()
            os.rename(name, previous, src_dir_fd=parent, dst_dir_fd=parent); moved = True
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent); installed = True
        os.fsync(parent)
    except BaseException:
        if moved and not installed and existing(parent, name) is None:
            os.rename(previous, name, src_dir_fd=parent, dst_dir_fd=parent)
        raise
    finally:
        os.close(tree)
        for entry in ([previous] if moved and installed else []) + ([] if installed else [temporary]):
            remove_tree(parent, entry)

def main():
    request = json.loads(sys.argv[1])
    mode = request['mode']
    if not isinstance(mode, int) or mode < 0o400 or mode > 0o755 or mode & 0o022: fail()
    root_names = parts(request['workspaceRoot'], True)
    relative = parts(request['relativePath'])
    if relative[0] != '.paperclip-runtime': fail()
    encoded = sys.stdin.buffer.read(4 * ((MAX_PAYLOAD + 2) // 3) + 1)
    if len(encoded) > 4 * ((MAX_PAYLOAD + 2) // 3): fail()
    payload = base64.b64decode(encoded, validate=True)
    if len(payload) > MAX_PAYLOAD: fail()
    root = os.open('/', DIR)
    workspace = parent = None
    try:
        # Ancestors are pinned with no-follow opens; only the selected workspace
        # and its descendants must also exclude other writers.
        workspace = descend(root, root_names, private=False)
        check_dir(workspace)
        parent = descend(workspace, relative[:-1], True)
        if request['kind'] == 'file': file_into(parent, relative[-1], io.BytesIO(payload), mode)
        elif request['kind'] == 'directory': restore(parent, relative[-1], payload, mode)
        elif request['kind'] == 'ensure_directory':
            directory = descend(parent, [relative[-1]], True)
            try:
                if os.fstat(directory).st_uid != os.getuid(): fail()
                os.fchmod(directory, mode); os.fsync(directory)
            finally: os.close(directory)
            os.fsync(parent)
        else: fail()
    finally:
        if parent is not None: os.close(parent)
        if workspace is not None: os.close(workspace)
        os.close(root)
try:
    main()
except BaseException:
    sys.stderr.write('factory_remote_staging_unverified')
    sys.exit(1)
`;

function relativeTarget(workspaceRoot: string, targetPath: string) {
  const prefix = `/workspace/${FACTORY_COMPANY_ID}/`;
  if (!workspaceRoot.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceRoot.slice(prefix.length)) ||
      posix.normalize(workspaceRoot) !== workspaceRoot || /[\u0000-\u001f\u007f\\]/.test(workspaceRoot + targetPath)) throw new Error(FAILURE);
  const relative = posix.relative(workspaceRoot, targetPath);
  if (!posix.isAbsolute(targetPath) || posix.normalize(targetPath) !== targetPath ||
      !relative.startsWith(".paperclip-runtime/") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error(FAILURE);
  return relative;
}
async function upload(input: { runner: CommandManagedRuntimeRunner; workspaceRoot: string; targetPath: string; mode: number }, kind: "file" | "directory" | "ensure_directory", payload: Buffer) {
  const relativePath = relativeTarget(input.workspaceRoot, input.targetPath);
  if (payload.length > MAX_PAYLOAD || !Number.isInteger(input.mode) || input.mode < 0o400 || input.mode > 0o755 || (input.mode & 0o022)) throw new Error(FAILURE);
  const result = await input.runner.execute({ command: "/usr/bin/python3", args: ["-I", "-S", "-c", FACTORY_STAGE_PROGRAM,
    JSON.stringify({ kind, workspaceRoot: input.workspaceRoot, relativePath, mode: input.mode })],
    stdin: payload.toString("base64"), timeoutMs: 120_000, bypassSession: true }).catch(() => { throw new Error(FAILURE); });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(FAILURE);
}
export async function ensureFactoryRemoteRunnerDirectory(input: {
  runner: CommandManagedRuntimeRunner; workspaceRoot: string; targetPath: string; mode: number;
}) {
  await upload(input, "ensure_directory", Buffer.alloc(0));
}
export async function stageFactoryRemoteRunnerText(input: {
  runner: CommandManagedRuntimeRunner; workspaceRoot: string; targetPath: string; mode: number; content: string;
}) {
  await upload(input, "file", Buffer.from(input.content, "utf8"));
}
export async function stageFactoryRemoteRunnerFile(input: {
  runner: CommandManagedRuntimeRunner; workspaceRoot: string; sourcePath: string; targetPath: string; mode: number;
}) {
  try {
    relativeTarget(input.workspaceRoot, input.targetPath);
    await upload(input, "file", readFileSync(input.sourcePath));
  } catch { throw new Error(FAILURE); }
}
export async function stageFactoryRemoteRunnerDirectory(input: {
  runner: CommandManagedRuntimeRunner; workspaceRoot: string; sourcePath: string; targetPath: string; mode: number; excludeEntries?: readonly string[];
}) {
  // Validate before reading source assets. --hard-dereference creates independent
  // regular entries for trusted build-store hardlinks, preserving relative symlinks.
  try {
    relativeTarget(input.workspaceRoot, input.targetPath);
    const exclusions = (input.excludeEntries ?? []).map(entry => {
      if (!entry || entry.startsWith("/") || entry.split("/").some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) throw new Error(FAILURE);
      return `--exclude=./${entry}`;
    });
    const archive = execFileSync("tar", ["--hard-dereference", ...exclusions, "-czf", "-", "-C", input.sourcePath, "."], { maxBuffer: MAX_PAYLOAD });
    await upload(input, "directory", archive);
  } catch { throw new Error(FAILURE); }
}
