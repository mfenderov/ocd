import { describe, expect, it } from "vitest";
import { complexityOf, functionsInFile } from "./complexity.ts";
import ts from "typescript";

/** The complexity of a function body, written as source. */
function complexityOfSource(body: string): number {
  const source = ts.createSourceFile("t.ts", `function f() { ${body} }`, ts.ScriptTarget.ES2022, true);
  const fn = source.statements[0];
  return complexityOf(fn as ts.FunctionDeclaration);
}

describe("complexity", () => {
  it("counts a function with no decisions as one", () => {
    expect(complexityOfSource("return 1;")).toBe(1);
  });

  it("counts each decision point", () => {
    expect(complexityOfSource("if (a) { return 1 } return 2")).toBe(2);
    expect(complexityOfSource("for (;;) { break }")).toBe(2);
    expect(complexityOfSource("while (a) { break }")).toBe(2);
    expect(complexityOfSource("try { a() } catch { b() }")).toBe(2);
    expect(complexityOfSource("return a ? b : c")).toBe(2);
  });

  it("counts the short-circuiting operators", () => {
    expect(complexityOfSource("return a && b")).toBe(2);
    expect(complexityOfSource("return a || b")).toBe(2);
    expect(complexityOfSource("return a ?? b")).toBe(2);
  });

  it("does not count a plain comparison", () => {
    expect(complexityOfSource("return a === b")).toBe(1);
  });

  it("counts every case of a switch", () => {
    expect(complexityOfSource("switch (a) { case 1: return 1; case 2: return 2 }")).toBe(3);
  });

  it("does not count the default case of a switch", () => {
    // gocyclo ignores it: the default is where the switch lands, not a
    // decision of its own.
    expect(complexityOfSource("switch (a) { case 1: return 1; default: return 2 }")).toBe(2);
  });

  it("leaves a nested function's complexity to the nested function", () => {
    expect(complexityOfSource("if (a) { const g = () => { if (b) { return 1 } return 2 } }")).toBe(2);
  });

  it("finds the functions of a file with their lines", () => {
    const found = functionsInFile(
      "a.ts",
      ["export function one() {", "  return 1;", "}", "const two = () => 2;"].join("\n"),
    );
    expect(found.map((f) => f.name)).toEqual(["one", "two"]);
    expect(found[0].startLine).toBe(1);
    expect(found[1].startLine).toBe(4);
  });

  it("names a method after its class", () => {
    const found = functionsInFile("a.ts", ["class C {", "  m() { return 1 }", "}"].join("\n"));
    expect(found[0].name).toBe("C.m");
  });
});
