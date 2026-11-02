/**
 * Settings Dialog — Language row.
 *
 * The language picker is the user-facing half of runtime localisation: it lists
 * the locales we ship, persists the choice, and the dialog around it has to
 * re-render in the new language on the spot — no restart, no reopening.
 */

import { expect, fixture, html, waitUntil } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  switch (command) {
    // Two REAL `AiProviderInfo`s. With none, the entire API-key provider block
    // rendered nothing, so `Configured`, `Not configured` and `✗ Failed` — the
    // pills the `.status-indicator` selector below was widened FOR — were never
    // on screen to compare. One has a key and one does not, so both pills show.
    case 'get_ai_providers':
      return [
        {
          providerType: 'open_ai',
          name: 'OpenAI',
          available: false,
          probed: true,
          requiresApiKey: true,
          hasApiKey: true,
          endpoint: 'https://api.openai.com/v1',
          models: ['gpt-4o'],
          selectedModel: 'gpt-4o',
        },
        {
          providerType: 'anthropic',
          name: 'Anthropic',
          available: false,
          probed: true,
          requiresApiKey: true,
          hasApiKey: false,
          endpoint: 'https://api.anthropic.com',
          models: [],
          selectedModel: null,
        },
      ];
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    // A REAL `SystemCapabilities`. The old literal used none of the interface's
    // field names, so `recommendedTier` was undefined, the Local AI status pill
    // rendered empty, and the comparison below could not see the English it
    // would otherwise have contained.
    case 'get_system_capabilities':
      return {
        totalRamBytes: 17_179_869_184,
        availableRamBytes: 8_589_934_592,
        gpuInfo: null,
        recommendedTier: 'standard',
        gpuAccelerationAvailable: false,
      };
    // At least one model, for the same reason: with an empty registry no model
    // row exists, so nothing inside it is ever compared.
    case 'get_available_models':
      return [
        {
          id: 'qwen2.5-coder-1.5b',
          displayName: 'Qwen2.5 Coder 1.5B',
          hfRepo: 'org/repo',
          hfFilename: 'model.gguf',
          sha256: 'x'.repeat(64),
          sizeBytes: 1_073_741_824,
          minRamBytes: 8_589_934_592,
          tier: 'ultra_light',
          architecture: 'qwen2',
          contextLength: 32_768,
        },
      ];
    // The model above, downloaded AND loaded. Without a downloaded model the
    // model row only ever offers `Download`, so `Loaded` — named in the comment
    // on the guard below — could not render either.
    case 'get_downloaded_models':
      return [
        {
          id: 'qwen2.5-coder-1.5b',
          displayName: 'Qwen2.5 Coder 1.5B',
          sizeBytes: 1_073_741_824,
          path: '/models/qwen2.5-coder-1.5b.gguf',
          status: 'ready',
        },
      ];
    // `LocalModelStatus`, and the name the engine reports for what it loaded.
    // The old `get_local_model_status` mock answered a command nothing invokes
    // (`local-ai.service.ts:168` asks for `get_model_status`), so the Engine
    // Status row never rendered at all.
    case 'get_model_status':
      return 'ready';
    case 'get_loaded_model_name':
      return 'Qwen2.5 Coder 1.5B';
    // A second model, not downloaded, so the "Recommended" row renders too.
    case 'get_recommended_model':
      return {
        id: 'qwen2.5-coder-7b',
        displayName: 'Qwen2.5 Coder 7B',
        hfRepo: 'org/repo-7b',
        hfFilename: 'model-7b.gguf',
        sha256: 'y'.repeat(64),
        sizeBytes: 4_294_967_296,
        minRamBytes: 17_179_869_184,
        tier: 'standard',
        architecture: 'qwen2',
        contextLength: 32_768,
      };
    case 'get_available_diff_tools':
    case 'get_available_merge_tools':
    case 'list_diff_tools':
      return [];
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_merge_tool_config':
      return { toolName: null, toolCmd: null };
    case 'get_diff_tool':
      return { tool: null, cmd: null, prompt: false };
    default:
      return null;
  }
};

let nextCallbackId = 1;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => nextCallbackId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// Import AFTER setting up the mock
import '../gn-settings-dialog.ts';
import type { GnSettingsDialog } from '../gn-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { getAppLocale, setAppLocale } from '../../../i18n/index.ts';

function select(el: GnSettingsDialog): HTMLSelectElement {
  const node = el.shadowRoot?.querySelector<HTMLSelectElement>('#language-select');
  expect(node, 'language select exists').to.exist;
  return node as HTMLSelectElement;
}

function sectionTitles(el: GnSettingsDialog): string[] {
  return Array.from(el.shadowRoot?.querySelectorAll('.section-title') ?? []).map(
    (node) => node.textContent?.trim() ?? ''
  );
}

async function choose(el: GnSettingsDialog, locale: string): Promise<void> {
  const languageSelect = select(el);
  languageSelect.value = locale;
  languageSelect.dispatchEvent(new Event('change'));
}

