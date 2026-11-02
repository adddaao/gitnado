import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { sharedStyles } from '../../styles/shared-styles.ts';
import { repositoryStore } from '../../stores/index.ts';
import {
  settingsStore,
  clampCommitPanelHeight,
  MIN_COMMIT_PANEL_HEIGHT,
  MAX_COMMIT_PANEL_HEIGHT,
} from '../../stores/settings.store.ts';
import * as gitService from '../../services/git.service.ts';
import './gn-file-status.ts';
import './gn-commit-panel.ts';
import '../panels/gn-commit-details.ts';
import '../panels/gn-analytics-panel.ts';
import type { Commit, RefInfo } from '../../types/git.types.ts';

type TabType = 'changes' | 'details' | 'analytics';

/**
 * Right panel container component
 * Contains file status, commit panel, and commit details in a unified tabbed interface
 */
@customElement('gn-right-panel')
@localized()
export class GnRightPanel extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .tab-bar {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-bg-secondary);
        flex-shrink: 0;
        padding: 0 4px;
      }

      .tab {
        flex: 1;
        padding: 6px 12px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-secondary);
        background: transparent;
        border: 1px solid transparent;
        border-bottom: none;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        margin-bottom: -1px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all var(--transition-fast);
        user-select: none;
      }

      .tab:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
      }

      .tab.active {
        color: var(--color-primary);
        font-weight: var(--font-weight-semibold);
        background: var(--color-bg-primary);
        border-color: var(--color-border);
        border-bottom-color: var(--color-bg-primary);
      }

      .tab .badge {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: var(--radius-full);
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
      }

      .tab.active .badge {
        background: var(--color-primary-bg);
        color: var(--color-primary);
      }

      .tab .indicator {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--color-warning);
      }

      .tab-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
      }

      .tab-panel {
        display: none;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        min-height: 0;
      }

      .tab-panel.active {
        display: flex;
      }

      /* Changes panel layout */
      .changes-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
        min-height: 0;
      }

      .file-status-container {
        flex: 1;
        overflow: auto;
        min-height: 100px;
      }

      /* Vertical drag handle between the staged-file list and the commit
         panel. The visible rule is a 2px pseudo-element inside a taller grab
         area, so the divider is easy to hit without looking heavy. */
      .resize-handle-v {
        flex: 0 0 7px;
        position: relative;
        cursor: row-resize;
        background: transparent;
        touch-action: none;
        z-index: 5;
      }

      .resize-handle-v::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        top: 3px;
        height: 1px;
        background: var(--color-border);
        transition: background-color 0.15s ease;
      }

      .resize-handle-v:hover::after,
      .resize-handle-v.dragging::after,
      .resize-handle-v:focus-visible::after {
        background: var(--color-primary);
      }

      .resize-handle-v:focus-visible {
        outline: none;
      }

      :host(.resizing-v),
      :host(.resizing-v) * {
        cursor: row-resize !important;
        user-select: none;
      }

      .commit-panel-container {
        flex-shrink: 0;
        overflow-y: auto;
      }

      /* Details panel layout */
      .details-panel {
        flex: 1;
        overflow: auto;
      }

      /* Analytics panel layout */
      .analytics-panel {
        flex: 1;
        overflow: auto;
      }

      .placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: var(--spacing-md);
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
        text-align: center;
      }

      .shortcut-hint {
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
        padding: 4px 8px;
        background: var(--color-bg-tertiary);
        border-radius: var(--radius-sm);
        margin-left: auto;
      }

      kbd {
        font-family: var(--font-family-mono);
        font-size: 10px;
        padding: 1px 4px;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 3px;
      }
    `,
  ];

  @property({ type: Object }) commit: Commit | null = null;
  @property({ type: Array }) refs: RefInfo[] = [];

  @state() private repositoryPath: string | null = null;
  @state() private stagedCount: number = 0;
  @state() private changesCount: number = 0;
  @state() private activeTab: TabType = 'changes';
  @state() private githubOwner: string = '';
  @state() private githubRepo: string = '';
  @state() private hasUnseenChanges: boolean = false;
  /** Height of the commit panel, in CSS px — user-resizable, persisted. */
  @state() private commitPanelHeight: number = settingsStore.getState().commitPanelHeight;
  @state() private resizingCommitPanel = false;

  private unsubscribe?: () => void;
  private previousCommitOid: string | null = null;

  /** Pointer position and panel height captured at drag start. */
  private resizeStartY = 0;
  private resizeStartHeight = 0;
  /** Latest coalesced pointer position while dragging the divider. */
  private resizePendingClientY: number | null = null;
  private resizeRafId: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    const initialState = repositoryStore.getState();
    this.repositoryPath = initialState.getActiveRepository()?.repository.path ?? null;
    if (this.repositoryPath) {
      this.detectGitHubRepo();
    }

    // The store is the persisted authority for the divider position; read it
    // once here (declaration defaults run before persistence rehydrates in a
    // fresh session) and keep a reset-to-defaults in Settings in step.
    this.commitPanelHeight = settingsStore.getState().commitPanelHeight;

    this.unsubscribe = repositoryStore.subscribe((state) => {
      const activeRepo = state.getActiveRepository();
      const newPath = activeRepo?.repository.path ?? null;
      if (newPath !== this.repositoryPath) {
        this.repositoryPath = newPath;
        if (newPath) {
          this.detectGitHubRepo();
        } else {
          this.githubOwner = '';
          this.githubRepo = '';
        }
      }
    });

    // Listen for keyboard shortcuts
    this.addEventListener('keydown', this.handleKeyDown);
  }

  private async detectGitHubRepo(): Promise<void> {
    if (!this.repositoryPath) return;

    try {
      const result = await gitService.detectGitHubRepo(this.repositoryPath);
      if (result.success && result.data) {
        this.githubOwner = result.data.owner;
        this.githubRepo = result.data.repo;
      } else {
        this.githubOwner = '';
        this.githubRepo = '';
      }
    } catch {
      this.githubOwner = '';
      this.githubRepo = '';
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.cancelPendingCommitPanelResizeFrame();
    this.resizePendingClientY = null;
    this.removeCommitPanelResizeListeners();
    this.removeEventListener('keydown', this.handleKeyDown);
  }

  updated(changedProperties: Map<string, unknown>): void {
    // Auto-switch to details tab when a new commit is selected
    if (changedProperties.has('commit')) {
      const newOid = this.commit?.oid ?? null;
      if (newOid && newOid !== this.previousCommitOid) {
        this.activeTab = 'details';
      }
      this.previousCommitOid = newOid;
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    // Tab switching shortcuts. Ctrl+SHIFT+digit: plain Ctrl+digit belongs to
    // the global repository-tab shortcuts (browser convention), so the panel
    // takes the shifted chord. Matched on e.code because Shift changes e.key
    // ('1' -> '!') on most layouts.
    if (!e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
    if (e.code === 'Digit1') {
      e.preventDefault();
      this.switchTab('changes');
    } else if (e.code === 'Digit2') {
      e.preventDefault();
      this.switchTab('details');
    } else if (e.code === 'Digit3') {
      e.preventDefault();
      this.switchTab('analytics');
    }
  };

  // ========================================================================
  // Commit panel divider (drag to resize the panel vertically)
  // ========================================================================

  /**
   * The tallest the commit panel may be while still leaving the staged-file
   * list usable. Measured from this element's own height, because the tab bar
   * and the divider live outside the two panes the store's bounds describe.
   */
  private commitPanelMaxHeight(): number {
    const total = this.clientHeight;
    if (!total) return MAX_COMMIT_PANEL_HEIGHT;
    // The tab bar plus the divider row live outside both panes; keep at least
    // the file list's own 100px min-height plus a little breathing room.
    const available = total - 34 - 120;
    return Math.max(MIN_COMMIT_PANEL_HEIGHT, Math.min(MAX_COMMIT_PANEL_HEIGHT, available));
  }

  private clampCommitPanelToViewport(value: number): number {
    return Math.min(this.commitPanelMaxHeight(), clampCommitPanelHeight(value));
  }

  private handleCommitPanelResizeStart = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();

    this.resizingCommitPanel = true;
    this.resizeStartY = e.clientY;
    this.resizeStartHeight = this.commitPanelHeight;
    this.classList.add('resizing-v');

    document.addEventListener('mousemove', this.handleCommitPanelResizeMove);
    document.addEventListener('mouseup', this.handleCommitPanelResizeEnd);
  };

  private handleCommitPanelResizeMove = (e: MouseEvent): void => {
    if (!this.resizingCommitPanel) return;

    // Only remember where the pointer is; the height is assigned once per frame
    // below. Writing it here re-renders the whole sidebar at pointer-event rate
    // for a value the user can only ever see once per frame.
    this.resizePendingClientY = e.clientY;
    if (this.resizeRafId !== null) return;
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = null;
      this.applyPendingCommitPanelResize();
    });
  };

  private applyPendingCommitPanelResize(): void {
    const clientY = this.resizePendingClientY;
    if (clientY === null || !this.resizingCommitPanel) return;
    this.resizePendingClientY = null;

    // Dragging UP grows the commit panel: clientY decreases, so invert.
    const delta = this.resizeStartY - clientY;
    this.commitPanelHeight = this.clampCommitPanelToViewport(this.resizeStartHeight + delta);
  }

  private handleCommitPanelResizeEnd = (): void => {
    // Flush the last coalesced move BEFORE clearing `resizingCommitPanel`
    // (which applyPendingCommitPanelResize checks): mouseup usually lands in
    // the same frame as the final mousemove, and dropping that frame would
    // persist a height a few pixels from where the user released the divider.
    this.cancelPendingCommitPanelResizeFrame();
    this.applyPendingCommitPanelResize();
    this.resizingCommitPanel = false;
    this.classList.remove('resizing-v');
    this.removeCommitPanelResizeListeners();

    settingsStore.getState().setCommitPanelHeight(this.commitPanelHeight);
  };

  private removeCommitPanelResizeListeners(): void {
    document.removeEventListener('mousemove', this.handleCommitPanelResizeMove);
    document.removeEventListener('mouseup', this.handleCommitPanelResizeEnd);
  }

  private cancelPendingCommitPanelResizeFrame(): void {
    if (this.resizeRafId !== null) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = null;
    }
  }

  /** Keyboard resizing for the divider: arrows adjust, Home/End go to bounds. */
  private handleCommitPanelResizeKeyDown = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 40 : 10;
    let next: number;
    switch (e.key) {
      case 'ArrowUp':
        next = this.commitPanelHeight + step;
        break;
      case 'ArrowDown':
        next = this.commitPanelHeight - step;
        break;
      case 'Home':
        next = MIN_COMMIT_PANEL_HEIGHT;
        break;
      case 'End':
        next = this.commitPanelMaxHeight();
        break;
      default:
        return;
    }
    e.preventDefault();
    // Arrow/Home/End are global shortcuts too (previous/next commit, first/last
    // row), and the document-level keyboard service would also act on them,
    // switching the panel to Details and hiding the divider mid-resize. While
    // the divider has focus, these keys belong to the divider.
    e.stopPropagation();
    this.commitPanelHeight = this.clampCommitPanelToViewport(next);
    settingsStore.getState().setCommitPanelHeight(this.commitPanelHeight);
  };

  private switchTab(tab: TabType): void {
    this.activeTab = tab;
    if (tab === 'changes') {
      this.hasUnseenChanges = false;
    }
    this.dispatchEvent(new CustomEvent('tab-changed', {
      detail: { tab },
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * Public method to switch to changes tab from outside.
   *
   * `gn-commit-panel` lives in that tab and is the sole listener for
   * `trigger-amend`. Right-clicking a commit in the graph selects it first,
   * which auto-switches this panel to Details — so amend mode was being turned
   * on inside a `.tab-panel` with `display: none` and the gesture looked like
   * it did nothing.
   */
  public showChanges(): void {
    this.switchTab('changes');
  }

  /** Public method to switch to details tab from outside */
  public showDetails(): void {
    this.switchTab('details');
  }

  /** Public method to switch to analytics tab from outside */
  public showAnalytics(): void {
    this.switchTab('analytics');
  }

  render() {
    if (!this.repositoryPath) {
      return html`<div class="placeholder">${msg('No repository open')}</div>`;
    }

    return html`
      <div class="tab-bar">
        <button
          class="tab ${this.activeTab === 'changes' ? 'active' : ''}"
          @click=${() => this.switchTab('changes')}
          title=${msg('Working Changes (Ctrl+Shift+1)')}
        >
          <span>${msg('Changes')}</span>
          ${this.changesCount > 0 ? html`<span class="badge">${this.changesCount}</span>` : nothing}
          ${this.hasUnseenChanges && this.activeTab !== 'changes' ? html`<span class="indicator"></span>` : nothing}
        </button>
        <button
          class="tab ${this.activeTab === 'details' ? 'active' : ''}"
          @click=${() => this.switchTab('details')}
          title=${msg('Commit Details (Ctrl+Shift+2)')}
        >
          <span>${msg('Details')}</span>
          ${this.commit ? html`<span class="badge">${this.commit.oid.slice(0, 7)}</span>` : nothing}
        </button>
        <button
          class="tab ${this.activeTab === 'analytics' ? 'active' : ''}"
          @click=${() => this.switchTab('analytics')}
          title=${msg('Repository Analytics (Ctrl+Shift+3)')}
        >
          <span>${msg('Analytics')}</span>
        </button>
      </div>

      <div class="tab-content">
        <!-- Changes Panel -->
        <div class="tab-panel ${this.activeTab === 'changes' ? 'active' : ''}">
          <div class="changes-panel">
            <div class="file-status-container">
              <gn-file-status
                .repositoryPath=${this.repositoryPath}
                @status-changed=${this.handleStatusChanged}
              ></gn-file-status>
            </div>
            <div
              class="resize-handle-v ${this.resizingCommitPanel ? 'dragging' : ''}"
              role="separator"
              aria-orientation="horizontal"
              aria-label=${msg('Resize commit panel')}
              aria-valuenow=${this.commitPanelHeight}
              aria-valuemin=${MIN_COMMIT_PANEL_HEIGHT}
              aria-valuemax=${this.commitPanelMaxHeight()}
              tabindex="0"
              title=${msg('Drag to resize the commit panel')}
              @mousedown=${this.handleCommitPanelResizeStart}
              @keydown=${this.handleCommitPanelResizeKeyDown}
            ></div>
            <div
              class="commit-panel-container"
              style="height: ${this.commitPanelHeight}px"
            >
              <gn-commit-panel
                .repositoryPath=${this.repositoryPath}
                .stagedCount=${this.stagedCount}
                @commit-created=${this.handleCommitCreated}
              ></gn-commit-panel>
            </div>
          </div>
        </div>

        <!-- Details Panel -->
        <div class="tab-panel ${this.activeTab === 'details' ? 'active' : ''}">
          <div class="details-panel">
            <gn-commit-details
              .repositoryPath=${this.repositoryPath}
              .commit=${this.commit}
              .refs=${this.refs}
              .githubOwner=${this.githubOwner}
              .githubRepo=${this.githubRepo}
            ></gn-commit-details>
          </div>
        </div>

        <!-- Analytics Panel -->
        <div class="tab-panel ${this.activeTab === 'analytics' ? 'active' : ''}">
          <div class="analytics-panel">
            <gn-analytics-panel
              .repositoryPath=${this.repositoryPath}
              .active=${this.activeTab === 'analytics'}
            ></gn-analytics-panel>
          </div>
        </div>
      </div>
    `;
  }

  private handleStatusChanged(e: CustomEvent<{ stagedCount: number; totalCount?: number }>): void {
    this.stagedCount = e.detail.stagedCount;
    if (e.detail.totalCount !== undefined) {
      const previousCount = this.changesCount;
      this.changesCount = e.detail.totalCount;
      // Show indicator if changes happened while on details tab
      if (this.activeTab === 'details' && this.changesCount > previousCount) {
        this.hasUnseenChanges = true;
      }
    }
  }

  /** Forward the repo the commit ran in (captured pre-await by the commit
   * panel) so the host pins the refresh to it, not whichever tab is active if
   * the user switched mid-commit. */
  private handleCommitCreated(e?: Event): void {
    const repoPath = (e as CustomEvent<{ repositoryPath?: string }> | undefined)?.detail
      ?.repositoryPath;
    this.dispatchEvent(new CustomEvent('repository-changed', { bubbles: true, composed: true }));
    window.dispatchEvent(new CustomEvent('repository-refresh', { detail: { repoPath } }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gn-right-panel': GnRightPanel;
  }
}
