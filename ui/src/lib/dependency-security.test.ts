import { describe, expect, it } from "vitest";


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
