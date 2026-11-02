/**
 * Settings Dialog MCP Tests
 *
 * The MCP server configuration is persisted on the backend, so the dialog must
 * save the port when it changes, report a failed save instead of swallowing it,
 * explain why the server is stopped after a failed launch-time start, and let the
 * user turn off a start that keeps failing.
 */

import { expect, fixture, html } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

interface InvokedCommand {
  command: string;
  args?: unknown;
}

const invoked: InvokedCommand[] = [];

let mcpStatus: Record<string, unknown> = {
  running: false,
  port: 3001,
  url: null,
  lastError: null,
};
let setMcpConfigError: string | null = null;
let mcpConfig: Record<string, unknown> = {
  enabled: false,
  port: 3001,
  allowedOrigins: [],
  authToken: 'token-abc123',
};
/** Answer for showConfirm(): 'Ok' confirms, anything else cancels */
let confirmAnswer = 'Ok';
let regenerateError: string | null = null;
let regeneratedToken = 'token-new456';
/** Values handed to navigator.clipboard.writeText */
const copied: string[] = [];
let clipboardFails = false;

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  invoked.push({ command, args });

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    case 'get_system_capabilities':
      return { hasGpu: false, gpuName: null, totalRam: 8 };
    case 'get_downloaded_models':
    case 'get_available_models':
    case 'get_available_diff_tools':
    case 'get_graph_color_schemes':
      return [];
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_mcp_status':
      return mcpStatus;
    case 'get_mcp_config':
      return mcpConfig;
    case 'set_mcp_config':
      if (setMcpConfigError) throw new Error(setMcpConfigError);
      // The backend owns the token: a save never carries or replaces it
      mcpConfig = {
        ...(args as { config: Record<string, unknown> }).config,
        authToken: mcpConfig.authToken,
      };
      return null;
    case 'regenerate_mcp_token':
      if (regenerateError) throw new Error(regenerateError);
      mcpConfig = { ...mcpConfig, authToken: regeneratedToken };
      return regeneratedToken;
    // showConfirm() resolves true when the dialog plugin answers 'Ok'
    case 'plugin:dialog|message':
      return confirmAnswer;
    case 'start_mcp_server':
      return null;
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
import { uiStore } from '../../../stores/ui.store.ts';
import { setAppLocale } from '../../../i18n/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Let the awaited invoke chain behind a click settle, then re-render */
async function flush(el: GnSettingsDialog): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    await el.updateComplete;
  }
}

