/**
 * Backend error text, in the language the UI is in.
 *
 * The Rust side builds error messages as user-facing English sentences
 * (`GitnadoError`'s `#[error(...)]` formats) and sends them over IPC as
 * `{ code, message }`. That text reaches **every** surface — toasts, inline
 * dialog errors, the error-suggestion machinery — so translating it at each
 * display site would mean touching hundreds of call sites and would still miss
 * new ones. This module translates it once, at the IPC boundary
 * (`invokeCommand`), using the stable `code` the backend already emits.
 *
 * Two things make the rewrite safe:
 *
 * - The English source text is kept: `CommandError.originalMessage` carries the
 *   raw message, because a few places MATCH on backend wording (the error
 *   suggestion rules, the cherry-pick conflict check) and they must keep
 *   matching whatever the UI language is.
 * - Codes whose message is a fixed sentence get that sentence; codes whose
 *   message is a prefix plus a payload (`Operation failed: <git stderr>`) get a
 *   translated prefix with the payload untouched. The payload is git's / the
 *   OS's own output and is not ours to translate — a Chinese frame around an
 *   English technical detail is honest, while a half-translated git error would
 *   not be.
 *
 * Codes whose message is a bespoke sentence the backend composes per call
 * (`BLOCKED`, `REMOTE_OPERATION_IN_FLIGHT`, `CUSTOM_ERROR`) are passed through
 * unchanged: there is no stable wording to key on, and inventing a generic
 * replacement would throw away information the backend intended to convey.
 */

import { msg, str } from '@lit/localize';

/** The shape `invokeCommand` puts in a failed `CommandResult`. */
export interface BackendErrorLike {
  /** Stable code from Rust (`ErrorResponse::code`), as `CommandError.code`. */
  code?: string;
  /** The message to show. Already localised once it left `invokeCommand`. */
  message?: string;
  /** The backend's raw English text, kept for matching. */
  originalMessage?: string;
}

/**
 * The fixed sentence a code always carries, or null when the code's message is
 * not a fixed sentence.
 *
 * Each `msg()` literal is the EXACT English the Rust side formats, so the
 * source locale renders byte-identically and every existing assertion and log
 * line keeps working.
 */
function fixedMessage(code: string): string | null {
  switch (code) {
    case 'REPO_NOT_OPEN':
      return msg('Repository not open');
    case 'AUTH_REQUIRED':
      return msg('Authentication required');
    case 'MERGE_CONFLICT':
      return msg('Merge conflict');
    case 'REBASE_IN_PROGRESS':
      return msg('Rebase in progress');
    case 'REBASE_CONFLICT':
      return msg('Rebase conflict');
    case 'REBASE_PAUSED':
      return msg('Rebase paused');
    case 'CHERRY_PICK_CONFLICT':
      return msg('Cherry-pick conflict');
    case 'CHERRY_PICK_IN_PROGRESS':
      return msg('Cherry-pick in progress');
    case 'REVERT_CONFLICT':
      return msg('Revert conflict');
    case 'REVERT_IN_PROGRESS':
      return msg('Revert in progress');
    case 'INVALID_REFERENCE':
      return msg('Invalid reference');
    case 'OPERATION_CANCELLED':
      return msg('Operation cancelled');
    default:
      return null;
  }
}

/** `prefix + payload` messages, with the English prefix the Rust side formats. */
function frameMessage(code: string, message: string): string | null {
  const frame = (prefix: string, format: (payload: string) => string): string | null =>
    message.startsWith(prefix) ? format(message.slice(prefix.length)) : null;

  switch (code) {
    case 'GIT_ERROR':
      return frame('Git error: ', (payload) => msg(str`Git error: ${payload}`));
    case 'IO_ERROR':
      return frame('IO error: ', (payload) => msg(str`IO error: ${payload}`));
    case 'DB_ERROR':
      return frame('Database error: ', (payload) => msg(str`Database error: ${payload}`));
    case 'SERIALIZATION_ERROR':
      return frame('Serialization error: ', (payload) =>
        msg(str`Serialization error: ${payload}`)
      );
    case 'REPO_NOT_FOUND':
      return frame('Repository not found: ', (payload) =>
        msg(str`Repository not found: ${payload}`)
      );
    case 'INVALID_PATH':
      return frame('Invalid path: ', (payload) => msg(str`Invalid path: ${payload}`));
    case 'FILE_NOT_FOUND':
      return frame('File not found: ', (payload) => msg(str`File not found: ${payload}`));
    case 'BRANCH_NOT_FOUND':
      return frame('Branch not found: ', (payload) => msg(str`Branch not found: ${payload}`));
    case 'COMMIT_NOT_FOUND':
      return frame('Commit not found: ', (payload) => msg(str`Commit not found: ${payload}`));
    case 'TAG_NOT_FOUND':
      return frame('Tag not found: ', (payload) => msg(str`Tag not found: ${payload}`));
    case 'REMOTE_NOT_FOUND':
      return frame('Remote not found: ', (payload) => msg(str`Remote not found: ${payload}`));
    case 'OPERATION_FAILED':
      return frame('Operation failed: ', (payload) =>
        msg(str`Operation failed: ${payload}`)
      );
    case 'OAUTH_ERROR':
      return frame('OAuth error: ', (payload) => msg(str`OAuth error: ${payload}`));
    case 'OPERATION_TIMEOUT':
      return frame('Operation timed out: ', (payload) =>
        msg(str`Operation timed out: ${payload}`)
      );
    case 'NO_TAGS_REACHABLE':
      return frame('No tags reachable from ', (payload) =>
        msg(str`No tags reachable from ${payload}`)
      );
    default:
      return null;
  }
}

/**
 * Translate one backend error message for display.
 *
 * Unknown codes, unknown message shapes, and codes the backend formats per call
 * pass through unchanged — the UI never gets a worse message than the one the
 * backend sent.
 */
export function localizeBackendError(code: string | undefined, message: string): string {
  if (!message) return message;
  if (!code) return message;

  const fixed = fixedMessage(code);
  if (fixed !== null) return fixed;

  return frameMessage(code, message) ?? message;
}

/**
 * The text to MATCH backend-specific rules on.
 *
 * Error-suggestion rules and the few conflict checks key off wording the Rust
 * side produces, so they have to see the original English no matter what the UI
 * language is.
 */
export function backendErrorMatchText(
  error: BackendErrorLike | string | null | undefined
): string {
  if (typeof error === 'string') return error;
  if (!error) return '';
  return error.originalMessage ?? error.message ?? '';
}

/** The text to SHOW for a backend error. */
export function backendErrorDisplayText(
  error: BackendErrorLike | string | null | undefined
): string {
  if (typeof error === 'string') return error;
  return error?.message ?? '';
}
