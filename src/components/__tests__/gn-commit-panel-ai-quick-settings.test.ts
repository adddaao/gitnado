/**
 * AI prompt-language quick switch in the commit panel header.
 *
 * The switch exposes the same persisted setting as Settings → "AI Quick
 * Settings": it is visible only while `showPromptLanguageSwitch` is on (absent
 * from the DOM entirely, not merely hidden), it survives a language change made
 * elsewhere while the panel is mounted, and it writes the store when clicked.
 *
 * The button labels are endonyms, so they are asserted literally rather than
 * through `msg()` — they never translate.
 */

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { msg } from '@lit/localize';

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;

const mockInvoke: MockInvoke = async (command: string) => {
  switch (command) {
    case 'list_templates':
      return [];
    case 'get_conventional_types':
      return [
        { typeName: 'feat', description: 'A new feature', emoji: '✨' },
        { typeName: 'fix', description: 'A bug fix', emoji: '🐛' },
      ];
    case 'get_commit_template':
      return null;
    case 'get_user_identity':
      return { name: 'Test User', email: 'test@example.com' };
    // Deliberately unavailable: the quick switch is a preference control, so it
    // must render regardless of whether AI is currently usable.
    case 'is_ai_available':
      return false;
    case 'get_commit_history':
      return [];
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// Mock the Tauri event plugin internals (used by @tauri-apps/api/event)
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => {
    void once;
    void callback;
    return 0;
  },
  unregisterListener: (_event: string, _eventId: number) => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { repositoryStore } from '../../stores/repository.store.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import type { GnCommitPanel } from '../sidebar/gn-commit-panel.ts';
import '../sidebar/gn-commit-panel.ts';

const REPO_PATH = '/test/repo';

function setupStore(): void {
  repositoryStore.getState().addRepository({
    path: REPO_PATH,
    name: 'test-repo',
    isValid: true,
    isBare: false,
    headRef: null,
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  });
  repositoryStore.getState().setCurrentBranch({
    name: 'main',
    shorthand: 'main',
    isHead: true,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
  });
}

async function renderCommitPanel(stagedCount = 1): Promise<GnCommitPanel> {
  const el = await fixture<GnCommitPanel>(
    html`<gn-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${stagedCount}></gn-commit-panel>`
  );
  await el.updateComplete;
  return el;
}

/** The header's segmented switch, or null when it should not be rendered. */
function quickSwitch(el: GnCommitPanel): HTMLElement | null {
  return el.shadowRoot!.querySelector<HTMLElement>('.header-actions .prompt-language-switch');
}

function langButtons(el: GnCommitPanel): HTMLButtonElement[] {
  return Array.from(quickSwitch(el)?.querySelectorAll<HTMLButtonElement>('.lang-option') ?? []);
}

describe('gn-commit-panel AI prompt-language quick switch', () => {
  beforeEach(() => {
    setupStore();
    settingsStore.setState({
      aiPromptLanguage: 'zh',
      showPromptLanguageSwitch: true,
    });
  });

  afterEach(() => {
    repositoryStore.getState().reset();
    settingsStore.setState({
      aiPromptLanguage: 'zh',
      showPromptLanguageSwitch: true,
    });
  });

  it('renders a literal 简/英 switch in the header even when AI is unavailable', async () => {
    const el = await renderCommitPanel();

    const group = quickSwitch(el);
    expect(group, 'the quick switch is rendered').to.exist;
    expect(group!.getAttribute('role')).to.equal('group');
    expect(group!.getAttribute('aria-label')).to.equal(msg('AI prompt language'));

    // AI is mocked unavailable, yet the preference control is still offered.
    expect(el.shadowRoot!.querySelector('.generate-btn.ai-ready')).to.be.null;

    const buttons = langButtons(el);
    expect(buttons.map((button) => button.textContent?.trim())).to.deep.equal(['简', '英']);
    expect(buttons.map((button) => button.getAttribute('data-lang'))).to.deep.equal(['zh', 'en']);
    expect(buttons[0].getAttribute('aria-pressed')).to.equal('true');
    expect(buttons[0].classList.contains('active')).to.be.true;
    expect(buttons[1].getAttribute('aria-pressed')).to.equal('false');
  });

  it('sits before the generate button in the header actions', async () => {
    const el = await renderCommitPanel();
    const group = quickSwitch(el)!;
    const generate = el.shadowRoot!.querySelector('.generate-btn')!;

    expect(
      group.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the switch precedes the generate button'
    ).to.not.equal(0);
  });

  it('is absent from the DOM when the setting is off', async () => {
    settingsStore.setState({ showPromptLanguageSwitch: false });
    const el = await renderCommitPanel();

    expect(quickSwitch(el)).to.be.null;
  });

  it('persists the language when 英 is clicked and updates the active half', async () => {
    const el = await renderCommitPanel();
    langButtons(el)[1].click();
    await el.updateComplete;
    await waitUntil(
      () => langButtons(el)[1].classList.contains('active'),
      'the English half became active'
    );

    expect(settingsStore.getState().aiPromptLanguage).to.equal('en');
    expect(langButtons(el)[0].getAttribute('aria-pressed')).to.equal('false');
    expect(langButtons(el)[1].getAttribute('aria-pressed')).to.equal('true');
  });

  it('follows a language change made elsewhere while the panel is mounted', async () => {
    const el = await renderCommitPanel();
    expect(langButtons(el)[0].classList.contains('active')).to.be.true;

    settingsStore.getState().setAiPromptLanguage('en');
    await waitUntil(
      () => langButtons(el)[1].classList.contains('active'),
      'the panel mirrored the external language change'
    );
    expect(langButtons(el)[0].getAttribute('aria-pressed')).to.equal('false');
  });

  it('follows the visibility setting made elsewhere while the panel is mounted', async () => {
    const el = await renderCommitPanel();
    expect(quickSwitch(el)).to.exist;

    settingsStore.getState().setShowPromptLanguageSwitch(false);
    await waitUntil(
      () => quickSwitch(el) === null,
      'the switch was removed from the DOM'
    );

    settingsStore.getState().setShowPromptLanguageSwitch(true);
    await waitUntil(
      () => quickSwitch(el) !== null,
      'the switch came back'
    );
  });
});
