import { createHash } from "node:crypto";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

export const FACTORY_PACK_MISMATCH_EXIT = 78;
const SCHEMA = "paperclip.factory-public-pack-mismatch.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

export interface FactoryPublicPackMismatch {
  schema: typeof SCHEMA;
  expectedManifestSha256: string;
  actualManifestSha256: string;
  expectedPackDigest: string;
  actualPackDigest: string;
}

export class FactoryPublicPackMismatchError extends Error {
  constructor(readonly diagnostic: FactoryPublicPackMismatch) {
    super("runner_remote_provider_artifact_incompatible: immutable provider-pack manifest mismatch");
    this.name = "FactoryPublicPackMismatchError";
  }
}

/** One live executor attempt, never deserialized from a model/API/DB claim. */
export class FactoryWorkerPreparation {
  private pending = 0;
  private uncertain = false;
  private admissionAttempted = false;
  private foregroundAttempted = false;
  private readonly mismatches = new WeakSet<FactoryPublicPackMismatchError>();

  constructor(readonly runId: string, readonly leaseId: string) {}

  async command<T extends RunProcessResult>(execute: () => Promise<T>): Promise<T> {
    this.pending++;
    try {
      const result = await execute();
      // Dedicated SSH returns null for uncertain exit, overflow or failed close.
      // SSH's reserved 255 cannot distinguish remote exit from transport failure.
      if (result.timedOut || result.signal !== null || result.exitCode === null ||
          !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode >= 255) this.uncertain = true;
      return result;
    } catch (error) {
      this.uncertain = true;
      throw error;
    } finally {
      this.pending--;
    }
  }

  markAdmissionAttempted(): void { this.admissionAttempted = true; }
  markForegroundAttempted(): void { this.foregroundAttempted = true; }

  /** Only the fixed verifier's completed, clean, closed public outcome is typed. */
  mismatch(result: RunProcessResult, canonicalExpectedManifest: string): FactoryPublicPackMismatchError | null {
    if (result.exitCode !== FACTORY_PACK_MISMATCH_EXIT || result.timedOut || result.signal !== null ||
        result.stderr !== "" || Buffer.byteLength(result.stdout) > 1024) return null;
    let value: FactoryPublicPackMismatch;
    let expected: { digest?: unknown };
    try { value = JSON.parse(result.stdout); expected = JSON.parse(canonicalExpectedManifest); }
    catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "actualManifestSha256,actualPackDigest,expectedManifestSha256,expectedPackDigest,schema" ||
        value.schema !== SCHEMA ||
        ![value.expectedManifestSha256, value.actualManifestSha256, value.expectedPackDigest, value.actualPackDigest]
          .every(item => typeof item === "string" && DIGEST.test(item)) ||
        value.expectedManifestSha256 !== hash(canonicalExpectedManifest) || value.expectedPackDigest !== expected.digest ||
        value.actualManifestSha256 === value.expectedManifestSha256) return null;
    const error = new FactoryPublicPackMismatchError(Object.freeze({ ...value }));
    this.mismatches.add(error);
    return error;
  }

  canSettle(error: unknown, runId: string, leaseId: string): error is FactoryPublicPackMismatchError {
    return runId === this.runId && leaseId === this.leaseId &&
      error instanceof FactoryPublicPackMismatchError && this.mismatches.has(error) &&
      this.pending === 0 && !this.uncertain && !this.admissionAttempted && !this.foregroundAttempted;
  }
}

/** The equality gate stays exact; report only public digests, never raw stderr. */
export const FACTORY_PACK_MISMATCH_SCRIPT =
  "if(canonical(manifest)!==expected){" +
  "const sha=v=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex');" +
  "process.stdout.write(JSON.stringify({schema:'" + SCHEMA + "',expectedManifestSha256:sha(expected)," +
  "actualManifestSha256:sha(canonical(manifest)),expectedPackDigest:JSON.parse(expected).digest,actualPackDigest:manifest.digest}));" +
  "process.exit(" + FACTORY_PACK_MISMATCH_EXIT + ")}";
