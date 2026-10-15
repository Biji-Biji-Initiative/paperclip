import { createRequire } from "node:module";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

// Resolve the same URI implementation used by the application's validator.
const uri = createRequire(import.meta.resolve("ajv"))("fast-uri") as {
  serialize: (parts: { scheme: string; host: string; port: string | number; path: string }) => string;
};
const expressRequire = createRequire(import.meta.resolve("express"));
const routePatterns = createRequire(expressRequire.resolve("router"))("path-to-regexp") as {
  pathToRegexp: (path: string) => unknown;
  match: (path: string) => (value: string) => false | { params: Record<string, string> };
};

describe("URI dependency security", () => {
  it("bounds optional route combinations while preserving scoped routes", () => {
    expect(() => routePatterns.pathToRegexp("/" + "{a}".repeat(32) + ":z")).toThrow(/Too many path combinations/);
    expect(routePatterns.match("/companies/:company/issues")("/companies/fixture/issues")).toMatchObject({ params: { company: "fixture" } });
  });
  it("refuses authority injection through an untrusted port", () => {
    expect(() => uri.serialize({ scheme: "http", host: "trusted.example", port: "@127.0.0.1:8124", path: "/app" })).toThrow();
    expect(uri.serialize({ scheme: "https", host: "trusted.example", port: 443, path: "/app" })).toBe("https://trusted.example/app");
  });

  it("preserves schema identity and local reference resolution", () => {
    const ajv = new Ajv();
    const validate = ajv.compile({ $id: "https://schemas.fixture/record", type: "object", properties: {
      title: { $ref: "#/$defs/title" },
    }, required: ["title"], $defs: { title: { type: "string", minLength: 1 } } });
    expect(validate({ title: "A real proposal brief" })).toBe(true);
    expect(validate({ title: "" })).toBe(false);
  });
});
