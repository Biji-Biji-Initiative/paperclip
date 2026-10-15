import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const buildRequire = createRequire(import.meta.resolve("vite"));
const sourceMaps = createRequire(buildRequire.resolve("postcss"))("source-map-js") as {
  SourceMapConsumer: new (map: unknown) => { originalPositionFor: (position: { line: number; column: number }) => unknown };
};

describe("source-map input limits", () => {
  it("rejects excessive section offsets and preserves normal source locations", () => {
    const map = { version: 3, sources: ["proposal.css"], names: [], mappings: "AAAA" };
    expect(() => new sourceMaps.SourceMapConsumer({ version: 3, sections: [{ offset: { line: 1e13, column: 0 }, map }] })).toThrow(/offset line/);
    const consumer = new sourceMaps.SourceMapConsumer(map);
    expect(consumer.originalPositionFor({ line: 1, column: 0 })).toMatchObject({ source: "proposal.css", line: 1, column: 0 });
  });
});


describe("editor YAML security dependency", () => {
  it("bounds even empty merge sources while retaining document metadata", async () => {
    const { createRequire } = await import("node:module");
    const yaml = createRequire(import.meta.resolve("@mdxeditor/editor"))("js-yaml") as {
      load: (value: string, options?: { maxTotalMergeKeys: number }) => unknown;
    };
    expect(() => yaml.load("x: &x {}\ny:\n  <<: [*x, *x, *x]\n", { maxTotalMergeKeys: 1 })).toThrow(/maxTotalMergeKeys/);
    expect(yaml.load("title: Proposal\nowner: Miranda\n")).toEqual({ title: "Proposal", owner: "Miranda" });
  });
});