describe('gn-settings-dialog language setting', () => {
  let el: GnSettingsDialog;

  beforeEach(async () => {
    await setAppLocale('en');
    settingsStore.setState({ language: 'en' });
    el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await el.updateComplete;
  });

  afterEach(async () => {
    settingsStore.setState({ language: 'en' });
    await setAppLocale('en');
  });

  it('lists every locale the app ships, in English by default', () => {
    const options = Array.from(select(el).options).map((o) => ({
      value: o.value,
      label: o.textContent?.trim(),
    }));
    expect(options).to.deep.equal([
      { value: 'en', label: 'English' },
      { value: 'fr', label: 'Français' },
      { value: 'zh', label: '中文' },
    ]);
    expect(select(el).value).to.equal('en');
    expect(sectionTitles(el)[0]).to.equal('Appearance');
  });

  it('persists the choice and re-renders the dialog without a reload', async () => {
    let changed = 0;
    const onChange = (): number => (changed += 1);
    window.addEventListener('settings-changed', onChange);

    await choose(el, 'fr');

    await waitUntil(
      () => sectionTitles(el)[0] === 'Apparence',
      'the settings dialog re-rendered in French'
    );
    window.removeEventListener('settings-changed', onChange);

    expect(settingsStore.getState().language).to.equal('fr');
    expect(getAppLocale()).to.equal('fr');
    expect(sectionTitles(el)).to.include('Sécurité');
    // The toggle rows take their label from the same strings.
    const toggleLabels = Array.from(el.shadowRoot?.querySelectorAll('.setting-name') ?? []).map(
      (node) => node.textContent?.trim()
    );
    expect(toggleLabels).to.include('Mode hors ligne');
    expect(changed, 'settings-changed was dispatched once').to.equal(1);
  });

  it('persists the choice and re-renders the dialog in Chinese', async () => {
    let changed = 0;
    const onChange = (): number => (changed += 1);
    window.addEventListener('settings-changed', onChange);

    await choose(el, 'zh');

    await waitUntil(
      () => sectionTitles(el)[0] === '外观',
      'the settings dialog re-rendered in Chinese'
    );
    window.removeEventListener('settings-changed', onChange);

    expect(settingsStore.getState().language).to.equal('zh');
    expect(getAppLocale()).to.equal('zh');
    expect(sectionTitles(el)).to.include('安全');
    // The toggle rows take their label from the same strings.
    const toggleLabels = Array.from(el.shadowRoot?.querySelectorAll('.setting-name') ?? []).map(
      (node) => node.textContent?.trim()
    );
    expect(toggleLabels).to.include('离线模式');
    expect(changed, 'settings-changed was dispatched once').to.equal(1);
  });

  it('keeps the select in step with the persisted locale when reopened', async () => {
    await choose(el, 'fr');
    await waitUntil(() => settingsStore.getState().language === 'fr');

    const reopened = await fixture<GnSettingsDialog>(
      html`<gn-settings-dialog></gn-settings-dialog>`
    );
    await reopened.updateComplete;
    await waitUntil(() => select(reopened).value === 'fr', 'the reopened dialog shows French');
    expect(select(reopened).options[0].textContent?.trim()).to.equal('English');
  });

  it('switches back to English', async () => {
    await choose(el, 'fr');
    await waitUntil(() => sectionTitles(el)[0] === 'Apparence');

    await choose(el, 'en');
    await waitUntil(
      () => sectionTitles(el)[0] === 'Appearance',
      'the settings dialog went back to English'
    );
    expect(settingsStore.getState().language).to.equal('en');
  });

  /**
   * A half-translated screen is worse than an untranslated one, and the way it
   * happens is that one branch re-words a string another branch already
   * translated: the `@lit/localize` id is a hash of the source text, so the
   * merge is clean and the translation silently detaches.
   *
   * This used to name a handful of expected French labels, so a row it did not
   * happen to list could go back to English unnoticed. It now renders the whole
   * dialog twice and compares the two sets: any text that survives the switch
   * unchanged — other than the legitimate exceptions the caller names — is
   * English that leaked into the localised UI. It runs for every locale we
   * ship, so adding a language cannot ship a half-translated screen unnoticed.
   */
  async function expectNothingLeftInEnglish(
    locale: string,
    sectionTitle: string,
    /** Text that legitimately reads the same in both languages. */
    sameInTarget: string[]
  ): Promise<void> {
    // `.error-text` is the AI banner: its message is a string built when the
    // error happens, so it is provoked in each language below rather than
    // relying on the re-render. Without it here, a bare template rendered
    // into the banner showed English under "fr" with nothing to catch it.
    // `.status-indicator` earns its place here: the stack localised several of
    // these pills while the Local AI tier pill beside them stayed English, and
    // this selector could not see it. Which pills it can actually see depends
    // entirely on the mocks at the top of this file — the selector was widened
    // once while they kept every one of those regions empty — so the control
    // block below asserts each named pill is really in the comparison.
    const LOCALISED =
      '.section-title, .setting-name, .setting-description, .error-text, .status-indicator';
    // The mock answers `test_ai_provider` with nothing, which the dialog
    // reports as the provider being unavailable.
    const provokeAiError = async (): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleTestProvider('open_ai');
      await el.updateComplete;
    };
    const visibleText = (): Set<string> =>
      new Set(
        Array.from(el.shadowRoot?.querySelectorAll(LOCALISED) ?? []).map(
          (node) => node.textContent?.trim() ?? ''
        )
      );

    await provokeAiError();
    const english = visibleText();
    expect(english.size, 'the dialog rendered its rows in English').to.be.greaterThan(50);
    expect(
      [...english].some((text) => text.includes('OpenAI is not available')),
      'control: the AI banner is on screen and part of the comparison'
    ).to.be.true;
    // Every pill the comment above names, proved present rather than assumed:
    // a mock trimmed back to `[]` would empty these regions again and quietly
    // narrow the comparison to nothing.
    for (const pill of ['Configured', 'Not configured', '✗ Failed', 'Loaded', 'Model Loaded']) {
      expect(
        english.has(pill),
        `control: the "${pill}" pill is on screen and part of the comparison`
      ).to.be.true;
    }
    expect(
      [...english].some((text) => text.startsWith('Recommended:')),
      'control: the recommended-model row is part of the comparison'
    ).to.be.true;

    await choose(el, locale);
    await waitUntil(
      () => sectionTitles(el)[0] === sectionTitle,
      `the settings dialog switched to "${locale}"`
    );
    await provokeAiError();

    const allowed = new Set(sameInTarget);
    const leftInEnglish = [...visibleText()].filter(
      (text) => text !== '' && english.has(text) && !allowed.has(text)
    );
    expect(
      leftInEnglish,
      `${leftInEnglish.length} label(s) render the same text under "${locale}" as under "en" — ` +
        `their translation is missing or detached from the source string:\n` +
        leftInEnglish.map((text) => `  ${JSON.stringify(text)}`).join('\n')
    ).to.deep.equal([]);
  }

  it('leaves no English text behind when the dialog switches to French', async () => {
    // `Port` is a word French borrows unchanged. The model name is registry
    // DATA, not a label: it is the product's own name and reads identically in
    // every locale, so it is not evidence of a missing translation.
    await expectNothingLeftInEnglish('fr', 'Apparence', ['Port', 'Qwen2.5 Coder 1.5B']);
  });

  it('leaves no English text behind when the dialog switches to Chinese', async () => {
    // The model name is registry DATA from the backend, not a translatable
    // label — it reads the same in every locale.
    await expectNothingLeftInEnglish('zh', '外观', ['Qwen2.5 Coder 1.5B']);
  });

  it('localises the menu labels that live in the settings store', async () => {
    // The whitespace menu's labels are built in the settings store, not in this
    // component, so they have to be localised there rather than baked into a
    // module-level constant that freezes at the startup locale.
    await choose(el, 'fr');
    await waitUntil(() => sectionTitles(el)[0] === 'Apparence');

    const options = Array.from(
      el.shadowRoot?.querySelectorAll('#diff-whitespace-select option') ?? []
    ).map((option) => option.textContent?.trim());
    expect(options).to.deep.equal([
      'Afficher tous les espaces',
      'Ignorer les espaces en fin de ligne',
      "Ignorer les modifications d'espaces",
      'Ignorer tous les espaces',
    ]);
  });

  it('localises the settings-store menu labels in Chinese too', async () => {
    await choose(el, 'zh');
    await waitUntil(() => sectionTitles(el)[0] === '外观');

    const options = Array.from(
      el.shadowRoot?.querySelectorAll('#diff-whitespace-select option') ?? []
    ).map((option) => option.textContent?.trim());
    expect(options).to.deep.equal([
      '显示所有空白字符',
      '忽略行尾空白字符',
      '忽略空白字符改动',
      '忽略所有空白字符',
    ]);
  });

  it('falls back to English when asked for a locale the app does not ship', async () => {
    const applied = await settingsStore.getState().setLanguage('xx-YY');
    expect(applied).to.equal('en');
    expect(settingsStore.getState().language).to.equal('en');
    await el.updateComplete;
    expect(sectionTitles(el)[0]).to.equal('Appearance');
  });

  it('maps a regional tag onto the locale it ships', async () => {
    const applied = await settingsStore.getState().setLanguage('fr-CA');
    expect(applied).to.equal('fr');
    expect(settingsStore.getState().language).to.equal('fr');

    // Chinese ships as a single translation, so every zh-* tag lands on it.
    const chinese = await settingsStore.getState().setLanguage('zh-CN');
    expect(chinese).to.equal('zh');
    expect(settingsStore.getState().language).to.equal('zh');
  });

  it('resets the language along with every other preference', async () => {
    await settingsStore.getState().setLanguage('fr');
    expect(settingsStore.getState().language).to.equal('fr');

    settingsStore.getState().resetToDefaults();

    // The fresh-install default is Chinese, so a reset returns the UI to 中文.
    expect(settingsStore.getState().language).to.equal('zh');
    await waitUntil(() => getAppLocale() === 'zh', 'the reset put the locale back to Chinese');
  });
});
