# Localisation

Gitnado uses [`@lit/localize`](https://lit.dev/docs/localization/overview/) in
**runtime mode**. The active locale is a normal setting (Settings → Appearance →
Language): changing it swaps the templates in place and every migrated component
re-renders, with no restart and no page reload. Transform mode — the other option
— compiles one bundle per locale and needs a reload to switch, which is the wrong
trade for a desktop app with a language picker.

## What is localised today

The list below is not hand-kept: `scripts/i18n-coverage.test.mjs` fails if a file
gains or loses a `msg()` call and this list does not follow, and it checks every
locale the app ships. Every file with at least one `msg()` call site is here, and
nothing else in `src/` has one.

Every component, panel, dialog and helper module is migrated, so the whole
interface follows the language setting — Chinese is the default language, see
below — and that includes the native menu bar: its structure is built in Rust but
its labels are pushed from this crate's catalogue and the menu is rebuilt on a
language switch (see `src/services/app-menu.service.ts`). What is still English is
text the Rust backend supplies verbatim (git/network error messages).

- `src/app-shell.ts` — the shell's operation banners, both context menus, the
  drop overlay, the skip link, its toasts/confirmations/prompts and the labels
  of the entries it registers with the app menu.
- `src/components/dialogs/gn-clone-dialog.ts` — the recursive submodule clone option.
- `src/components/dialogs/gn-modal.ts` — the base modal's close/back buttons
  (accessible names and tooltip).
- `src/components/dialogs/gn-settings-dialog.ts` — everything the dialog
  renders (section titles, setting names and descriptions, options, buttons,
  status text) plus the language picker's own error toast.
- `src/components/dialogs/gn-account-repo-picker.ts` — the account-to-repository
  picker: search, list rows, loading/empty states.
- `src/components/dialogs/gn-account-selector.ts` — the integration-account
  selector and its empty state.
- `src/components/dialogs/gn-azure-devops-dialog.ts` — the Azure DevOps
  integration: PAT help, pipelines, work items and pull-request creation.
- `src/components/dialogs/gn-bitbucket-dialog.ts` — the Bitbucket integration:
  pull requests, issues and workspace/account selection.
- `src/components/dialogs/gn-credentials-dialog.ts` — the git credential-helper
  dialog: helpers, scopes, and the add/edit forms.
- `src/components/dialogs/gn-gpg-dialog.ts` — the signing-setup dialog: install
  guidance, key generation and the key list.
- `src/components/dialogs/gn-github-dialog.ts` — the GitHub integration: pull
  requests, issues, releases, auth methods and App setup.
- `src/components/dialogs/gn-gitlab-dialog.ts` — the GitLab integration: merge
  requests, issues, pipelines and project selection.
- `src/components/dialogs/gn-jira-dialog.ts` — the Jira integration: connection
  settings, project and issue-type mapping.
- `src/components/dialogs/gn-oidc-dialog.ts` — the Enterprise SSO (OIDC)
  integration: discovery, client settings and connected accounts.
- `src/components/dialogs/gn-profile-manager-dialog.ts` — the profiles dialog:
  list, editor, bulk repository assignment and account mapping.
- `src/components/dialogs/gn-ssh-dialog.ts` — the SSH key dialog: key
  generation, known hosts and the key list.
- `src/components/dialogs/gn-bisect-dialog.ts` — the bisect wizard: setup,
  in-progress steps, culprit report and abort confirmation.
- `src/components/dialogs/gn-branch-cleanup-dialog.ts` — the branch-cleanup
  audit: risk labels/reasons, protected reasons, delete and force-delete flows.
- `src/components/dialogs/gn-changelog-dialog.ts` — the changelog generator.
- `src/components/dialogs/gn-cherry-pick-dialog.ts` — the cherry-pick target
  picker and its options.
- `src/components/dialogs/gn-clean-dialog.ts` — the clean-untracked dialog:
  nested-repository warnings, selection counts and results.
- `src/components/dialogs/gn-command-palette.ts` — the palette's categories,
  placeholder, footer hints, and the branch-entry labels app-shell's
  "Switch Branch…" prefilter depends on.
- `src/components/dialogs/gn-compare-branches-dialog.ts` — the branch
  comparison: stats, commit lists, pickers and swap controls.
- `src/components/dialogs/gn-config-dialog.ts` — the git config browser/editor.
- `src/components/dialogs/gn-conflict-resolution-dialog.ts` — the conflict
  resolution wizard: steps, per-file actions, batch summaries and its titles.
- `src/components/dialogs/gn-create-branch-dialog.ts` — the create-branch form.
- `src/components/dialogs/gn-create-tag-dialog.ts` — the create-tag form.
- `src/components/dialogs/gn-describe-dialog.ts` — the git-describe result and
  its copy actions.
- `src/components/dialogs/gn-export-import-dialog.ts` — patch/bundle export and
  import: tabs, previews, results and toasts.
- `src/components/dialogs/gn-gitignore-dialog.ts` — the .gitignore/.gitattributes
  editor: templates, rule rows, scopes and confirmations.
- `src/components/dialogs/gn-hooks-dialog.ts` — the git hooks manager: template
  picker, editor, enable/disable and delete flows.
- `src/components/dialogs/gn-init-dialog.ts` — the init-repository dialog.
- `src/components/dialogs/gn-interactive-rebase-dialog.ts` — the interactive
  rebase planner: todo actions, preview, warnings and autosquash.
- `src/components/dialogs/gn-keyboard-shortcuts-dialog.ts` — shortcut
  categories, descriptions and the footer hint.
- `src/components/dialogs/gn-lfs-dialog.ts` — the Git LFS dialog: tracked
  patterns, prune and migration prompts.
- `src/components/dialogs/gn-migration-dialog.ts` — the repository migration
  wizard: options, progress, completion report.
- `src/components/dialogs/gn-reflog-dialog.ts` — the reflog browser: entries,
  reset modes and help text.
- `src/components/dialogs/gn-remote-dialog.ts` — the remote manager: add/edit
  forms, prune confirmations and results.
- `src/components/dialogs/gn-repository-health-dialog.ts` — the repository
  health checks: statuses, explanations and maintenance actions.
- `src/components/dialogs/gn-scan-repositories-dialog.ts` — the folder scanner:
  progress, results and skipped-folder notices.
- `src/components/dialogs/gn-search-dialog.ts` — the commit/content search:
  filters, result counts and empty states.
- `src/components/dialogs/gn-submodule-dialog.ts` — the submodule manager:
  list, add/update/sync flows.
- `src/components/dialogs/gn-workspace-manager-dialog.ts` — the workspace
  manager: list, editor, batch fetch/pull summaries and delete confirmations.
- `src/components/dialogs/gn-worktree-dialog.ts` — the worktree manager: list,
  add/remove flows and badges.
- `src/components/dashboard/gn-context-dashboard.ts` — the compact and expanded
  repository dashboard: context labels, profile selector, remote counters.
- `src/components/dashboard/gn-integration-card.ts` — integration status badges,
  labels and tooltips.
- `src/components/dashboard/gn-profile-card.ts` — profile identity rows, default
  badge and assignment source.
- `src/components/graph/gn-graph-canvas.ts` — the commit graph's chrome: empty
  and error states, branch-visibility and column menus, export menu, tooltips,
  and screen-reader selection announcements.
- `src/components/panels/gn-analytics-panel.ts` — the analytics panel: chart
  titles, row labels and accessible descriptions.
- `src/components/panels/gn-blame-view.ts` — the blame panel.
- `src/components/panels/gn-file-history.ts` — the file-history panel, including
  its relative-time rows.
- `src/components/panels/gn-image-diff.ts` — the side-by-side image diff.
- `src/components/panels/gn-output-panel.ts` — the output panel and its controls.
- `src/graph/canvas-renderer.ts` — text drawn on the graph canvas itself (column
  headers, overflow hints, compact relative time), repainted on a locale change.
- `src/services/backend-message.service.ts` — backend SUCCESS/event text
  (branch-switch confirmations, multi-remote summaries, bisect start) recognised
  by the wording Rust formats it with, at the toast + progress-banner sinks.
- `src/services/backend-error.service.ts` — the one place backend error text is
  translated: `invokeCommand` rewrites the message from the error's stable code,
  so toasts/inline errors follow the language while the original English stays
  available for the rules that match on backend wording.
- `src/services/error-suggestion.service.ts` — the recovery suggestions and
  action labels shown next to a failed operation.
- `src/services/app-menu.service.ts` — the label table that retitles the native
  menu bar: the menu's structure lives in Rust, its text comes from here so the
  OS menu follows the language setting (`set_app_menu_labels` rebuilds it).
- `src/services/git.service.ts` — user-visible toasts/confirmations and the
  network-gate prompts (not git commands or backend error text).
- `src/services/keyboard.service.ts` — shortcut descriptions and category names,
  resolved at read time so the shortcuts dialog follows the active locale.
- `src/services/remote-operations.service.ts` — progress, failure and cancel copy
  for remote operations.
- `src/services/security-sync.service.ts` — the backend-settings sync toast.
- `src/services/window-drop.service.ts` — the folder-drop outcome toasts.
- `src/services/workspace.service.ts` — the workspace save toast.
- `src/utils/commit-selection.ts` — cherry-pick/squash confirmation copy.
- `src/utils/format.ts` — `formatRelativeTime()`'s compact "2m ago" forms.
- `src/utils/maintenance-confirms.ts` — maintenance confirmation dialogs.
- `src/utils/merge-preview.ts` — the merge-preview summary.
- `src/utils/rebase-messages.ts` — the shared paused-rebase and skipped-commit
  wording.
- `src/utils/ref-lock.ts` — the "another operation is running" notice.
- `src/utils/remote-availability.ts` — why a remote action is unavailable.
- `src/utils/repo-scoped-dialogs.ts` — the repository-scoped dialog sweep copy.
- `src/utils/restore-file.ts` — the restore-file toast.
- `src/utils/tag-delete.ts` — tag deletion confirmations and toasts.
- `src/components/panels/gn-commit-details.ts` — the commit details panel:
  metadata rows, actions, and its copy/error toasts.
- `src/components/panels/gn-diff-view.ts` — the diff toolbar, the whitespace
  menu, empty/error states, hunk/search controls and their toasts.
- `src/components/panels/gn-merge-editor.ts` — the conflict editor: side
  labels, resolution actions, notices and save/error toasts.
- `src/components/sidebar/gn-branch-list.ts` — branch groups, context menu,
  checkout/rename/delete confirmations and their toasts.
- `src/components/sidebar/gn-commit-panel.ts` — the commit form (fields,
  buttons, AI helpers, history dropdown labels) and its prompts/toasts.
- `src/components/sidebar/gn-file-status.ts` — file lists, status groups,
  context menus, diff/blame entry points and their toasts.
- `src/components/sidebar/gn-gitflow-panel.ts` — the git-flow panel and the
  copy of its init/start/finish dialogs.
- `src/components/sidebar/gn-left-panel.ts` — the left sidebar's tab headers.
- `src/components/sidebar/gn-pull-request-list.ts` — pull-request rows,
  badges, and empty/error states.
- `src/components/sidebar/gn-right-panel.ts` — the right sidebar's tab labels.
- `src/components/sidebar/gn-stash-list.ts` — stash rows, actions,
  confirmations and their toasts.
- `src/components/sidebar/gn-tag-list.ts` — tag groups, context menu,
  create/delete confirmations and their toasts.
- `src/components/toolbar/gn-search-bar.ts` — search placeholders, result
  count, filter labels and saved presets.
- `src/components/toolbar/gn-toolbar.ts` — toolbar buttons, the tab context
  menu, remote tooltips, badges and copy toasts.
- `src/components/welcome/gn-welcome.ts` — the whole component, including its
  toast messages and accessible labels.
- `src/palette-commands.ts` — the command palette's command labels and its
  prompt/confirm/toast copy.
- `src/services/local-ai.service.ts` — the model tier labels the Settings
  dialog shows next to each local model.
- `src/stores/settings.store.ts` — the whitespace-mode menu and the graph
  palette names (`getGraphColorSchemes()`), both built where the setting lives
  rather than frozen into a module-level constant at the startup locale.
- `src/utils/avatar-policy.ts` — why the avatar setting is unavailable when a
  security setting has turned it off.

Everything else in the app is still hard-coded English, including most of the
imperative toast/error strings inside the handlers of the files above (many of
them wrap a message that comes back from the Rust backend in English anyway).
Migrating a component is a mechanical change; see below.

## Locales we ship

| Code | Name     | Status                              |
| ---- | -------- | ----------------------------------- |
| `en` | English  | Source locale — the strings in code |
| `fr` | Français | Translated for the surfaces above   |
| `zh` | 中文     | Translated for the surfaces above   |

A fresh install opens in **中文**: Chinese is the product default, not the OS
language. An existing install keeps whatever language it has persisted — a
pre-v8 install is pinned to English so an upgrade never switches language on its
own — and `Reset to Defaults` returns to Chinese. Regional tags resolve to the
base locale we ship (`zh-CN`, `zh-TW`, `zh-Hans` → `zh`; `fr-CA`, `fr-FR` → `fr`);
a persisted locale we no longer ship falls back to English rather than failing to
render.

## Adding a localised string

1. Import the helpers and mark the class:

   ```ts
   import { localized, msg, str } from '@lit/localize';

   @customElement('gn-thing')
   @localized() // re-renders the component when the locale changes
   export class GnThing extends LitElement { … }
   ```

2. Wrap user-visible text in `msg()`:

   ```ts
   html`<button>${msg('Open')}</button>`;
   showToast(msg('Failed to open repository'), 'error');
   ```

   For text with interpolation use the `str` tag, so the placeholder survives
   translation:

   ```ts
   msg(str`Opened workspace: ${workspace.name}`);
   ```

   `msg()` is not limited to components — it works anywhere, as long as whatever
   renders the result re-renders on a locale change.

3. Extract the new strings into the XLIFF files:

   ```bash
   npm run localize:extract
   ```

   This rewrites `src/i18n/xliff/<locale>.xlf`, adding a `<trans-unit>` for every
   `msg()` call and keeping the translations that already exist.

4. Translate. For each new `<trans-unit>` in `src/i18n/xliff/fr.xlf`, add a
   `<target>` next to the `<source>`:

   ```xml
   <trans-unit id="s1f7698c061c208c9">
     <source>Open</source>
     <target>Ouvrir</target>
   </trans-unit>
   ```

   Copy any `<x id="0" …/>` placeholder tags from the source into the target,
   in whatever order the sentence needs. A unit with no `<target>` falls back to
   the English source, so an untranslated string is a missing translation, not a
   broken build.

5. Regenerate the runtime template modules:

   ```bash
   npm run localize:build
   ```

6. Commit the component, the XLIFF files **and** the regenerated
   `src/i18n/generated/` modules.

## Adding a locale

1. Add its code to `targetLocales` in `lit-localize.json`.
2. Add its display name (endonym, e.g. `Deutsch`) to `localeNames` in
   `src/i18n/index.ts`, and add a loader entry to `localeLoaders` in the same
   file. TypeScript fails the build if the name is missing.
3. Run `npm run localize:extract`, translate the new
   `src/i18n/xliff/<locale>.xlf`, then `npm run localize:build`.

## Generated files: committed on purpose

`src/i18n/generated/locale-codes.ts` and `src/i18n/generated/locales/*.ts` are
generated by `npm run localize:build`, and they **are committed**. The app
imports them directly, so `npm run build`, `npm test` and the Tauri build would
all fail on a fresh clone if they were ignored, and CI does not run the
localisation toolchain. They are excluded from ESLint (see `eslint.config.mjs`)
because they are machine output — never edit them by hand; re-run the build
instead.

`src/i18n/xliff/*.xlf` is the translator-facing source of truth and is committed
too.
