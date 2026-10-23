// The owner's ports: what the brain needs from the person it serves.
//
// Two needs, both about the owner: tell them something, and talk in
// their chat. The adapter that provides them is wired in from the
// outside (state.ts); the domain never imports it.

// The notifier: "tell the owner this".
//
// The enrolment's pings, the heartbeat's warnings and the DNS failure
// report all go through it. The contract: it never throws, and it
// never logs a secret.
export type NotifyFn = (text: string) => Promise<void>;

// The owner's chat: the one place the brain talks to the owner.
//
// Three operations, in the brain's words: say something, replace what
// the brain said before, answer a tap. A replace carries the buttons
// the edited message keeps: omitting them leaves the old keyboard in
// place. The Bot API's own method names, its option keys and its
// inline_keyboard shape belong to the adapter.
export interface OwnerChat {
  say(chatId: number, text: string, buttons?: OwnerButtons): Promise<SentMessage>;
  replace(chatId: number, messageId: number, text: string, buttons?: OwnerButtons): Promise<boolean>;
  answerTap(tapId: string, text?: string): Promise<void>;
}

// A message the brain said: its id, so the brain can find that message
// again and replace it when the link it carries is spent.
export interface SentMessage {
  readonly id: number;
}

// The buttons under a message: what the owner can tap.
//
// A tap carries the brain's own payload ("<action>:<box>"); a link
// carries the URL it opens. The Bot API's own button fields (text,
// callback_data, url) belong to the adapter.
export type OwnerButton =
  | { readonly label: string; readonly tap: string }
  | { readonly label: string; readonly link: string };

// The buttons under a message: rows, like a keyboard.
export type OwnerButtons = OwnerButton[][];
