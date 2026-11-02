/**
 * Settings Dialog — AI Quick Settings section.
 *
 * The user-facing half of the AI prompt-language feature: a 简/英 segmented
 * switch that chooses the language AI prompts (and the text the model writes
 * back) use, and a second row controlling whether that same shortcut is shown
 * in the commit panel.
 *
 * The button labels are endonyms, so they are asserted literally rather than
 * through `msg()` — they never translate.
 */

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { msg } from '@lit/localize';
import { setAppLocale } from '../../../i18n/index.ts';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_active_ai_provider':
      return null;
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    case 'get_system_capabilities':
      return {
        totalRamBytes: 17_179_869_184,
        availableRamBytes: 8_589_934_592,
        gpuInfo: null,
        recommendedTier: 'standard',
        gpuAccelerationAvailable: false,
      };
    case 'get_downloaded_models':
      return [];
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_available_models':
      return [];
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_available_diff_tools':
      return [];
    case 'get_merge_tool_info':
      return null;
    case 'get_graph_color_schemes':
      return [];
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import AFTER setting up the mock
import '../gn-settings-dialog.ts';
import type { GnSettingsDialog } from '../gn-settings-dialog.ts';
import type { GnToggle } from '../../common/gn-toggle.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

/** The `.settings-section` titled "AI Quick Settings", or null. */
function aiQuickSection(el: GnSettingsDialog): HTMLElement | null {
  return (
    (Array.from(el.shadowRoot!.querySelectorAll('.settings-section')).find(
      (section) => section.querySelector('.section-title')?.textContent?.trim() === msg('AI Quick Settings')
    ) as HTMLElement | undefined) ?? null
  );
}

/** The `.setting-row` in that section whose visible name is `name`. */
function rowByName(el: GnSettingsDialog, name: string): HTMLElement | null {
  return (
    (Array.from(aiQuickSection(el)?.querySelectorAll('.setting-row') ?? []).find(
      (row) => row.querySelector('.setting-name')?.textContent?.trim() === name
    ) as HTMLElement | undefined) ?? null
  );
}

/** The two language buttons, in switch order. */
function langButtons(el: GnSettingsDialog): HTMLButtonElement[] {
  return Array.from(
    aiQuickSection(el)?.querySelectorAll<HTMLButtonElement>('.prompt-language-switch .lang-option') ?? []
  );
}

/** Activate a `gn-toggle` the way a user does — through its inner switch. */
async function clickToggle(toggle: GnToggle): Promise<void> {
  await toggle.updateComplete;
  toggle.shadowRoot!.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
}

