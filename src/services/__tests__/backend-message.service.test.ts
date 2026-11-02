/**
 * Backend success/event text localisation.
 *
 * Rust composes the text for successful operations too (branch-switch
 * confirmations, the multi-remote summaries, …) and the frontend toasts it
 * verbatim. These messages have no code, so the catalogue matches the backend's
 * English templates; what is pinned here:
 *
 * - under the source locale the text is byte-identical (existing assertions stay
 *   valid, and the catalogue can be checked against the Rust formats);
 * - parameters (branch names, counts) survive translation;
 * - anything not recognised — technical progress text, user content, a message
 *   added backend-side without a rule — passes through untouched.
 */

import { expect } from '@open-wc/testing';

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
};

import { setAppLocale } from '../../i18n/index.ts';
import {
  hasBackendMessageRule,
  localizeBackendMessage,
} from '../backend-message.service.ts';

/** One sample per rule, with the exact text the Rust side formats. */
const SAMPLES: ReadonlyArray<[en: string, zh: string]> = [
  [
    'Switched to main',
    '已切换到 main',
  ],
  [
    'Switched to main and re-applied stashed changes',
    '已切换到 main，并重新应用了贮藏的修改',
  ],
  [
    'Switched to main and re-applied stashed changes (staged status was not preserved)',
    '已切换到 main，并重新应用了贮藏的修改（暂存状态未保留）',
  ],
  [
    'Switched to main but failed to re-apply stash: conflict in file.txt. Your changes remain stashed.',
    '已切换到 main，但重新应用贮藏失败：conflict in file.txt。你的修改仍保存在贮藏中。',
  ],
  [
    'Switched to main, but your stashed changes could not be found to re-apply. They are still in the stash list — apply them manually.',
    '已切换到 main，但未能找到要重新应用的贮藏修改。它们仍在贮藏列表中——请手动应用。',
  ],
  ['Failed to stash changes: index locked', '贮藏修改失败：index locked'],
  ['Garbage collection failed: boom', '垃圾回收失败：boom'],
  ['Pushed to 3 remote(s) (1 failed)', '已推送到 3 个远程（1 个失败）'],
  ['Fetched from 2 remotes (0 failed)', '已从 2 个远程获取（0 个失败）'],
  ['Fetch completed successfully', '获取完成'],
  ['Bisect session started', 'bisect 会话已开始'],
];

describe('backend-message.service', () => {
  afterEach(async () => {
    await setAppLocale('en');
  });

  it('recognises every backend template it claims to', () => {
    for (const [en] of SAMPLES) {
      expect(hasBackendMessageRule(en), en).to.be.true;
    }
  });

  describe('under the source locale', () => {
    it('renders each template byte-identically to the backend text', () => {
      for (const [en] of SAMPLES) {
        expect(localizeBackendMessage(en)).to.equal(en);
      }
    });
  });

  describe('in Chinese', () => {
    beforeEach(async () => {
      await setAppLocale('zh');
    });

    it('translates the templates and keeps their parameters', () => {
      for (const [en, zh] of SAMPLES) {
        expect(localizeBackendMessage(en), en).to.equal(zh);
      }
    });
  });

  describe('anything it does not recognise', () => {
    it('passes technical progress text through untouched', async () => {
      await setAppLocale('zh');
      expect(localizeBackendMessage('Receiving objects: 42% (42/100)')).to.equal(
        'Receiving objects: 42% (42/100)'
      );
    });

    it('passes user content through untouched', async () => {
      await setAppLocale('zh');
      // The rules are anchored to the backend's sentence starts, so a commit
      // subject (or a file name) that merely mentions the wording is not
      // rewritten. A message that begins exactly like a backend sentence is
      // indistinguishable from one — which is why the rules stay anchored and
      // narrow rather than matching anywhere in the string.
      const commitMessage = 'Refactor: switched to the new auth flow';
      expect(localizeBackendMessage(commitMessage)).to.equal(commitMessage);
    });

    it('passes an empty string through', () => {
      expect(localizeBackendMessage('')).to.equal('');
    });
  });
});
