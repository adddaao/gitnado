import type { Commit } from './types/git.types.ts';
import type { IntegrationType } from './types/integration-accounts.types.ts';
import type { OpenRepository } from './stores/index.ts';
import type { PaletteCommand } from './components/dialogs/gn-command-palette.ts';
import type { SearchDialogMode } from './components/dialogs/gn-search-dialog.ts';
import type { GnGraphCanvas } from './components/graph/gn-graph-canvas.ts';
import type { GnCreateTagDialog } from './components/dialogs/gn-create-tag-dialog.ts';
import type { GnCreateBranchDialog } from './components/dialogs/gn-create-branch-dialog.ts';
import type { GnExportImportDialog } from './components/dialogs/gn-export-import-dialog.ts';
import type { GnDescribeDialog } from './components/dialogs/gn-describe-dialog.ts';
import type { GnCompareBranchesDialog } from './components/dialogs/gn-compare-branches-dialog.ts';
import { msg, str } from '@lit/localize';
import { dialogs } from './stores/dialog.store.ts';
import { uiStore } from './stores/index.ts';
import { showToast } from './services/notification.service.ts';
import { showConfirm, showPrompt } from './services/dialog.service.ts';
import {
  openRepositoryInEditor,
  openRepositoryInFileManager,
  openRepositoryInTerminal,
} from './services/open-location.service.ts';

/**
 * What the command table needs from app-shell.
 *
 * The table is ~500 lines of the shell's own operations wrapped in palette
 * entries; lifting it out keeps app-shell to the behaviour and leaves one
 * place to read the full list of commands. This interface is the exact
 * dependency surface — the members it names are the only reason those
 * app-shell members are not private.
 */
export interface PaletteCommandHost {
  readonly activeRepository: OpenRepository | null;
  readonly selectedCommit: Commit | null;
  readonly shadowRoot: ShadowRoot | null;

  readonly graphCanvas?: GnGraphCanvas;
  readonly createTagDialog?: GnCreateTagDialog;
  readonly createBranchDialog?: GnCreateBranchDialog;
  readonly exportImportDialog?: GnExportImportDialog;
  readonly describeDialog?: GnDescribeDialog;
  readonly compareBranchesDialog?: GnCompareBranchesDialog;

  /** Wrap an action so it toasts "open a repository first" when there is none. */
  requiresRepository(action: () => void): () => void;
  warnRepositoryBusy(): void;
  claimRefOperation(repoPath: string): boolean;
  releaseRefOperation(repoPath: string): void;

  handleFetch(): Promise<void>;
  handlePull(pinnedRepoPath?: string): Promise<void>;
  handlePush(): Promise<void>;
  handleRefresh(): Promise<void>;
  handleStageAll(): void;
  handleUnstageAll(): void;
  handleCreateStash(): Promise<void>;
  handleToggleSearch(): void;
  handleRunGc(aggressive?: boolean): Promise<void>;
  handleRunFsck(): Promise<void>;
  handleRunPrune(): Promise<void>;
  openBranchCleanup(): Promise<void>;
  openSearchDialog(mode: SearchDialogMode): void;
  openIntegrationStandalone(type: IntegrationType): void;
  refreshConflictDialogRepo(pinnedPath: string | null): void;
  revealCommitInGraph(oid: string): void;
  toggleLeftPanel(): void;
}

/**
 * Every entry of the command palette, in display order.
 *
 * Also the source of truth the native menu bar resolves its item ids against,
 * so an entry's `id` and its `action` are a contract, not an implementation
 * detail: renaming an id here silently unwires the menu item that points at it.
 */
