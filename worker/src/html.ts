// The text helper: HTML escaping.
//
// The brain's messages are HTML-parse-mode like the Go bot's, so every
// value that comes from the fleet — a box id, an error, an IP, a user
// agent — goes through this before it reaches the owner's chat. One
// unescaped "<" makes Telegram refuse the whole message.
//
// It lives in its own module, not in the ports and not in the Telegram
// adapter: it is a pure function about text. The ports module holds
// what the domain needs from the outside world, and this is not that —
// the domain computes with it.

// escapeHtml escapes the characters Telegram's HTML parse mode reads as
// markup: the three the Go bot's esc helper handles, and the double
// quote — a value that lands inside an href="…" attribute must not end
// that attribute.
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
