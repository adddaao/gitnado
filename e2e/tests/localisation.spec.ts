/**
 * Localisation: the main window follows the language setting.
 *
 * The language picker is covered elsewhere (welcome.spec.ts) on the surfaces
 * that were localised first. This spec covers the REST of the shell — toolbar,
 * both sidebars and the panels around the graph — because those were migrated
 * later and a half-translated main window is exactly the failure a per-string
 * test cannot see: one missed `msg()` and a French/Chinese user gets an English
 * row among translated ones.
 *
 * It switches the REAL setting through the Settings dialog (no store poking),
 * then asserts the migrated chrome renders in Chinese and that the English
 * source labels are gone from it.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository, setupTauriMocks } from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';

async function switchLanguage(page: Page, locale: 'en' | 'zh'): Promise<void> {
  await page.keyboard.press('Meta+,');
  const select = page.locator('gn-settings-dialog #language-select');
  await expect(select).toBeVisible();
  await select.selectOption(locale);
  // The dialog itself re-renders in the new locale — a known-good sentinel.
  await expect(page.locator('gn-settings-dialog .section-title').first()).toHaveText(
    locale === 'zh' ? '外观' : 'Appearance'
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('gn-settings-dialog')).toBeHidden();
}

test.describe('Localisation of the main window', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await expect(new AppPage(page).welcomeScreen).toHaveCount(0);
  });

  test('the toolbar and both sidebars follow the language setting', async ({ page }) => {
    const leftPanel = page.locator('gn-left-panel');
    const rightPanel = page.locator('gn-right-panel');

    // English first, so the assertion below is about the switch, not markup.
    await expect(leftPanel.locator('.section-header .title').first()).toHaveText('Branches');
    await expect(leftPanel.locator('.section-header .title').nth(1)).toHaveText('Stashes');

    await switchLanguage(page, 'zh');

    // Section headers and tab labels are translated...
    await expect(leftPanel.locator('.section-header .title').nth(0)).toHaveText('分支');
    await expect(leftPanel.locator('.section-header .title').nth(1)).toHaveText('贮藏');
    await expect(leftPanel.locator('.section-header .title').nth(2)).toHaveText('标签');
    const rightTabs = rightPanel.locator('.tab-bar .tab');
    await expect(rightTabs.nth(0)).toContainText('更改');
    await expect(rightTabs.nth(1)).toContainText('详情');
    await expect(rightTabs.nth(2)).toContainText('分析');

    // ...and the accessible names / tooltips around them are too: the toolbar
    // buttons carry their label only in `title`/`aria-label`.
    await expect(page.locator('gn-toolbar .menu-btn[title="打开仓库"]')).toBeVisible();
    await expect(page.locator('gn-toolbar .menu-btn[title="Open Repository"]')).toHaveCount(0);
    await expect(page.locator('gn-toolbar .menu-btn[aria-label="打开仓库"]')).toBeVisible();

    // No English chrome text survives in the migrated containers.
    for (const english of ['Branches', 'Stashes', 'Tags', 'Pull Requests']) {
      await expect(leftPanel.getByText(english, { exact: true })).toHaveCount(0);
    }
    for (const english of ['Changes', 'Details', 'Analytics']) {
      await expect(rightPanel.getByText(english, { exact: true })).toHaveCount(0);
    }
  });

  test('switching back to English restores the shell', async ({ page }) => {
    await switchLanguage(page, 'zh');
    await expect(page.locator('gn-left-panel .section-header .title').first()).toHaveText('分支');

    await switchLanguage(page, 'en');
    await expect(page.locator('gn-left-panel .section-header .title').first()).toHaveText(
      'Branches'
    );
    await expect(page.locator('gn-right-panel .tab-bar .tab').first()).toContainText('Changes');
  });

  test('the chosen language survives a reload and still renders the shell', async ({ page }) => {
    await switchLanguage(page, 'zh');

    await page.reload();
    await new AppPage(page).waitForReady();

    await expect(page.locator('gn-left-panel .section-header .title').first()).toHaveText('分支');
    await expect(page.locator('gn-right-panel .tab-bar .tab').first()).toContainText('更改');
    await expect(page.locator('gn-toolbar .menu-btn[title="打开仓库"]')).toBeVisible();
  });
});

/**
 * Fresh install.
 *
 * Chinese is the product default, not the OS language (see
 * `defaultSettings.language` in src/stores/settings.store.ts). The rest of the
 * suite seeds an explicit English choice, so this is the one spec that boots
 * with an empty storage and must prove the default actually applies.
 */
test.describe('Fresh install language', () => {
  test('opens in Chinese with no persisted settings', async ({ page }) => {
    // No repository: this is the welcome screen a first launch lands on.
    await setupTauriMocks(page, undefined, { seedLanguage: false });
    await page.goto('/');
    const app = new AppPage(page);
    await app.waitForReady();

    await expect(app.welcomeTagline).toHaveText('功能强大的开源 Git 客户端');
    await page.keyboard.press('Meta+,');
    await expect(page.locator('gn-settings-dialog #language-select')).toHaveValue('zh');
  });

  test('the settings dialog shows Chinese section titles', async ({ page }) => {
    await setupOpenRepository(page, undefined, { seedLanguage: false });

    await page.keyboard.press('Meta+,');
    await expect(page.locator('gn-settings-dialog .section-title').first()).toHaveText('外观');
  });
});
