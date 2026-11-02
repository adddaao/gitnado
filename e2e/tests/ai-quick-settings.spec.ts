/**
 * AI quick settings and the commit-panel divider.
 *
 * Covers the three user-visible behaviours added together:
 *  - the 简/英 prompt-language quick switch in the commit panel (choice
 *    persisted, and actually handed to the AI backend as `promptLanguage`);
 *  - the Settings > "AI Quick Settings" group that changes the language and
 *    shows/hides the quick switch;
 *  - the vertically resizable commit panel divider (drag, persist, reload).
 */
import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository, withStagedFiles } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { RightPanelPage } from '../pages/panels.page';
import { startCommandCaptureWithMocks, waitForCommand } from '../fixtures/test-helpers';

const quickSwitch = 'gn-commit-panel .prompt-language-switch';
const zhOption = `${quickSwitch} .lang-option[data-lang="zh"]`;
const enOption = `${quickSwitch} .lang-option[data-lang="en"]`;

const quickSettingsSection =
  'gn-settings-dialog .settings-section:has(.section-title:text-is("AI Quick Settings"))';
const visibilityRow =
  'gn-settings-dialog .setting-row:has(.setting-name:text-is("Show prompt-language switch"))';
const visibilityToggle = `${visibilityRow} gn-toggle button[role="switch"]`;

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('gn-settings-dialog')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('gn-settings-dialog')).toBeHidden();
}

test.describe('AI prompt language quick switch', () => {
  test.beforeEach(async ({ page }) => {
    // Seeded installs are English (see tauri-mock's seedLanguage), so the
    // migration default (`en`) is what the switch must start on.
    await setupOpenRepository(page);
  });

  test('shows 简/英 in the commit panel and remembers the choice across a reload', async ({
    page,
  }) => {
    await expect(page.locator(quickSwitch)).toBeVisible();
    await expect(page.locator(enOption)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(zhOption)).toHaveAttribute('aria-pressed', 'false');

    await page.locator(zhOption).click();

    await expect(page.locator(zhOption)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(enOption)).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              JSON.parse(localStorage.getItem('gitnado-settings')!) as {
                state: { aiPromptLanguage?: string };
              }
            ).state.aiPromptLanguage
        )
      )
      .toBe('zh');

    await page.reload();
    await new AppPage(page).waitForReady();

    await expect(page.locator(zhOption)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(enOption)).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('AI prompt language reaches the backend', () => {
  test('passes promptLanguage with the chosen value', async ({ page }) => {
    await setupOpenRepository(page, {
      ...withStagedFiles([
        { path: 'src/main.ts', status: 'modified', isStaged: true, isConflicted: false },
      ]),
    });
    // Record invocations and make the panel's availability poll succeed, so a
    // click on the generate button runs the AI command instead of opening
    // Settings.
    await startCommandCaptureWithMocks(page, { is_ai_available: true });

    const rightPanel = new RightPanelPage(page);
    const generateButton = rightPanel.aiGenerateButton;

    // The button only generates once the panel's availability poll has
    // succeeded; before that a click opens Settings instead.
    await expect(generateButton).toHaveClass(/ai-ready/, { timeout: 10_000 });

    await page.locator(zhOption).click();
    await generateButton.click();
    await waitForCommand(page, 'generate_commit_message');

    const promptLanguage = async (): Promise<string | undefined> =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __INVOKED_COMMANDS__: {
                command: string;
                args?: { promptLanguage?: string };
              }[];
            }
          ).__INVOKED_COMMANDS__.filter((c) => c.command === 'generate_commit_message').at(-1)
            ?.args?.promptLanguage
      );

    expect(await promptLanguage()).toBe('zh');

    await page.locator(enOption).click();
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    await expect.poll(promptLanguage).toBe('en');
  });
});

test.describe('Settings > AI Quick Settings', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('changes the AI prompt language from Settings', async ({ page }) => {
    await openSettings(page);

    const section = page.locator(quickSettingsSection);
    await expect(section).toBeVisible();
    await expect(section.locator('.prompt-language-switch')).toBeVisible();

    await section.locator('.lang-option[data-lang="zh"]').click();
    await expect(section.locator('.lang-option[data-lang="zh"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await closeSettings(page);
    await expect(page.locator(zhOption)).toHaveAttribute('aria-pressed', 'true');
  });

  test('hides the commit-panel quick switch and keeps it hidden after reload', async ({ page }) => {
    await expect(page.locator(quickSwitch)).toBeVisible();

    await openSettings(page);
    await page.locator(visibilityToggle).click();
    await closeSettings(page);

    await expect(page.locator(quickSwitch)).toHaveCount(0);

    await page.reload();
    await new AppPage(page).waitForReady();
    await expect(page.locator(quickSwitch)).toHaveCount(0);

    // ...and turning it back on brings it back without a reload.
    await openSettings(page);
    await page.locator(visibilityToggle).click();
    await closeSettings(page);
    await expect(page.locator(quickSwitch)).toBeVisible();
  });
});

test.describe('Commit panel divider', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  const container = 'gn-right-panel .commit-panel-container';

  test('drags the divider to grow the commit panel, persists, and survives reload', async ({
    page,
  }) => {
    const handle = page.locator('gn-right-panel .resize-handle-v');
    await expect(handle).toBeVisible();

    const before = await page
      .locator(container)
      .evaluate((el) => el.getBoundingClientRect().height);
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();

    // Drag UP 80px: the commit panel grows, the file list shrinks.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y - 80, { steps: 5 });
    await page.mouse.up();

    const after = await page
      .locator(container)
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(after).toBeGreaterThan(before + 60);

    const persisted = await page.evaluate(
      () =>
        (
          JSON.parse(localStorage.getItem('gitnado-settings')!) as {
            state: { commitPanelHeight?: number };
          }
        ).state.commitPanelHeight
    );
    expect(persisted).toBe(Math.round(after));

    await page.reload();
    await new AppPage(page).waitForReady();

    const reloaded = await page
      .locator(container)
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.round(reloaded)).toBe(Math.round(after));
  });

  test('is keyboard operable', async ({ page }) => {
    const handle = page.locator('gn-right-panel .resize-handle-v');
    const before = await page
      .locator(container)
      .evaluate((el) => el.getBoundingClientRect().height);

    await handle.focus();
    await page.keyboard.press('ArrowUp');

    await expect
      .poll(async () =>
        page.locator(container).evaluate((el) => el.getBoundingClientRect().height)
      )
      .toBeGreaterThan(before + 5);
  });
});