describe('gn-settings-dialog MCP settings', () => {
  beforeEach(() => {
    invoked.length = 0;
    setMcpConfigError = null;
    mcpStatus = { running: false, port: 3001, url: null, lastError: null };
    mcpConfig = { enabled: false, port: 3001, allowedOrigins: [], authToken: 'token-abc123' };
    confirmAnswer = 'Ok';
    regenerateError = null;
    regeneratedToken = 'token-new456';
    copied.length = 0;
    clipboardFails = false;
    uiStore.setState({ toasts: [] });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          if (clipboardFails) return Promise.reject(new Error('denied'));
          copied.push(value);
          return Promise.resolve();
        },
      },
    });
  });

  it('persists the port when it changes', async () => {
    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);

    await (el as any).handleMcpPortChange({ target: { value: '4321' } } as unknown as Event);
    await el.updateComplete;

    const saves = invoked.filter((c) => c.command === 'set_mcp_config');
    expect(saves.length).to.equal(1);
    expect(saves[0].args).to.deep.equal({
      config: { enabled: false, port: 4321, allowedOrigins: [] },
    });
  });

  it('keeps the server enabled when the port changes after a failed start', async () => {
    mcpConfig = { enabled: true, port: 3001, allowedOrigins: [] };
    mcpStatus = {
      running: false,
      port: 3001,
      url: null,
      lastError: 'Failed to bind to 127.0.0.1:3001: Address already in use',
    };

    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await (el as any).loadMcpStatus();

    await (el as any).handleMcpPortChange({ target: { value: '4321' } } as unknown as Event);
    await el.updateComplete;

    const saves = invoked.filter((c) => c.command === 'set_mcp_config');
    expect(saves[saves.length - 1].args).to.deep.equal({
      config: { enabled: true, port: 4321, allowedOrigins: [] },
    });
  });

  it('shows an error when saving the MCP config fails', async () => {
    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);

    setMcpConfigError = 'Failed to write MCP config: disk full';
    await (el as any).handleMcpToggle();
    await el.updateComplete;

    // The server must not be started when its configuration could not be saved
    expect(invoked.some((c) => c.command === 'start_mcp_server')).to.be.false;

    const errorText = el.shadowRoot?.textContent ?? '';
    expect(errorText).to.contain('Failed to write MCP config: disk full');
  });

  it('shows why the MCP server is stopped after a failed auto-start', async () => {
    mcpConfig = { enabled: true, port: 3001, allowedOrigins: [] };
    mcpStatus = {
      running: false,
      port: 3001,
      url: null,
      lastError: 'Failed to bind to 127.0.0.1:3001: Address already in use',
    };

    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    // loadMcpStatus runs on connect; wait for the resulting render
    await (el as any).loadMcpStatus();
    await el.updateComplete;

    const rendered = el.shadowRoot?.textContent ?? '';
    expect(rendered).to.contain('Failed to bind to 127.0.0.1:3001: Address already in use');
  });

  it('offers a disable action when the server is enabled but it is not running', async () => {
    mcpConfig = { enabled: true, port: 3001, allowedOrigins: [] };
    mcpStatus = {
      running: false,
      port: 3001,
      url: null,
      lastError: 'Failed to bind to 127.0.0.1:3001: Address already in use',
    };

    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await (el as any).loadMcpStatus();
    await el.updateComplete;

    const disable = el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-disable');
    expect(disable, 'an enabled-but-stopped server must offer a way out').to.exist;

    disable?.click();
    await flush(el);

    const saves = invoked.filter((c) => c.command === 'set_mcp_config');
    expect(saves[saves.length - 1].args).to.deep.equal({
      config: { enabled: false, port: 3001, allowedOrigins: [] },
    });

    // The disabled server no longer advertises the stale bind failure, and the
    // control reflects the persisted state rather than only the runtime state
    expect((el as any).mcpEnabled).to.be.false;
    expect(el.shadowRoot?.querySelector('button.mcp-disable')).to.not.exist;
    expect(el.shadowRoot?.textContent ?? '').to.not.contain('Address already in use');
  });

  it('shows an error when disabling the MCP server fails', async () => {
    mcpConfig = { enabled: true, port: 3001, allowedOrigins: [] };
    mcpStatus = { running: false, port: 3001, url: null, lastError: 'Address already in use' };

    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await (el as any).loadMcpStatus();
    await el.updateComplete;

    setMcpConfigError = 'Failed to write MCP config: disk full';
    await (el as any).handleMcpDisable();
    await el.updateComplete;

    expect(el.shadowRoot?.textContent ?? '').to.contain('Failed to write MCP config: disk full');
    // The failed save must not fake a disabled server
    expect((el as any).mcpEnabled).to.be.true;
    expect(el.shadowRoot?.querySelector('button.mcp-disable')).to.exist;
  });

  it('offers no disable action while the server is already disabled', async () => {
    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await (el as any).loadMcpStatus();
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('button.mcp-disable')).to.not.exist;
    const toggle = el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-toggle');
    expect(toggle?.textContent?.trim()).to.equal('Start');
  });

  it('offers no disable action while the server is running', async () => {
    mcpConfig = { enabled: true, port: 3001, allowedOrigins: [] };
    mcpStatus = { running: true, port: 3001, url: 'http://127.0.0.1:3001', lastError: null };

    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await (el as any).loadMcpStatus();
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('button.mcp-disable')).to.not.exist;
    const toggle = el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-toggle');
    expect(toggle?.textContent?.trim()).to.equal('Stop');
  });

  describe('access token', () => {
    /** Load the dialog with the MCP config already applied */
    async function openDialog(): Promise<GnSettingsDialog> {
      const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
      await (el as any).loadMcpStatus();
      await el.updateComplete;
      return el;
    }

    it('masks the token by default and reveals it on demand', async () => {
      const el = await openDialog();

      const value = el.shadowRoot?.querySelector('.mcp-token-value');
      expect(value, 'the MCP section must show the access token').to.exist;
      expect(value?.textContent).to.not.contain('token-abc123');
      expect(value?.textContent?.trim()).to.match(/^•+$/);

      const reveal = el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-reveal');
      expect(reveal?.textContent?.trim()).to.equal('Reveal');
      reveal?.click();
      await el.updateComplete;

      expect(el.shadowRoot?.querySelector('.mcp-token-value')?.textContent).to.contain(
        'token-abc123'
      );
      expect(
        el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-reveal')?.textContent?.trim()
      ).to.equal('Hide');

      // ...and it can be hidden again
      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-reveal')?.click();
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('.mcp-token-value')?.textContent).to.not.contain(
        'token-abc123'
      );
    });

    it('copies the real token even while it is masked', async () => {
      const el = await openDialog();

      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-copy')?.click();
      await flush(el);

      expect(copied).to.deep.equal(['token-abc123']);
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /copied/i.test(t.message))).to.be.true;
    });

    it('reports a failed copy instead of failing silently', async () => {
      const el = await openDialog();
      clipboardFails = true;

      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-copy')?.click();
      await flush(el);

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /copy/i.test(t.message))).to.be.true;
    });

    it('offers a client configuration snippet with the Authorization header', async () => {
      const el = await openDialog();

      const snippet = el.shadowRoot?.querySelector('.mcp-client-config')?.textContent ?? '';
      expect(snippet).to.contain('mcpServers');
      expect(snippet).to.contain('http://127.0.0.1:3001');
      expect(snippet).to.contain('Authorization');
      expect(snippet).to.contain('Bearer');
      // The token stays masked on screen until the user reveals it
      expect(snippet).to.not.contain('token-abc123');

      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-snippet-copy')?.click();
      await flush(el);

      expect(copied).to.have.lengthOf(1);
      expect(copied[0]).to.contain('"Authorization": "Bearer token-abc123"');
      expect(copied[0]).to.contain('http://127.0.0.1:3001');
    });

    it('shows the token in the snippet once it is revealed', async () => {
      const el = await openDialog();
      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-reveal')?.click();
      await el.updateComplete;

      expect(el.shadowRoot?.querySelector('.mcp-client-config')?.textContent).to.contain(
        'Bearer token-abc123'
      );
    });

    it('regenerates the token after a confirmation', async () => {
      const el = await openDialog();

      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-regenerate')?.click();
      await flush(el);

      const confirms = invoked.filter((c) => c.command === 'plugin:dialog|message');
      expect(confirms.length, 'regenerating must be confirmed first').to.equal(1);
      expect(JSON.stringify(confirms[0].args)).to.contain('stop working');

      expect(invoked.some((c) => c.command === 'regenerate_mcp_token')).to.be.true;
      expect((el as any).mcpToken).to.equal('token-new456');

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'success' && /regenerated/i.test(t.message))).to.be.true;

      // The new token is masked like the old one, and copies as the new value
      expect(el.shadowRoot?.querySelector('.mcp-token-value')?.textContent).to.not.contain(
        'token-new456'
      );
      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-copy')?.click();
      await flush(el);
      expect(copied).to.deep.equal(['token-new456']);
    });

    it('does not regenerate the token when the confirmation is declined', async () => {
      const el = await openDialog();
      confirmAnswer = 'Cancel';

      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-regenerate')?.click();
      await flush(el);

      expect(invoked.some((c) => c.command === 'regenerate_mcp_token')).to.be.false;
      expect((el as any).mcpToken).to.equal('token-abc123');
    });

    it('shows an error when regenerating the token fails', async () => {
      const el = await openDialog();
      regenerateError = 'Failed to write MCP config: disk full';

      el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-regenerate')?.click();
      await flush(el);

      expect(el.shadowRoot?.textContent ?? '').to.contain('Failed to write MCP config: disk full');
      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).to.be.true;
      // The failed regeneration must not fake a new token
      expect((el as any).mcpToken).to.equal('token-abc123');
    });

    it('explains that a client without the header is refused', async () => {
      const el = await openDialog();
      const rendered = el.shadowRoot?.textContent ?? '';
      expect(rendered).to.contain('Authorization header');
      expect(rendered).to.contain('401');
    });

    it('keeps the token out of the saved configuration', async () => {
      const el = await openDialog();

      await (el as any).handleMcpPortChange({ target: { value: '4321' } } as unknown as Event);
      await el.updateComplete;

      const saves = invoked.filter((c) => c.command === 'set_mcp_config');
      const args = saves[saves.length - 1].args as { config: Record<string, unknown> };
      expect(Object.keys(args.config).sort()).to.deep.equal([
        'allowedOrigins',
        'enabled',
        'port',
      ]);
    });

    it('preserves the configured allowed origins when saving the port', async () => {
      mcpConfig = {
        enabled: false,
        port: 3001,
        allowedOrigins: ['http://localhost:5173'],
        authToken: 'token-abc123',
      };
      const el = await openDialog();

      await (el as any).handleMcpPortChange({ target: { value: '4321' } } as unknown as Event);
      await el.updateComplete;

      const saves = invoked.filter((c) => c.command === 'set_mcp_config');
      expect(saves[saves.length - 1].args).to.deep.equal({
        config: { enabled: false, port: 4321, allowedOrigins: ['http://localhost:5173'] },
      });
    });

    it('offers no token actions before a token exists', async () => {
      mcpConfig = { enabled: false, port: 3001, allowedOrigins: [], authToken: '' };
      const el = await openDialog();

      expect(el.shadowRoot?.querySelector('.mcp-token-value')?.textContent).to.contain(
        'Not generated yet'
      );
      expect(
        el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-copy')?.disabled
      ).to.be.true;
      expect(
        el.shadowRoot?.querySelector<HTMLButtonElement>('button.mcp-token-reveal')?.disabled
      ).to.be.true;
    });
  });
});

