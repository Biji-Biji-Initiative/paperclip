#!/usr/bin/env node
import { initializeFactoryClaudeSidecarAccess } from "../drivers/acpx/factory-claude-sidecar-access.js";

// Keep provider and tool modules behind validation of the inherited capability.
void initializeFactoryClaudeSidecarAccess()
  .then(() => import("./acpx-runtime-sidecar.js"))
  .catch(() => { process.stderr.write("factory_claude_access_unverified\n"); process.exitCode = 1; });