export function buildPaletteCommands(shell: PaletteCommandHost): PaletteCommand[] {
  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';

  const commands: PaletteCommand[] = [
    {
      id: 'fetch',
      label: msg('Fetch from remote'),
      category: 'action',
      icon: 'fetch',
      action: shell.requiresRepository(() => shell.handleFetch()),
    },
    {
      id: 'pull',
      label: msg('Pull from remote'),
      category: 'action',
      icon: 'pull',
      action: shell.requiresRepository(() => shell.handlePull()),
    },
    {
      id: 'push',
      label: msg('Push to remote'),
      category: 'action',
      icon: 'push',
      action: shell.requiresRepository(() => shell.handlePush()),
    },
    {
      id: 'refresh',
      label: msg('Refresh repository'),
      category: 'action',
      icon: 'refresh',
      shortcut: `${mod}R`,
      action: () => shell.handleRefresh(),
    },
    {
      id: 'graph-jump-head',
      label: msg('Graph: Jump to HEAD'),
      category: 'navigation',
      icon: 'commit',
      action: shell.requiresRepository(() => {
        if (shell.graphCanvas?.jumpToHead()) {
          return;
        }
        // Route the miss through the shared reveal helper so the toast
        // distinguishes loaded-but-filtered from not-loaded
        const headOid = shell.graphCanvas?.getHeadOid();
        if (headOid !== undefined) {
          shell.revealCommitInGraph(headOid);
        } else {
          showToast(msg('HEAD commit is not loaded in the graph'), 'info', 4000);
        }
      }),
    },
    {
      id: 'toggle-output-panel',
      label: msg('Toggle Output Panel'),
      category: 'action',
      icon: 'terminal',
      // The panel is rendered only inside the active-repository layout, so
      // toggling it with nothing open would flip a flag no one can see — and
      // pop the panel open on the next repository the user opened.
      action: shell.requiresRepository(() => {
        dialogs.setOpen('outputPanel', !dialogs.isOpen('outputPanel'));
      }),
    },
    {
      id: 'stash',
      label: msg('Create stash'),
      category: 'action',
      icon: 'stash',
      action: shell.requiresRepository(() => shell.handleCreateStash()),
    },
    {
      id: 'create-branch',
      label: msg('Create branch'),
      category: 'action',
      icon: 'branch',
      shortcut: `${mod}⇧N`,
      action: shell.requiresRepository(() => shell.createBranchDialog?.open()),
    },
    {
      id: 'create-tag',
      label: msg('Create tag'),
      category: 'action',
      icon: 'tag',
      action: shell.requiresRepository(() => shell.createTagDialog?.open()),
    },
    {
      id: 'export-archive',
      label: msg('Export archive…'),
      category: 'action',
      icon: 'file',
      action: shell.requiresRepository(() => shell.exportImportDialog?.open({ tab: 'archive' })),
    },
    {
      id: 'create-patch',
      label: msg('Create patch from commits…'),
      category: 'action',
      icon: 'commit',
      action: shell.requiresRepository(() =>
        shell.exportImportDialog?.open({
          tab: 'patch',
          patchMode: 'create',
          commitOid: shell.selectedCommit?.oid,
        }),
      ),
    },
    {
      id: 'apply-patch',
      label: msg('Apply patch file…'),
      category: 'action',
      icon: 'commit',
      action: shell.requiresRepository(() =>
        shell.exportImportDialog?.open({ tab: 'patch', patchMode: 'apply' }),
      ),
    },
    {
      id: 'create-bundle',
      label: msg('Create bundle…'),
      category: 'action',
      icon: 'file',
      action: shell.requiresRepository(() =>
        shell.exportImportDialog?.open({ tab: 'bundle', bundleMode: 'create' }),
      ),
    },
    {
      id: 'import-bundle',
      label: msg('Import bundle…'),
      category: 'action',
      icon: 'file',
      action: shell.requiresRepository(() =>
        shell.exportImportDialog?.open({ tab: 'bundle', bundleMode: 'import' }),
      ),
    },
    {
      id: 'settings',
      label: msg('Open settings'),
      category: 'action',
      icon: 'settings',
      shortcut: `${mod},`,
      action: () => { dialogs.open('settings'); },
    },
    {
      id: 'remotes',
      label: msg('Manage remotes'),
      category: 'action',
      icon: 'globe',
      action: shell.requiresRepository(() => { dialogs.open('remotes'); }),
    },
    {
      id: 'changelog',
      label: msg('Generate Changelog'),
      category: 'action',
      icon: 'tag',
      action: shell.requiresRepository(() => {
        const dialog = shell.shadowRoot?.querySelector('gn-changelog-dialog');
        if (dialog) (dialog as import('./components/dialogs/gn-changelog-dialog.ts').GnChangelogDialog).open();
      }),
    },
    {
      id: 'smart-undo',
      label: msg('Smart Undo (AI)'),
      category: 'action',
      icon: 'undo',
      action: shell.requiresRepository(async () => {
        // Captured BEFORE the prompt/AI/confirm awaits (all yield): the
        // reflog reset must run on the repo it was invoked on, even if the
        // user switches tabs while any of those dialogs/calls are pending.
        const repoPath = shell.activeRepository!.repository.path;
        const query = await showPrompt(
          msg('Smart Undo (AI)'),
          msg(
            'Describe what you want to undo (e.g., "before the rebase", "undo last 3 commits"):',
          ),
        );
        if (!query) return;

        const result = await import('./services/ai.service.ts').then(m =>
          m.findReflogEntry(repoPath, query)
        );

        if (result.success && result.data) {
          const match = result.data;

          // Resolve the index to a commit BEFORE the confirm. An AI round
          // trip plus a prompt plus a confirm all elapse between the reflog
          // being read and the reset firing, and any commit or checkout in
          // that window renumbers every entry. Pinning the oid means the
          // reset either lands on the commit named here or is refused.
          const git = await import('./services/git.service.ts');
          const reflog = await git.getReflog(repoPath);
          const target = reflog.success ? reflog.data?.[match.index] : undefined;

          if (!target) {
            showToast(msg('Could not resolve that reflog entry — try again'), 'error');
            return;
          }

          const confirmed = await showConfirm(
            msg('Smart Undo'),
            msg(
              str`${match.description}\n\nReset to ${target.shortId} (HEAD@{${match.index}})?\n\nThis branch will point at ${target.shortId}. Any commit no longer reachable from it is recoverable only through the reflog. Your changes remain staged.`,
            ),
            'warning'
          );
          if (confirmed) {
            // The other caller of reset_to_reflog — gn-reflog-dialog — claims
            // the shared working-tree lock; this palette route to the same
            // command was missed by that sweep. The expected_oid pin guards
            // against a STALE index, not against a checkout moving the branch
            // underneath the reset.
            // runRefExclusive returns silently when the lock is held, which
            // suits context-menu items whose buttons carry a ?disabled
            // binding. This one sits behind a prompt, an AI call and a
            // confirm, so a silent return reads as "the reset happened".
            if (!shell.claimRefOperation(repoPath)) {
              shell.warnRepositoryBusy();
              return;
            }
            try {
              const resetResult = await git.resetToReflog(
                repoPath,
                match.index,
                'soft',
                target.oid
              );
              if (resetResult.success) {
                showToast(msg('Undo successful'), 'success');
                shell.refreshConflictDialogRepo(repoPath);
              } else {
                showToast(resetResult.error?.message ?? msg('Undo failed'), 'error');
              }
            } finally {
              shell.releaseRefOperation(repoPath);
            }
          }
        } else {
          showToast(
            result.error?.message ?? msg('Could not find matching reflog entry'),
            'error',
          );
        }
      }),
    },
    {
      id: 'clean',
      label: msg('Clean working directory'),
      category: 'action',
      icon: 'trash',
      action: shell.requiresRepository(() => { dialogs.open('clean'); }),
    },
    {
      id: 'branch-cleanup',
      label: msg('Clean up branches'),
      category: 'action',
      icon: 'git-branch',
      action: shell.requiresRepository(() => { void shell.openBranchCleanup(); }),
    },
    {
      id: 'bisect',
      label: msg('Start bisect (find bug)'),
      category: 'action',
      icon: 'search',
      action: shell.requiresRepository(() => { dialogs.open('bisect'); }),
    },
    {
      id: 'submodules',
      label: msg('Manage submodules'),
      category: 'action',
      icon: 'folder',
      action: shell.requiresRepository(() => { dialogs.open('submodules'); }),
    },
    {
      id: 'worktrees',
      label: msg('Manage worktrees'),
      category: 'action',
      icon: 'folder',
      action: shell.requiresRepository(() => { dialogs.open('worktrees'); }),
    },
    {
      id: 'lfs',
      label: msg('Manage Git LFS'),
      category: 'action',
      icon: 'folder',
      action: shell.requiresRepository(() => { dialogs.open('lfs'); }),
    },
    {
      id: 'gpg',
      label: msg('GPG Signing Settings'),
      category: 'action',
      icon: 'key',
      action: shell.requiresRepository(() => { dialogs.open('gpg'); }),
    },
    {
      id: 'ssh',
      label: msg('SSH Key Management'),
      category: 'action',
      icon: 'key',
      action: () => { dialogs.open('ssh'); },
    },
    {
      id: 'config',
      label: msg('Git Configuration'),
      category: 'action',
      icon: 'settings',
      action: shell.requiresRepository(() => { dialogs.open('config'); }),
    },
    {
      id: 'credentials',
      label: msg('Credential Management'),
      category: 'action',
      icon: 'key',
      action: shell.requiresRepository(() => { dialogs.open('credentials'); }),
    },
    {
      id: 'gc',
      label: msg('Run Garbage Collection'),
      category: 'action',
      icon: 'trash',
      action: shell.requiresRepository(() => shell.handleRunGc()),
    },
    {
      id: 'gc-aggressive',
      label: msg('Run Garbage Collection (Aggressive)'),
      category: 'action',
      icon: 'trash',
      action: shell.requiresRepository(() => shell.handleRunGc(true)),
    },
    {
      id: 'fsck',
      label: msg('Check Repository Integrity'),
      category: 'action',
      icon: 'search',
      action: shell.requiresRepository(() => shell.handleRunFsck()),
    },
    {
      id: 'prune',
      label: msg('Prune Unreachable Objects'),
      category: 'action',
      icon: 'trash',
      action: shell.requiresRepository(() => shell.handleRunPrune()),
    },
    {
      id: 'repository-health',
      label: msg('Repository Health & Maintenance'),
      category: 'action',
      icon: 'activity',
      action: shell.requiresRepository(() => { dialogs.open('repositoryHealth'); }),
    },
    {
      id: 'github',
      label: msg('GitHub Integration'),
      category: 'action',
      icon: 'github',
      // Account connection is repo-independent; only PR/issue/pipeline tabs guard themselves.
      action: () => shell.openIntegrationStandalone('github'),
    },
    {
      id: 'gitlab',
      label: msg('GitLab Integration'),
      category: 'action',
      icon: 'gitlab',
      action: () => shell.openIntegrationStandalone('gitlab'),
    },
    {
      id: 'bitbucket',
      label: msg('Bitbucket Integration'),
      category: 'action',
      icon: 'bitbucket',
      action: () => shell.openIntegrationStandalone('bitbucket'),
    },
    {
      id: 'azure-devops',
      label: msg('Azure DevOps Integration'),
      category: 'action',
      icon: 'azure',
      action: () => shell.openIntegrationStandalone('azure-devops'),
    },
    {
      id: 'oidc',
      label: msg('Enterprise SSO (OIDC) Integration'),
      category: 'action',
      icon: 'key',
      action: () => shell.openIntegrationStandalone('oidc'),
    },
    {
      id: 'profiles',
      label: msg('Profiles & Accounts'),
      category: 'action',
      icon: 'user',
      action: () => { dialogs.open('profileManager'); },
    },
    {
      id: 'search',
      label: msg('Search commits'),
      category: 'action',
      icon: 'search',
      shortcut: `${mod}F`,
      action: () => shell.handleToggleSearch(),
    },
    {
      id: 'search-in-files',
      label: msg('Search in files'),
      category: 'action',
      icon: 'search',
      action: shell.requiresRepository(() => shell.openSearchDialog('files')),
    },
    {
      id: 'search-in-diff',
      label: msg('Search in current diff'),
      category: 'action',
      icon: 'search',
      action: shell.requiresRepository(() => shell.openSearchDialog('diff')),
    },
    {
      id: 'search-commit-content',
      label: msg('Find commits that changed text'),
      category: 'action',
      icon: 'search',
      action: shell.requiresRepository(() => shell.openSearchDialog('commits')),
    },
    // "all" means "everything the Changes list is showing" — the same set the
    // section header button acts on, so the palette, the s/u shortcuts and the
    // button can never disagree. The label stays unqualified because the path
    // filter is a transient state and this table is built once (see
    // app-shell's getPaletteCommands memoisation); gn-file-status reports the
    // narrowed scope in a toast when a filter was in force.
    {
      id: 'stage-all',
      label: msg('Stage all changes'),
      category: 'action',
      icon: 'commit',
      action: shell.requiresRepository(() => shell.handleStageAll()),
    },
    {
      id: 'unstage-all',
      label: msg('Unstage all changes'),
      category: 'action',
      icon: 'commit',
      action: shell.requiresRepository(() => shell.handleUnstageAll()),
    },
    {
      id: 'toggle-left-panel',
      label: msg('Toggle left panel'),
      category: 'navigation',
      shortcut: `${mod}B`,
      action: () => shell.toggleLeftPanel(),
    },
    {
      id: 'toggle-right-panel',
      label: msg('Toggle right panel'),
      category: 'navigation',
      shortcut: `${mod}J`,
      action: () => uiStore.getState().togglePanel('right'),
    },
    {
      id: 'undo',
      label: msg('Undo (open reflog)'),
      category: 'action',
      icon: 'refresh',
      shortcut: `${mod}Z`,
      action: shell.requiresRepository(() => { dialogs.open('reflog'); }),
    },
    {
      id: 'describe',
      label: msg('Describe commit (git describe)'),
      category: 'action',
      icon: 'tag',
      action: shell.requiresRepository(() => { shell.describeDialog?.open(); }),
    },
    {
      id: 'compare-branches',
      label: msg('Compare branches'),
      category: 'action',
      icon: 'branch',
      action: shell.requiresRepository(() => { shell.compareBranchesDialog?.open(); }),
    },
    {
      id: 'workspaces',
      label: msg('Manage workspaces'),
      category: 'action',
      icon: 'folder',
      action: () => { dialogs.open('workspaceManager'); },
    },
    {
      id: 'hooks',
      label: msg('Manage git hooks'),
      category: 'action',
      icon: 'terminal',
      action: shell.requiresRepository(() => { dialogs.open('hooks'); }),
    },
    {
      id: 'gitignore',
      label: msg('Edit .gitignore & .gitattributes'),
      category: 'action',
      icon: 'file',
      action: shell.requiresRepository(() => { dialogs.open('gitignore'); }),
    },
    // The palette acts on the ACTIVE repository; the same three actions are
    // on the repository tab context menu for any open tab. Failures (no
    // terminal emulator, a path that has gone away, an editor that cannot be
    // spawned) are toasted by the shared service with the backend message.
    {
      id: 'open-in-terminal',
      label: msg('Open in Terminal'),
      category: 'action',
      icon: 'terminal',
      action: shell.requiresRepository(() => {
        void openRepositoryInTerminal(shell.activeRepository!.repository.path);
      }),
    },
    {
      id: 'reveal-in-file-manager',
      label: msg('Reveal in File Manager'),
      category: 'action',
      icon: 'folder',
      action: shell.requiresRepository(() => {
        void openRepositoryInFileManager(shell.activeRepository!.repository.path);
      }),
    },
    {
      id: 'open-in-editor',
      label: msg('Open in Editor'),
      category: 'action',
      icon: 'file',
      action: shell.requiresRepository(() => {
        void openRepositoryInEditor(shell.activeRepository!.repository.path);
      }),
    },
  ];

  return commands;
}
