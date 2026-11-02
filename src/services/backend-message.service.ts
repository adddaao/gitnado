/**
 * Backend success / event text, in the language the UI is in.
 *
 * Rust also composes the text for operations that SUCCEED — the branch-switch
 * confirmation, the multi-remote summaries, the "bisect started" line — and
 * hands it to the frontend, which toasts it verbatim. Unlike errors these carry
 * no stable code (the payload is just `message: String`), so the only stable
 * thing to key on is the backend's own wording.
 *
 * This catalogue therefore matches the English templates the Rust side
 * formats, anchored at the start of the string so a commit message or a file
 * path in a toast can never be rewritten by accident, and translates the
 * parameterised pieces with `str`. Under the source locale every entry renders
 * byte-identically to the backend's text (existing assertions and e2e
 * expectations keep working), and anything not in the catalogue passes through
 * untouched — a missing rule means one English row, never a mangled message.
 *
 * Errors are NOT handled here: they have codes, and `backend-error.service.ts`
 * translates them at the IPC boundary.
 */

import { msg, str } from '@lit/localize';

/** A backend template: an anchored match, and how to render it. */
interface MessageRule {
  pattern: RegExp;
  render: (match: RegExpMatchArray) => string;
}

/**
 * Longest/most specific patterns first: "Switched to X and re-applied…" must be
 * tried before "Switched to X", or the generic rule would swallow the tail.
 */
const RULES: readonly MessageRule[] = [
  {
    // `git stash pop` failed while switching, and the stash was kept.
    pattern: /^Switched to (.+), but your stashed changes could not be found to re-apply\. They are still in the stash list — apply them manually\.$/,
    render: (m) =>
      msg(
        str`Switched to ${m[1]}, but your stashed changes could not be found to re-apply. They are still in the stash list — apply them manually.`
      ),
  },
  {
    pattern: /^Switched to (.+) but failed to re-apply stash: (.+)\. Your changes remain stashed\.$/,
    render: (m) =>
      msg(
        str`Switched to ${m[1]} but failed to re-apply stash: ${m[2]}. Your changes remain stashed.`
      ),
  },
  {
    pattern: /^Switched to (.+) and re-applied stashed changes \(staged status was not preserved\)$/,
    render: (m) =>
      msg(
        str`Switched to ${m[1]} and re-applied stashed changes (staged status was not preserved)`
      ),
  },
  {
    pattern: /^Switched to (.+) and re-applied stashed changes$/,
    render: (m) => msg(str`Switched to ${m[1]} and re-applied stashed changes`),
  },
  {
    pattern: /^Switched to (.+)$/,
    render: (m) => msg(str`Switched to ${m[1]}`),
  },
  {
    pattern: /^Failed to stash changes: (.+)$/,
    render: (m) => msg(str`Failed to stash changes: ${m[1]}`),
  },
  {
    pattern: /^Garbage collection failed: (.+)$/,
    render: (m) => msg(str`Garbage collection failed: ${m[1]}`),
  },
  {
    pattern: /^Pushed to (\d+) remote\(s\) \((\d+) failed\)$/,
    render: (m) => msg(str`Pushed to ${m[1]} remote(s) (${m[2]} failed)`),
  },
  {
    pattern: /^Fetched from (\d+) remotes \((\d+) failed\)$/,
    render: (m) => msg(str`Fetched from ${m[1]} remotes (${m[2]} failed)`),
  },
  {
    pattern: /^Fetch completed successfully$/,
    render: () => msg('Fetch completed successfully'),
  },
  {
    pattern: /^Bisect session started$/,
    render: () => msg('Bisect session started'),
  },
];

/**
 * Translate one backend success/event message for display.
 *
 * Returns the input unchanged unless a rule matches, so technical progress text
 * ("Receiving objects: 42%"), user content, and any message added backend-side
 * without a rule keep rendering exactly as before.
 */
export function localizeBackendMessage(text: string): string {
  if (!text) return text;
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) return rule.render(match);
  }
  return text;
}

/** Whether `localizeBackendMessage` knows this text (used by tests only). */
export function hasBackendMessageRule(text: string): boolean {
  return RULES.some((rule) => rule.pattern.test(text));
}
