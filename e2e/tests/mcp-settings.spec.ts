import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import {
  startCommandCaptureWithMocks,
  injectCommandError,
  injectCommandMock,
  findCommand,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

/**
 * MCP server settings.
 *
 * The MCP configuration is persisted on the backend and the server is restarted
 * on launch while it is enabled, so the Settings dialog must save the port when
 * it changes and explain why the server is stopped when a start failed.
 */

const stoppedStatus = {
  running: false,
  port: 3001,
  url: null,
  lastError: null,
};

const defaultConfig = {
  enabled: false,
  port: 3001,
  allowedOrigins: [],
  authToken: 'token-abc123',
};

function mcpMocks(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    get_mcp_status: stoppedStatus,
    get_mcp_config: defaultConfig,
    set_mcp_config: null,
    start_mcp_server: null,
    stop_mcp_server: null,
    regenerate_mcp_token: 'token-new456',
    ...overrides,
  };
}

/** Open the settings dialog via keyboard shortcut */
async function openSettings(page: Page) {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('gn-settings-dialog')).toBeVisible();
}

/** The MCP port input, scoped by its description so other number inputs don't match */
function mcpPortInput(page: Page) {
  return page
    .locator('gn-settings-dialog .setting-row', { hasText: 'Localhost port for the MCP server' })
    .locator('input');
}

/** The Start/Retry/Stop button in the MCP section */
function mcpToggleButton(page: Page) {
  return page
    .locator('gn-settings-dialog .setting-row', { hasText: 'Context Proxy' })
    .locator('button.mcp-toggle');
}

/** The masked/revealed access token value in the MCP section */
function mcpTokenValue(page: Page) {
  return page.locator('gn-settings-dialog .mcp-token-value');
}

/**
 * Record clipboard writes on the page instead of touching the real clipboard,
 * which headless Chromium refuses without a permission grant.
 */
async function captureClipboard(page: Page) {
  await page.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { __COPIED__: string[] }).__COPIED__ = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied.push(value);
          return Promise.resolve();
        },
      },
    });
  });
}

/** Everything copied to the clipboard so far */
async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __COPIED__?: string[] }).__COPIED__ ?? []
  );
}

/** The Disable button, shown only while the server is enabled but not running */
function mcpDisableButton(page: Page) {
  return page
    .locator('gn-settings-dialog .setting-row', { hasText: 'Context Proxy' })
    .locator('button.mcp-disable');
}

