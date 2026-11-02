/**
 * Backend error text localisation.
 *
 * The Rust side sends user-facing English sentences with a stable `code`;
 * `invokeCommand` translates them once, using that code, and keeps the original
 * for the rules that match on the backend's own wording. The invariants pinned
 * here:
 *
 * - under the source locale the output is byte-identical to the backend's
 *   message (every existing assertion, log line and e2e expectation keeps
 *   working, and the catalogue stays checkable against the Rust formats);
 * - the payload of a `prefix + payload` message is never translated — it is
 *   git's/ the OS's output;
 * - anything this module does not recognise passes through untouched.
 */

import { expect } from '@open-wc/testing';

// No IPC in this file; the module is pure.
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
};

import { setAppLocale } from '../../i18n/index.ts';
import {
  backendErrorDisplayText,
  backendErrorMatchText,
  localizeBackendError,
} from '../backend-error.service.ts';

/** One sample per mapped code, using the exact text Rust's `Display` produces. */
const SAMPLES: ReadonlyArray<[code: string, en: string, zh: string]> = [
  ['REPO_NOT_OPEN', 'Repository not open', '仓库未打开'],
  ['AUTH_REQUIRED', 'Authentication required', '需要身份验证'],
  ['MERGE_CONFLICT', 'Merge conflict', '合并冲突'],
  ['REBASE_IN_PROGRESS', 'Rebase in progress', '正在 rebase'],
  ['REBASE_PAUSED', 'Rebase paused', 'rebase 已暂停'],
  ['CHERRY_PICK_CONFLICT', 'Cherry-pick conflict', 'cherry-pick 冲突'],
  ['REVERT_IN_PROGRESS', 'Revert in progress', '正在还原'],
  ['INVALID_REFERENCE', 'Invalid reference', '无效的引用'],
  ['OPERATION_CANCELLED', 'Operation cancelled', '操作已取消'],
  ['GIT_ERROR', 'Git error: reference is not a tree', 'Git 错误：reference is not a tree'],
  [
    'OPERATION_FAILED',
    'Operation failed: No such remote \'origin\'',
    '操作失败：No such remote \'origin\'',
  ],
  ['REPO_NOT_FOUND', 'Repository not found: /tmp/repo', '找不到仓库：/tmp/repo'],
  ['BRANCH_NOT_FOUND', 'Branch not found: main', '找不到分支：main'],
  ['FILE_NOT_FOUND', 'File not found: README.md', '找不到文件：README.md'],
  ['OAUTH_ERROR', 'OAuth error: state mismatch', 'OAuth 错误：state mismatch'],
  ['OPERATION_TIMEOUT', 'Operation timed out: push', '操作超时：push'],
  ['NO_TAGS_REACHABLE', 'No tags reachable from abc1234', '无法从 abc1234 找到标签'],
];

describe('backend-error.service', () => {
  afterEach(async () => {
    await setAppLocale('en');
  });

  describe('under the source locale', () => {
    it('renders every mapped message exactly as the backend wrote it', () => {
      for (const [code, en] of SAMPLES) {
        expect(localizeBackendError(code, en), code).to.equal(en);
      }
    });
  });

  describe('in Chinese', () => {
    beforeEach(async () => {
      await setAppLocale('zh');
    });

    it('translates the fixed sentences', () => {
      for (const [code, en, zh] of SAMPLES) {
        expect(localizeBackendError(code, en), code).to.equal(zh);
      }
    });

    it('keeps the git/os payload untouched inside a translated frame', () => {
      const localized = localizeBackendError(
        'OPERATION_FAILED',
        'Operation failed: fatal: unable to access \'https://example/repo\': 403'
      );
      expect(localized).to.equal("操作失败：fatal: unable to access 'https://example/repo': 403");
    });
  });

  describe('unrecognised input', () => {
    it('passes an unknown code through untouched', () => {
      expect(localizeBackendError('SOMETHING_NEW', 'Backend says hi')).to.equal('Backend says hi');
    });

    it('passes a message whose shape does not match its code through untouched', async () => {
      await setAppLocale('zh');
      // Code says OPERATION_FAILED but the text carries no "Operation failed: "
      // frame — a bespoke sentence must never be replaced by a generic one.
      expect(localizeBackendError('OPERATION_FAILED', 'Something bespoke happened')).to.equal(
        'Something bespoke happened'
      );
    });

    it('passes messages with no code — a thrown JS Error — through untouched', () => {
      expect(localizeBackendError(undefined, 'plain failure')).to.equal('plain failure');
      expect(localizeBackendError('COMMAND_ERROR', 'plain failure')).to.equal('plain failure');
    });

    it('leaves codes with bespoke per-call sentences alone', async () => {
      await setAppLocale('zh');
      const blocked = 'Blocked by offline mode: fetching from example.com';
      expect(localizeBackendError('BLOCKED', blocked)).to.equal(blocked);
      const inFlight = 'A push is already running for this repository';
      expect(localizeBackendError('REMOTE_OPERATION_IN_FLIGHT', inFlight)).to.equal(inFlight);
    });

    it('treats an empty message as nothing to translate', () => {
      expect(localizeBackendError('REPO_NOT_OPEN', '')).to.equal('');
    });
  });

  describe('matching vs display text', () => {
    it('matches on the backend wording and displays the localised one', async () => {
      await setAppLocale('zh');
      const error = {
        code: 'OPERATION_FAILED',
        message: localizeBackendError('OPERATION_FAILED', 'Operation failed: boom'),
        originalMessage: 'Operation failed: boom',
      };
      expect(backendErrorMatchText(error)).to.equal('Operation failed: boom');
      expect(backendErrorDisplayText(error)).to.equal('操作失败：boom');
    });

    it('falls back to the message when no original was kept', () => {
      const error = { code: 'BLOCKED', message: 'Blocked' };
      expect(backendErrorMatchText(error)).to.equal('Blocked');
      expect(backendErrorDisplayText(error)).to.equal('Blocked');
    });

    it('accepts a plain string, for frontend-created errors', () => {
      expect(backendErrorMatchText('nope')).to.equal('nope');
      expect(backendErrorDisplayText('nope')).to.equal('nope');
      expect(backendErrorMatchText(undefined)).to.equal('');
      expect(backendErrorDisplayText(null)).to.equal('');
    });
  });
});
