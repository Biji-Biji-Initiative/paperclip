# Factory Claude subscription caller

This source implements the TypeScript caller for a protected, cold Claude turn.
It is not an enrolled worker or a completed subscription pilot. Native Rust FD
mapping, the provider-bound host issuer, image qualification and live cancellation
proof remain required before enabling it.

The verified builtin-only bootstrap accepts `--factory-claude-access-v1`. Before
loading runtime modules it consumes and closes FD3 public metadata and FD4 private
access, each bounded to 16 KiB and a two-second EOF deadline. The two frames must
match admission, capability, worker-plan, run, normalized-session, environment-lease
and runner identifiers. Public metadata additionally binds the runtime and workspace
paths and a maximum 300-second deadline. Private access can expire earlier.

A private in-memory capability permits one matching session open and run attach.
Open, attach and handoff check actual access expiry independently of the retirement
timer. Prompt, follow-up, goal and interaction submission boundaries also recheck
access. Callback failures begin the existing owned provider cleanup immediately,
so an unresolved serial input response cannot hold cleanup behind itself.
Runtime host supplies the actual workspace, runtime, authenticated tool
bridge and assigned semantic tools. Extra native MCP gateways are held for this
initial contract. Finish and block remain available.

Cold admission also rejects prior ACPX persistent records. The pinned ACPX
`ensureSession` otherwise reuses a matching record even when native provider-state
is absent. Protected mode rejects that record before remembering its cleanup
handle, saving it or spawning a child. Only this invocation's fresh missing record,
single owned spawn and collision-checked first save establish ownership. Later
reloads and saves must retain that same identity; loading or re-saving a foreign
record cannot establish ownership. Generic persistent-session reuse is unchanged.
The store API remains load/save, not a cross-process compare-and-swap operation.
Its checks still require the enclosing exclusive workspace ownership and private
runtime directory; they do not authorize concurrent writers.

The guardian hands the subscription token through the SDK native descriptor
interface, with subprocess environment scrubbing enabled. Public argv contains a
closed policy projection; access never belongs in argv, bearer environment values
or an authentication file. Protected mode restricts Claude to the assigned MCP
tools, denies built-in tools and retires the process group on expiry. Streaming
redaction precedes capture. Generic callers without the protected flag retain
their existing behavior.

The ACP 0.73.0 patch and lockfile hash are one change. Its installed Zod dependency
remains 4.4.3; this contract does not require a dependency upgrade. The verified
entrypoint builder must run before packaging the provider pack.

Focused caller and installation-integrity tests and runner TypeScript checks pass.
The cold-record slice passes all 80 adapter tests and the runner TypeScript check.
Its three new behavior tests use the installed ACPX library: matching old state is
held without spawn/save/old-handle cleanup, generic mode reuses the same seed, and
a builtin-only synthetic ACP child creates and reloads its own fresh record.
The two-file UBS attempt timed out without completed JSON; syntax, tests and
gitleaks passed, but no completed scanner proof is claimed for this slice.
These are synthetic source checks, not evidence of a real account, paid inference,
or a complete native tool isolation run. The latest whole-source UBS attempt
timed out without a completed scan; no clean whole-source scanner claim is made.