test.describe('Settings Dialog — MCP Server', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('saves the MCP port when it is changed', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);

    const input = mcpPortInput(page);
    await expect(input).toBeVisible();
    await input.fill('4321');
    await input.blur();

    await expect
      .poll(async () => (await findCommand(page, 'set_mcp_config')).length)
      .toBeGreaterThan(0);

    const saves = await findCommand(page, 'set_mcp_config');
    expect(saves[saves.length - 1].args).toEqual({
      config: { enabled: false, port: 4321, allowedOrigins: [] },
    });
  });

  test('reports a failed launch-time start in the MCP section', async ({ page }) => {
    await startCommandCaptureWithMocks(
      page,
      mcpMocks({
        get_mcp_config: { enabled: true, port: 3001, allowedOrigins: [] },
        get_mcp_status: {
          running: false,
          port: 3001,
          url: null,
          lastError: 'Failed to bind to 127.0.0.1:3001: Address already in use',
        },
      })
    );
    await openSettings(page);

    await expect(
      page.locator('gn-settings-dialog .setting-row', { hasText: 'Context Proxy' })
    ).toContainText('Stopped');
    await expect(page.locator('gn-settings-dialog .error-text')).toContainText(
      'Failed to bind to 127.0.0.1:3001'
    );
  });

  test('surfaces an error when the config cannot be saved on Start', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);
    await injectCommandError(page, 'set_mcp_config', 'Failed to write MCP config: disk full');

    await mcpToggleButton(page).click();

    await expect(page.locator('gn-settings-dialog .error-text')).toContainText(
      'Failed to write MCP config: disk full'
    );
    await expect(
      page.locator('gn-settings-dialog .setting-row', { hasText: 'Context Proxy' })
    ).toContainText('Disabled');
    expect(await findCommand(page, 'start_mcp_server')).toHaveLength(0);
  });

  test('lets the user turn off a start that keeps failing', async ({ page }) => {
    await startCommandCaptureWithMocks(
      page,
      mcpMocks({
        get_mcp_config: { enabled: true, port: 3001, allowedOrigins: [] },
        get_mcp_status: {
          running: false,
          port: 3001,
          url: null,
          lastError: 'Failed to bind to 127.0.0.1:3001: Address already in use',
        },
      })
    );
    await openSettings(page);

    // A server that is enabled but not running keeps retrying on every launch,
    // so the section must offer a way to stop that without a running server
    await expect(mcpDisableButton(page)).toBeVisible();
    // ...and the start control reads as a retry, not a fresh start
    await expect(mcpToggleButton(page)).toHaveText('Retry');
    await mcpDisableButton(page).click();

    await expect
      .poll(async () => (await findCommand(page, 'set_mcp_config')).length)
      .toBeGreaterThan(0);

    const saves = await findCommand(page, 'set_mcp_config');
    expect(saves[saves.length - 1].args).toEqual({
      config: { enabled: false, port: 3001, allowedOrigins: [] },
    });
  });

  test('a disabled server does not advertise a stale start failure', async ({ page }) => {
    // The backend keeps `lastError` after a disable, so the section must key the
    // explanation off the persisted enabled flag, not off `running` alone
    await startCommandCaptureWithMocks(
      page,
      mcpMocks({
        get_mcp_status: {
          running: false,
          port: 3001,
          url: null,
          lastError: 'Failed to bind to 127.0.0.1:3001: Address already in use',
        },
      })
    );
    await openSettings(page);

    await expect(
      page.locator('gn-settings-dialog .setting-row', { hasText: 'Context Proxy' })
    ).toContainText('Disabled');
    await expect(mcpDisableButton(page)).toHaveCount(0);
    await expect(page.locator('gn-settings-dialog .error-text')).toHaveCount(0);
  });

  test('offers no disable action while the server is stopped and disabled', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);

    await expect(mcpToggleButton(page)).toHaveText('Start');
    await expect(mcpDisableButton(page)).toHaveCount(0);
  });

  test('masks the access token and reveals it on demand', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);

    // The token is a secret: it must not be on screen until the user asks
    await expect(mcpTokenValue(page)).toBeVisible();
    await expect(mcpTokenValue(page)).not.toContainText('token-abc123');
    await expect(page.locator('gn-settings-dialog .mcp-client-config')).not.toContainText(
      'token-abc123'
    );

    const reveal = page.locator('gn-settings-dialog button.mcp-token-reveal');
    await expect(reveal).toHaveText('Reveal');
    await reveal.click();

    await expect(mcpTokenValue(page)).toContainText('token-abc123');
    await expect(page.locator('gn-settings-dialog .mcp-client-config')).toContainText(
      'Bearer token-abc123'
    );
    await expect(reveal).toHaveText('Hide');

    await reveal.click();
    await expect(mcpTokenValue(page)).not.toContainText('token-abc123');
  });

  test('copies the token and a ready-made client configuration', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);
    await captureClipboard(page);

    await page.locator('gn-settings-dialog button.mcp-token-copy').click();
    await expect
      .poll(async () => (await clipboardWrites(page)).length)
      .toBeGreaterThan(0);
    expect((await clipboardWrites(page))[0]).toBe('token-abc123');
    await expect(page.locator('gn-toast-container .toast.success')).toBeVisible();

    await page.locator('gn-settings-dialog button.mcp-snippet-copy').click();
    await expect
      .poll(async () => (await clipboardWrites(page)).length)
      .toBeGreaterThan(1);

    const snippet = (await clipboardWrites(page))[1];
    expect(snippet).toContain('"Authorization": "Bearer token-abc123"');
    expect(snippet).toContain('http://127.0.0.1:3001');
    expect(snippet).toContain('mcpServers');
  });

  test('regenerates the token after a confirmation that warns about clients', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);
    await autoConfirmDialogs(page);
    await captureClipboard(page);

    await page.locator('gn-settings-dialog button.mcp-token-regenerate').click();

    await expect
      .poll(async () => (await findCommand(page, 'regenerate_mcp_token')).length)
      .toBe(1);

    // The confirmation must say what breaks
    const confirms = await findCommand(page, 'plugin:dialog|message');
    expect(JSON.stringify(confirms[confirms.length - 1].args)).toContain('stop working');

    await expect(page.locator('gn-toast-container .toast.success')).toContainText('regenerated');

    // The new token is masked like the old one, and it is what gets copied
    await expect(mcpTokenValue(page)).not.toContainText('token-new456');
    await page.locator('gn-settings-dialog button.mcp-token-reveal').click();
    await expect(mcpTokenValue(page)).toContainText('token-new456');
  });

  test('does not regenerate the token when the confirmation is declined', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);
    // plugin-dialog resolves confirm() to false for anything but the OK label
    await injectCommandMock(page, { 'plugin:dialog|message': 'Cancel' });

    await page.locator('gn-settings-dialog button.mcp-token-regenerate').click();

    await expect
      .poll(async () => (await findCommand(page, 'plugin:dialog|message')).length)
      .toBeGreaterThan(0);
    expect(await findCommand(page, 'regenerate_mcp_token')).toHaveLength(0);

    await page.locator('gn-settings-dialog button.mcp-token-reveal').click();
    await expect(mcpTokenValue(page)).toContainText('token-abc123');
  });

  test('surfaces an error when the token cannot be regenerated', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);
    await autoConfirmDialogs(page);
    await injectCommandError(page, 'regenerate_mcp_token', 'Failed to write MCP config: disk full');

    await page.locator('gn-settings-dialog button.mcp-token-regenerate').click();

    await expect(page.locator('gn-settings-dialog .error-text')).toContainText(
      'Failed to write MCP config: disk full'
    );
    await expect(page.locator('gn-toast-container .toast.error')).toBeVisible();
    // The failed attempt must not pretend a new token exists
    await page.locator('gn-settings-dialog button.mcp-token-reveal').click();
    await expect(mcpTokenValue(page)).toContainText('token-abc123');
  });

  test('explains that a client without the Authorization header is refused', async ({ page }) => {
    await startCommandCaptureWithMocks(page, mcpMocks());
    await openSettings(page);

    await expect(
      page.locator('gn-settings-dialog .setting-row', { hasText: 'MCP Client Configuration' })
    ).toContainText('401');
  });

  test('keeps the translated MCP controls on one line instead of a per-character column', async ({
    page,
  }) => {
    await startCommandCaptureWithMocks(
      page,
      mcpMocks({
        get_mcp_config: {
          enabled: false,
          port: 3001,
          allowedOrigins: [],
          authToken: tokens43,
        },
      })
    );
    await openSettings(page);

    // Switch the real language setting; the dialog re-renders in place.
    await page.locator('gn-settings-dialog #language-select').selectOption('zh');
    await expect(page.locator('gn-settings-dialog .section-title').first()).toHaveText('外观');

    const proxyRow = page.locator('gn-settings-dialog .setting-row', { hasText: '上下文代理' });
    const status = proxyRow.locator('.status-indicator');
    const toggle = proxyRow.locator('button.mcp-toggle');

    await expect(status).toHaveText('已禁用');
    await expect(toggle).toHaveText('启动');
    await expect(status).toHaveCSS('white-space', 'nowrap');
    await expect(toggle).toHaveCSS('white-space', 'nowrap');

    const proxyLayout = await proxyRow.evaluate((row) => {
      const statusEl = row.querySelector('.status-indicator') as HTMLElement;
      const toggleEl = row.querySelector('button.mcp-toggle') as HTMLElement;
      const el = row as HTMLElement;
      return {
        overflow: el.scrollWidth - el.clientWidth,
        statusHeight: statusEl.getBoundingClientRect().height,
        toggleHeight: toggleEl.getBoundingClientRect().height,
      };
    });

    // The old layout let the row's controls shrink: the status pill became one
    // character wide and stacked 已/禁/用 vertically, and the button did the
    // same with 启/动. Neither may happen, and nothing may spill sideways.
    expect(proxyLayout.overflow).toBeLessThanOrEqual(1);
    expect(proxyLayout.statusHeight).toBeLessThan(30);
    expect(proxyLayout.toggleHeight).toBeLessThan(40);

    // The token row gives its token + actions a full-width line of their own.
    const tokenRow = page.locator('gn-settings-dialog .setting-row', { hasText: '访问令牌' });
    await expect(tokenRow).toHaveClass(/setting-row-stacked/);

    // The mask is capped, so the hidden value stays on one line even though a
    // real backend token is 43 characters.
    const maskedText = ((await mcpTokenValue(page).textContent()) ?? '').trim();
    expect(maskedText).toMatch(/^•+$/);
    expect(maskedText.length).toBeLessThanOrEqual(12);

    const tokenLayout = () =>
      tokenRow.evaluate((row) => {
        const label = row.querySelector('.setting-label') as HTMLElement;
        const controls = row.querySelector('.mcp-token-controls') as HTMLElement;
        const buttons = Array.from(controls.querySelectorAll('button')).map((button) => ({
          height: button.getBoundingClientRect().height,
          top: Math.round(button.getBoundingClientRect().top),
        }));
        return {
          labelBottom: label.getBoundingClientRect().bottom,
          controlsTop: controls.getBoundingClientRect().top,
          controlsWidth: controls.getBoundingClientRect().width,
          tokenHeight: (controls.querySelector('.mcp-token-value') as HTMLElement)
            .getBoundingClientRect().height,
          buttons,
          overflow: (row as HTMLElement).scrollWidth - (row as HTMLElement).clientWidth,
        };
      });

    const masked = await tokenLayout();
    expect(masked.controlsTop).toBeGreaterThanOrEqual(masked.labelBottom - 1);
    expect(masked.controlsWidth).toBeGreaterThan(400);
    expect(masked.tokenHeight).toBeLessThan(40);
    expect(masked.buttons.every((button) => button.height < 40)).toBe(true);
    expect(new Set(masked.buttons.map((button) => button.top)).size).toBe(1);
    expect(masked.overflow).toBeLessThanOrEqual(1);

    // Revealing the 43-character token may wrap the token box, but the three
    // actions still share one row.
    await page.locator('gn-settings-dialog button.mcp-token-reveal').click();
    await expect(mcpTokenValue(page)).toHaveText(tokens43);
    const revealed = await tokenLayout();
    expect(revealed.buttons.every((button) => button.height < 40)).toBe(true);
    expect(new Set(revealed.buttons.map((button) => button.top)).size).toBe(1);
    expect(revealed.overflow).toBeLessThanOrEqual(1);
  });

  test('wraps a long backend error instead of scrolling the dialog sideways', async ({ page }) => {
    // A real bind failure is far longer than the 500px dialog. The error row is
    // plain text, not a control, so it must wrap rather than stretch to
    // max-content and push the modal into horizontal scrolling.
    const longError =
      'Failed to bind to 127.0.0.1:3001: Address already in use — another process is listening on that port (stop it or pick a different port in Settings)';
    await startCommandCaptureWithMocks(
      page,
      mcpMocks({
        get_mcp_config: { enabled: true, port: 3001, allowedOrigins: [], authToken: 'token-abc123' },
        get_mcp_status: { running: false, port: 3001, url: null, lastError: longError },
      })
    );
    await openSettings(page);

    const errorRow = page.locator('gn-settings-dialog .setting-row', {
      hasText: 'Address already in use',
    });
    await expect(errorRow).toBeVisible();

    const rowLayout = await errorRow.evaluate((row) => ({
      overflow: (row as HTMLElement).scrollWidth - (row as HTMLElement).clientWidth,
      errorHeight: (row.querySelector('.error-text') as HTMLElement).getBoundingClientRect().height,
    }));
    expect(rowLayout.overflow).toBeLessThanOrEqual(1);
    // Wrapped onto more than one line instead of one 800px-long line.
    expect(rowLayout.errorHeight).toBeGreaterThan(20);

    const contentLayout = await page.locator('gn-settings-dialog').evaluate((host) => {
      const modal = host.closest('gn-modal');
      const content = modal?.shadowRoot?.querySelector<HTMLElement>('.content');
      return content ? { overflow: content.scrollWidth - content.clientWidth } : null;
    });
    expect(contentLayout?.overflow).toBeLessThanOrEqual(1);
  });
});

/** A production-length MCP token (`AUTH_TOKEN_LEN` = 43 in the Rust backend). */
const tokens43 = 'a'.repeat(43);