/**
 * Layout in a translated locale.
 *
 * Chinese setting names and descriptions are long, and the flex row used to
 * let the controls beside them shrink: "已禁用" became a one-character-wide
 * column (已 / 禁 / 用 stacked) and "启动" did the same. These assertions pin
 * the fix — the label gives way, the controls do not.
 */
describe('gn-settings-dialog MCP layout in Chinese', () => {
  beforeEach(async () => {
    await setAppLocale('zh');
  });

  afterEach(async () => {
    await setAppLocale('en');
  });

  async function openDialog(): Promise<GnSettingsDialog> {
    const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
    await (el as any).loadMcpStatus();
    await el.updateComplete;
    return el;
  }

  function rowWith(el: GnSettingsDialog, text: string): HTMLElement {
    const row = Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('.setting-row')).find(
      (candidate) => candidate.textContent?.includes(text)
    );
    expect(row, `expected a settings row containing "${text}"`).to.exist;
    return row!;
  }

  it('keeps the status pill and toggle on one line', async () => {
    const el = await openDialog();
    const row = rowWith(el, '上下文代理');

    const status = row.querySelector<HTMLElement>('.status-indicator')!;
    const toggle = row.querySelector<HTMLElement>('button.mcp-toggle')!;
    expect(status, 'the MCP row must show its status').to.exist;
    expect(toggle, 'the MCP row must offer its action').to.exist;

    // One text line each, not a vertical stack of characters.
    for (const control of [status, toggle]) {
      expect(getComputedStyle(control).whiteSpace).to.equal('nowrap');
      expect(control.getBoundingClientRect().height).to.be.lessThan(40);
    }

    // The row itself never overflows the dialog horizontally.
    expect(row.scrollWidth).to.be.at.most(row.clientWidth + 1);
  });

  it('gives the access token its own line instead of squeezing the token or the buttons', async () => {
    // Real backend tokens are 43 characters (`AUTH_TOKEN_LEN` in
    // src-tauri/src/services/ai/mcp/server.rs). A 12-character fixture would
    // hide exactly the overflow this row had: 43 bullets are wider than the
    // row, so the masked value wrapped and pushed Regenerate onto a new line.
    mcpConfig = { enabled: false, port: 3001, allowedOrigins: [], authToken: 'a'.repeat(43) };
    const el = await openDialog();
    const row = rowWith(el, '访问令牌');

    expect(row.classList.contains('setting-row-stacked')).to.be.true;

    const label = row.querySelector<HTMLElement>('.setting-label')!;
    const controls = row.querySelector<HTMLElement>('.mcp-token-controls')!;
    const tokenValue = controls.querySelector<HTMLElement>('.mcp-token-value')!;
    const buttons = Array.from(controls.querySelectorAll<HTMLElement>('button'));
    const labelRect = label.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();

    // The mask is capped, so the hidden value stays on one line...
    expect(tokenValue.textContent?.trim()).to.match(/^•+$/);
    expect(tokenValue.textContent?.trim().length).to.be.at.most(12);

    // Stacked: the controls start on the line below the label, use the
    // dialog's full width, and keep token + three buttons on ONE line.
    expect(controlsRect.top).to.be.at.least(labelRect.bottom - 1);
    expect(controlsRect.width).to.be.at.least(400);

    for (const control of [tokenValue, ...buttons]) {
      expect(
        control.getBoundingClientRect().height,
        `${control.tagName} wrapped`
      ).to.be.lessThan(40);
    }
    expect(new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size).to.equal(1);

    // Revealing the real 43-character token may wrap the token box, but the
    // three actions must still share one row.
    el.shadowRoot!.querySelector<HTMLButtonElement>('button.mcp-token-reveal')!.click();
    await el.updateComplete;
    expect(tokenValue.textContent).to.contain('a'.repeat(43));
    for (const button of buttons) {
      expect(button.getBoundingClientRect().height).to.be.lessThan(40);
    }
    expect(new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size).to.equal(1);

    expect(row.scrollWidth).to.be.at.most(row.clientWidth + 1);
  });

  it('wraps long error text instead of overflowing the dialog', async () => {
    // Standalone text rows (backend error, update error) are not controls: the
    // flex row must let them wrap rather than stretch to max-content and run
    // past the dialog.
    const longError =
      'Failed to bind to 127.0.0.1:3001: Address already in use — another process is listening on that port (stop it or pick a different port in Settings)';
    mcpStatus = { running: false, port: 3001, url: null, lastError: longError };
    mcpConfig = { enabled: true, port: 3001, allowedOrigins: [], authToken: '' };
    const el = await openDialog();

    const mcpErrorRow = rowWith(el, 'Address already in use');
    expect(mcpErrorRow.scrollWidth).to.be.at.most(mcpErrorRow.clientWidth + 1);
    expect(mcpErrorRow.querySelector<HTMLElement>('.error-text')!.getBoundingClientRect().height)
      .to.be.greaterThan(20);

    // ...and the About row's update error gets the same treatment.
    (el as any).updateStatus = 'failed';
    (el as any).updateError = longError;
    await el.updateComplete;
    const aboutRow = Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('.setting-row')).find(
      (row) => row.querySelector('.version-info')
    )!;
    expect(aboutRow.scrollWidth).to.be.at.most(aboutRow.clientWidth + 1);
    expect(aboutRow.querySelector<HTMLElement>('.error-text')!.getBoundingClientRect().height)
      .to.be.greaterThan(20);
  });

  it('keeps the client-configuration Copy button on one line', async () => {
    const el = await openDialog();
    const row = rowWith(el, 'MCP 客户端配置');
    const copy = row.querySelector<HTMLElement>('button.mcp-snippet-copy')!;

    expect(copy.getBoundingClientRect().height).to.be.lessThan(40);
    expect(getComputedStyle(copy).whiteSpace).to.equal('nowrap');
  });
});
