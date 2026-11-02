/**
 * Error Suggestion Service
 * Maps common Git error messages to user-friendly suggestions with optional action buttons
 */

import { msg } from '@lit/localize';
import { showToast } from './notification.service.ts';
import {
  backendErrorDisplayText,
  backendErrorMatchText,
  type BackendErrorLike,
} from './backend-error.service.ts';
import type { ToastAction } from '../stores/ui.store.ts';

export interface ErrorSuggestion {
  message: string;
  action?: ToastAction;
}

export interface ErrorContext {
  operation?: string;
  branchName?: string;
  /** Repo the failing operation ran against. Pinned into any suggested
   *  action, because a toast outlives a repository switch. */
  repoPath?: string;
  /** Remote the failing operation was aimed at, when the caller chose one.
   *  Pinned into the suggested action for the same reason `repoPath` is: a
   *  retry that re-resolves the destination can land on a different remote
   *  than the attempt the user is recovering from. */
  remote?: string;
}

/**
 * Match a Git error message to a user-friendly suggestion with optional action.
 * Returns null if no suggestion matches.
 */
export function getErrorSuggestion(
  errorMessage: string,
  context?: ErrorContext
): ErrorSuggestion | null {
  if (!errorMessage) return null;

  const backendText = errorMessage.toLowerCase();

  // The backend refused because this repository already has a fetch, pull or
  // push in flight (GitnadoError::RemoteOperationInFlight).
  //
  // Kept VERBATIM, and checked FIRST. The backend's wording already names
  // which operation holds the repository and says to retry — and it mentions
  // that an operation which timed out can still be finishing, which is the
  // part the user cannot deduce, because the app's own push/ref locks were
  // released the moment the timeout fired and everything looks idle. Two
  // rules below would otherwise claim it and replace that with something
  // wrong: the timeout rule ("increase the timeout in Settings") and the
  // repository-lock rule ("remove the lock file").
  if (backendText.includes('already running for this repository') ||
      backendText.includes('remote_operation_in_flight')) {
    return { message: errorMessage };
  }

  // A push the remote refused. libgit2 emits TWO different messages here
  // (push.c:345 and :356) that share no substring, and they mean opposite
  // things:
  //
  //   "…contains commits that are not present locally"  -> someone else pushed
  //   "cannot push non-fastforwardable reference"        -> YOU rewrote history
  //
  // Only the first is a "pull before pushing" situation. Offering Pull Now for
  // the second is worse than saying nothing: pulling merges the pre-amend
  // commits back in, duplicating them and undoing the amend the user just made.
  // Checked FIRST, and on libgit2's exact spelling: "non-fastforwardable" is
  // specifically "the remote tip IS in your object database but is not an
  // ancestor", i.e. you amended or rebased. The git CLI's hyphenated
  // "non-fast-forward" means the opposite (you are behind) and is handled
  // below — the two differ only by those hyphens, so order matters.
  if (backendText.includes('fastforwardable')) {
    // A tag that already exists on the remote at another commit fails the same
    // refspec-generic pre-check, and neither pulling nor "newer changes"
    // describes it.
    if (context?.operation === 'push-tag') {
      // "Delete the remote tag first" is a two-step detour (the tag's Delete
      // flow can now do it), and push_tag already implements the force
      // refspec — so offer the one-click recovery instead.
      return {
        message: msg('The remote already has this tag at a different commit.'),
        action: {
          label: msg('Force Push Tag'),
          // The remote travels with the tag: the rejected push was aimed at a
          // remote the user picked, and a force retry that re-resolved the
          // destination would move the tag on a DIFFERENT remote and report
          // success.
          callback: () => window.dispatchEvent(new CustomEvent('force-push-tag', {
            detail: {
              tagName: context?.branchName,
              repoPath: context?.repoPath,
              remote: context?.remote,
            },
          })),
        },
      };
    }
    // Deliberately does NOT suggest pulling: that merges the pre-amend commits
    // back in, duplicating them and undoing the amend. Force-with-lease is the
    // safe recovery, and it refuses if the remote moved since the last fetch.
    return {
      message: msg('Your local history has diverged from the remote (an amend or rebase). Force-push to replace the remote commits with yours.'),
      action: {
        label: msg('Force Push'),
        callback: () => window.dispatchEvent(new CustomEvent('force-push', {
          detail: { repoPath: context?.repoPath },
        })),
      },
    };
  }

  if (
    backendText.includes('not present locally') ||
    /non-fast-?forward/.test(backendText) ||
    (backendText.includes('rejected') && context?.operation === 'push')
  ) {
    return {
      message: msg('Remote has newer changes. Pull before pushing.'),
      action: {
        label: msg('Pull Now'),
        callback: () => window.dispatchEvent(new CustomEvent('trigger-pull', {
          // Pinned like force-delete below: the toast outlives a repo switch.
          detail: { repoPath: context?.repoPath },
        })),
      },
    };
  }

  // Branch not fully merged
  if (backendText.includes('not fully merged') || backendText.includes('not yet merged')) {
    return {
      message: msg('Branch is not fully merged. Force delete if you\'re sure.'),
      action: {
        label: msg('Force Delete'),
        // repoPath travels with the branch name. The toast outlives a repo
        // switch (8s, and nothing clears toasts on switch), so resolving the
        // repo when the button is clicked force-deleted from whichever tab
        // happened to be active then — discarding unmerged commits in a repo
        // the user never aimed at.
        callback: () => window.dispatchEvent(new CustomEvent('force-delete-branch', {
          detail: { branchName: context?.branchName, repoPath: context?.repoPath },
        })),
      },
    };
  }

  // Authentication errors.
  //
  // "permission denied" alone is NOT enough: it is also what the OS says when a
  // file is read-only or held by another process, so a checkout or merge that
  // failed on a locked file was reported as an auth problem — replacing the
  // real filesystem error with "check your SSH keys" and an Open Settings
  // button. Match it only for operations that actually talk to a remote, or
  // alongside wording only an auth failure produces.
  const isNetworkOp =
    context?.operation === 'push' ||
    context?.operation === 'pull' ||
    context?.operation === 'fetch' ||
    context?.operation === 'clone' ||
    context?.operation === 'push-tag';
  if (
    // `authenticat` covers BOTH "authentication failed" and libssh2's verb form
    // ("Failed to authenticate SSH session: ..."). Scoping the permission-denied
    // axis accidentally dropped a bare `auth` match that was catching the verb;
    // restoring `auth` wholesale would also match "Author identity unknown",
    // git's message when user.name is unset.
    backendText.includes('authenticat') ||
    backendText.includes('credentials') ||
    backendText.includes('publickey') ||
    (backendText.includes('permission denied') && isNetworkOp)
  ) {
    return {
      message: msg('Authentication failed. Check your credentials or SSH keys.'),
      action: {
        label: msg('Open Settings'),
        callback: () => window.dispatchEvent(new CustomEvent('open-settings')),
      },
    };
  }

  // Rebase in progress
  if (backendText.includes('rebase in progress') || backendText.includes('rebase already started')) {
    return {
      message: msg('A rebase is already in progress. Resolve or abort it first.'),
      action: {
        label: msg('Abort Rebase'),
        callback: () => window.dispatchEvent(new CustomEvent('trigger-abort', {
          // Pinned: aborting discards the in-progress rebase AND any conflict
          // resolution — doing that to whichever tab happens to be active when
          // an 8-second toast is clicked is exactly the bug force-delete had.
          detail: { repoPath: context?.repoPath },
        })),
      },
    };
  }

  // No upstream branch
  if (backendText.includes('no upstream') || backendText.includes('no tracking') ||
      backendText.includes('does not have a commit checked out') ||
      backendText.includes('has no upstream branch')) {
    return {
      message: msg('No upstream branch configured. Push with --set-upstream to create one.'),
    };
  }

  // Operation timeout
  if (backendText.includes('timed out') || backendText.includes('operation_timeout')) {
    return {
      message: msg('Operation timed out. You can increase the timeout in Settings > Behavior.'),
      action: {
        label: msg('Open Settings'),
        callback: () => window.dispatchEvent(new CustomEvent('open-settings')),
      },
    };
  }

  // Operation cancelled
  if (backendText.includes('operation_cancelled')) {
    return {
      message: msg('Operation was cancelled.'),
    };
  }

  // git refuses a checkout that would overwrite local changes. libgit2's own
  // wording ("1 conflict prevents checkout") names neither the files nor a way
  // forward, and this path is reachable whenever Auto-Stash on Checkout is off.
  if (/conflicts? prevent(s)? checkout|would be overwritten by checkout/.test(backendText)) {
    return {
      message: msg('Your local changes would be overwritten by this checkout. Stash or commit them first, or turn on Auto-Stash on Checkout in Settings > Behavior.'),
    };
  }

  // Repository lock. Matched on a word boundary: plain `includes('lock')` also
  // matches "blocked", so a security-gate refusal ("Operation blocked by
  // security settings") was diagnosed as a stuck index.lock and sent the user
  // hunting for a file that does not exist.
  if (/\block\b|\blocked\b|index\.lock/.test(backendText)) {
    return {
      message: msg('Repository is locked by another process. Wait or remove the lock file.'),
    };
  }

  return null;
}

/**
 * Show an error toast with a suggestion if one matches, otherwise show a fallback message.
 *
 * Accepts the whole failed result (preferred) or a plain message string: the
 * rules match on the backend's own English wording, while the toast shows the
 * text `invokeCommand` already localised.
 */
export function showErrorWithSuggestion(
  error: BackendErrorLike | string | null | undefined,
  fallbackMessage: string,
  context?: ErrorContext
): void {
  const suggestion = getErrorSuggestion(backendErrorMatchText(error), context);
  const display = backendErrorDisplayText(error);
  if (suggestion) {
    showToast(suggestion.message, 'error', 8000, suggestion.action);
  } else {
    showToast(display || fallbackMessage, 'error');
  }
}
