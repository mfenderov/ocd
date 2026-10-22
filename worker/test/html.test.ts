// The text helper: the escaping every value goes through before it
// reaches the owner's chat.
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/html";

describe("the html escaping", () => {
  it("escapeHtml escapes the characters html parse mode cares about", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    // The double quote too: a value that lands inside an href="…"
    // attribute must not end that attribute.
    expect(escapeHtml('a "quoted" url')).toBe("a &quot;quoted&quot; url");
  });
});
