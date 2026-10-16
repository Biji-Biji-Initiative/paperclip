/** Serialize argv, never shell source fragments supplied as separate arguments. */
export function quoteSshArgument(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("SSH arguments must be NUL-free strings");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface SshArgvCommand {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export function buildSshArgvCommand(input: SshArgvCommand): string {
  if (!input.command || !input.cwd) {
    throw new Error("SSH execution requires an executable and cwd");
  }
  const assignments = Object.entries(input.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
    return `${key}=${quoteSshArgument(value)}`;
  });
  const command = [input.command, ...(input.args ?? [])].map(quoteSshArgument).join(" ");
  // exec is a shell builtin, not an executable to pass to env. Do not flatten
  // sh -c: the full vector preserves its $0 and positional parameters.
  return `cd ${quoteSshArgument(input.cwd)} && exec ${assignments.length ? `env ${assignments.join(" ")} ` : ""}${command}`;
}
