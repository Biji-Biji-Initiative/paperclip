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
timer. Runtime host supplies the actual workspace, runtime, authenticated tool
bridge and assigned semantic tools. Extra native MCP gateways are held for this
initial contract. Finish and block remain available.

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
These are synthetic source checks, not evidence of a real account, paid inference,
or a complete native tool isolation run. The latest whole-source UBS attempt
timed out without a completed scan; no clean whole-source scanner claim is made.
