import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { finishPluginNativeNamespace } from "./plugin-native-namespace.js";
import type { PluginNativeNamespaceFact } from "./plugin-source-admission.types.js";
import { pluginSourceStatIdentity } from "./plugin-source-file.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// A dormant native companion whose bytes the initial receipt already consumed: sizeBytes is
// known but contentHash is not, so finishPluginNativeNamespace must read and digest it.
function finishFixture(bytes: Buffer = Buffer.alloc(1140, 0x61)) {
  const capturedRoot = fs.realpathSync(dirs.make("plugin-native-finish-"));
  const sourceDirectory = path.join(capturedRoot, "content");
  fs.mkdirSync(sourceDirectory, { recursive: true });
  const file = path.join(sourceDirectory, "LICENSE.md");
  fs.writeFileSync(file, bytes);
  const captured = fs.statSync(file, { bigint: true });
  const capturedIdentity = pluginSourceStatIdentity(captured);
  const fact: PluginNativeNamespaceFact = {
    sourceDirectory,
    capturedRoot,
    managed: true,
    members: {
      "LICENSE.md": {
        source: file,
        sourceIdentity: capturedIdentity,
        capturedIdentity,
        boundaryChecked: true,
        sizeBytes: bytes.length,
      },
    },
  };
  return { fact, file, captured, capturedIdentity, bytes };
}

// Drift only the pinned inode's bigint stat, mirroring the delayed-metadata model the maintainers
// already use for ctime in src/infra/update-database-generations.test.ts.
function driftPinnedStat(
  captured: fs.BigIntStats,
  drift: (stat: fs.BigIntStats) => void,
): () => number {
  const realStatSync = fs.statSync;
  let observations = 0;
  vi.spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
    const stat = (realStatSync as (...a: unknown[]) => unknown)(...args);
    const options = args[1] as { bigint?: boolean } | string | null | undefined;
    const big = stat as fs.BigIntStats;
    if (
      typeof options === "object" &&
      options?.bigint &&
      big.dev === captured.dev &&
      big.ino === captured.ino
    ) {
      observations += 1;
      drift(big);
    }
    return stat;
  }) as unknown as typeof fs.statSync);
  return () => observations;
}

it("finishes a dormant companion when its own read bumps only ctime (#179923)", () => {
  const { fact, captured, bytes } = finishFixture();
  // Model the Windows Endpoint-DLP EA stamp: the digest read advances ctime, leaving
  // dev/ino/mode/size/mtimeNs — and the bytes — untouched.
  const observations = driftPinnedStat(captured, (stat) => {
    stat.ctimeNs += 239_174_499n;
  });

  expect(() => finishPluginNativeNamespace(fact)).not.toThrow();
  expect(observations()).toBeGreaterThan(0);
  expect(fact.members["LICENSE.md"]!.contentHash).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

it("still refuses a dormant companion whose identity changes beyond ctime (#179923)", () => {
  const { fact, captured } = finishFixture();
  // A genuine edit moves mtime (and would move size/bytes), so admission must not accept it.
  driftPinnedStat(captured, (stat) => {
    stat.mtimeNs += 1_000_000_000n;
  });

  expect(() => finishPluginNativeNamespace(fact)).toThrow(
    "Native plugin companion changed before admission completed",
  );
});