describe('gn-settings-dialog AI quick settings', () => {
  let el: GnSettingsDialog;

  beforeEach(async () => {
    await setAppLocale('en');
    // Deterministic starting point, whatever the store persisted before.
    settingsStore.setState({
      language: 'en',
      aiPromptLanguage: 'zh',
      showPromptLanguageSwitch: true,
    });
    el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await el.updateComplete;
  });

  afterEach(async () => {
    settingsStore.setState({ aiPromptLanguage: 'zh', showPromptLanguageSwitch: true });
    await setAppLocale('en');
  });

  it('renders the section between AI Features and Local AI Engine', () => {
    const titles = Array.from(el.shadowRoot!.querySelectorAll('.section-title')).map(
      (node) => node.textContent?.trim()
    );
    const quick = titles.indexOf(msg('AI Quick Settings'));
    expect(quick, 'the AI Quick Settings section is rendered').to.be.greaterThan(-1);
    expect(titles[quick - 1], 'comes after AI Features').to.equal(msg('AI Features'));
    expect(titles[quick + 1], 'comes before Local AI Engine').to.equal(msg('Local AI Engine'));
  });

  it('labels the row and renders a literal 简/英 segmented switch', () => {
    const row = rowByName(el, msg('AI Prompt Language'));
    expect(row, 'the AI Prompt Language row is rendered').to.exist;
    expect(row!.querySelector('.setting-description')?.textContent?.trim()).to.equal(
      msg('Language used for AI prompts and the text they generate')
    );

    const group = aiQuickSection(el)!.querySelector('.prompt-language-switch');
    expect(group, 'the segmented switch is rendered').to.exist;
    expect(group!.getAttribute('role')).to.equal('group');
    expect(group!.getAttribute('aria-label')).to.equal(msg('AI prompt language'));

    // Endonyms: never translated, so compare literally.
    const buttons = langButtons(el);
    expect(buttons.map((button) => button.textContent?.trim())).to.deep.equal(['简', '英']);
    expect(buttons.map((button) => button.getAttribute('data-lang'))).to.deep.equal(['zh', 'en']);
  });

  it('reflects the persisted prompt language on open', async () => {
    settingsStore.setState({ aiPromptLanguage: 'en' });
    const reopened = await fixture<GnSettingsDialog>(
      html`<gn-settings-dialog></gn-settings-dialog>`
    );
    await reopened.updateComplete;

    const [zh, en] = langButtons(reopened);
    expect(en.getAttribute('aria-pressed')).to.equal('true');
    expect(en.classList.contains('active')).to.be.true;
    expect(zh.getAttribute('aria-pressed')).to.equal('false');
    expect(zh.classList.contains('active')).to.be.false;
  });

  it('persists the language when 英 is clicked and announces ai-settings-changed', async () => {
    let fired = 0;
    const onSettingsChanged = (): number => (fired += 1);
    window.addEventListener('ai-settings-changed', onSettingsChanged);
    try {
      const [, en] = langButtons(el);
      en.click();
      await el.updateComplete;
      await waitUntil(
        () => langButtons(el)[1].classList.contains('active'),
        'the English half became active'
      );
    } finally {
      window.removeEventListener('ai-settings-changed', onSettingsChanged);
    }

    expect(settingsStore.getState().aiPromptLanguage).to.equal('en');
    expect(langButtons(el)[0].getAttribute('aria-pressed')).to.equal('false');
    expect(langButtons(el)[1].getAttribute('aria-pressed')).to.equal('true');
    expect(fired, 'ai-settings-changed was dispatched').to.be.greaterThan(0);
  });

  it('persists the language when 简 is clicked', async () => {
    settingsStore.setState({ aiPromptLanguage: 'en' });
    const reopened = await fixture<GnSettingsDialog>(
      html`<gn-settings-dialog></gn-settings-dialog>`
    );
    await reopened.updateComplete;

    langButtons(reopened)[0].click();
    await reopened.updateComplete;
    await waitUntil(
      () => langButtons(reopened)[0].classList.contains('active'),
      'the Chinese half became active'
    );

    expect(settingsStore.getState().aiPromptLanguage).to.equal('zh');
  });

  it('follows the store when the language is changed from elsewhere', async () => {
    settingsStore.getState().setAiPromptLanguage('en');
    await el.updateComplete;
    await waitUntil(
      () => langButtons(el)[1].classList.contains('active'),
      'the dialog mirrored the external language change'
    );

    settingsStore.getState().setAiPromptLanguage('zh');
    await el.updateComplete;
    await waitUntil(
      () => langButtons(el)[0].classList.contains('active'),
      'the dialog mirrored the second external change'
    );
  });

  it('renders the visibility row and toggles it from the dialog', async () => {
    const row = rowByName(el, msg('Show prompt-language switch'));
    expect(row, 'the visibility row is rendered').to.exist;
    expect(row!.querySelector('.setting-description')?.textContent?.trim()).to.equal(
      msg('Show the 简/英 shortcut in the commit panel')
    );

    const toggle = row!.querySelector<GnToggle>('gn-toggle');
    expect(toggle, 'the row has a switch').to.exist;
    expect(toggle!.checked).to.be.true;

    await clickToggle(toggle!);
    await el.updateComplete;

    expect(settingsStore.getState().showPromptLanguageSwitch).to.be.false;
    await waitUntil(
      () => row!.querySelector<GnToggle>('gn-toggle')!.checked === false,
      'the switch shows the persisted off state'
    );
  });

  it('reflects a visibility change made from elsewhere', async () => {
    settingsStore.getState().setShowPromptLanguageSwitch(false);
    await el.updateComplete;
    await waitUntil(
      () => rowByName(el, msg('Show prompt-language switch'))
        ?.querySelector<GnToggle>('gn-toggle')?.checked === false,
      'the dialog mirrored the external visibility change'
    );
  });
});
