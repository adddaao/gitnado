/**
 * Tests for the vertical divider between the staged-file list and the commit
 * panel.
 *
 * The divider exists because the commit panel used to size itself to its
 * content: a long AI result (or a long commit body) pushed the file list out of
 * view, and there was no way to give the panel more room. It must be draggable,
 * clamped so neither pane can disappear, keyboard-operable, and persisted.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnRightPanel } from '../gn-right-panel.ts';
import '../gn-right-panel.ts';
import { repositoryStore } from '../../../stores/index.ts';
import {
  settingsStore,
  MIN_COMMIT_PANEL_HEIGHT,
  MAX_COMMIT_PANEL_HEIGHT,
} from '../../../stores/settings.store.ts';
import type { Repository } from '../../../types/git.types.ts';

function mockRepo(path: string): Repository {
  return {
    path,
    name: 'test-repo',
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

/** Mount the panel with a known viewport height, so the drag bounds are stable. */
async function mountPanel(): Promise<GnRightPanel> {
  return fixture<GnRightPanel>(html`<gn-right-panel style="height: 800px"></gn-right-panel>`);
}

function handle(el: GnRightPanel): HTMLElement {
  const element = el.shadowRoot!.querySelector<HTMLElement>('.resize-handle-v');
  expect(element, 'the divider is rendered').to.not.be.null;
  return element!;
}

function container(el: GnRightPanel): HTMLElement {
  const element = el.shadowRoot!.querySelector<HTMLElement>('.commit-panel-container');
  expect(element, 'the commit panel container is rendered').to.not.be.null;
  return element!;
}

/** Drag the divider from one clientY to another, in one motion. */
function drag(el: GnRightPanel, fromY: number, toY: number): void {
  const divider = handle(el);
  divider.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: fromY })
  );
  document.dispatchEvent(new MouseEvent('mousemove', { clientY: toY }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientY: toY }));
}

function pressKey(el: GnRightPanel, key: string, init: KeyboardEventInit = {}): void {
  handle(el).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  );
}

function heightOf(el: GnRightPanel): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (el as any).commitPanelHeight as number;
}

describe('gn-right-panel commit panel divider', () => {
  beforeEach(() => {
    repositoryStore.getState().reset();
    settingsStore.getState().resetToDefaults();
    repositoryStore.getState().addRepository(mockRepo('/test/repo'));
  });

  it('renders a separator exposing its bounds to assistive tech', async () => {
    const el = await mountPanel();
    const divider = handle(el);

    expect(divider.getAttribute('role')).to.equal('separator');
    expect(divider.getAttribute('aria-orientation')).to.equal('horizontal');
    expect(divider.getAttribute('tabindex')).to.equal('0');
    expect(divider.getAttribute('aria-valuemin')).to.equal(String(MIN_COMMIT_PANEL_HEIGHT));
    expect(divider.getAttribute('aria-valuemax')).to.equal(String(MAX_COMMIT_PANEL_HEIGHT));
    expect(divider.getAttribute('aria-valuenow')).to.equal(
      String(settingsStore.getState().commitPanelHeight)
    );
  });

  it('starts at the persisted height', async () => {
    settingsStore.getState().setCommitPanelHeight(400);
    const el = await mountPanel();

    expect(heightOf(el)).to.equal(400);
    expect(container(el).style.height).to.equal('400px');
  });

  it('grows the commit panel when the divider is dragged up', async () => {
    const el = await mountPanel();
    expect(heightOf(el)).to.equal(320);

    drag(el, 500, 420);
    await el.updateComplete;

    expect(heightOf(el), 'dragging up 80px adds 80px').to.equal(400);
    expect(container(el).style.height).to.equal('400px');
    // Persisted for the next session.
    expect(settingsStore.getState().commitPanelHeight).to.equal(400);
  });

  it('shrinks the commit panel when the divider is dragged down', async () => {
    const el = await mountPanel();

    drag(el, 400, 480);
    await el.updateComplete;

    expect(heightOf(el), 'dragging down 80px removes 80px').to.equal(240);
    expect(settingsStore.getState().commitPanelHeight).to.equal(240);
  });

  it('clamps to the minimum so the commit panel cannot collapse', async () => {
    const el = await mountPanel();

    drag(el, 100, 900);
    await el.updateComplete;

    expect(heightOf(el)).to.equal(MIN_COMMIT_PANEL_HEIGHT);
    expect(settingsStore.getState().commitPanelHeight).to.equal(MIN_COMMIT_PANEL_HEIGHT);
  });

  it('clamps to the stored maximum so the file list stays usable', async () => {
    const el = await mountPanel();

    drag(el, 700, 0);
    await el.updateComplete;

    expect(heightOf(el)).to.equal(MAX_COMMIT_PANEL_HEIGHT);
    expect(settingsStore.getState().commitPanelHeight).to.equal(MAX_COMMIT_PANEL_HEIGHT);
  });

  it('flushes the last coalesced move on mouseup', async () => {
    const el = await mountPanel();

    // A mousemove followed immediately by mouseup in the same frame must not
    // drop the move: the panel has to land where the pointer was released.
    drag(el, 500, 380);
    await el.updateComplete;

    expect(heightOf(el)).to.equal(440);
  });

  it('supports keyboard resizing with arrows and Home/End', async () => {
    const el = await mountPanel();

    pressKey(el, 'ArrowUp');
    await el.updateComplete;
    expect(heightOf(el), 'arrow up grows the panel').to.equal(330);

    pressKey(el, 'ArrowDown');
    await el.updateComplete;
    expect(heightOf(el), 'arrow down shrinks the panel').to.equal(320);

    pressKey(el, 'ArrowUp', { shiftKey: true });
    await el.updateComplete;
    expect(heightOf(el), 'shift+arrow moves further').to.equal(360);

    pressKey(el, 'Home');
    await el.updateComplete;
    expect(heightOf(el)).to.equal(MIN_COMMIT_PANEL_HEIGHT);

    pressKey(el, 'End');
    await el.updateComplete;
    expect(heightOf(el)).to.equal(MAX_COMMIT_PANEL_HEIGHT);
    expect(settingsStore.getState().commitPanelHeight).to.equal(MAX_COMMIT_PANEL_HEIGHT);
  });

  it('stops tracking the pointer after mouseup', async () => {
    const el = await mountPanel();
    drag(el, 500, 400);
    await el.updateComplete;
    const settled = heightOf(el);

    // A stray move after release must not resize the panel.
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 0 }));
    await el.updateComplete;

    expect(heightOf(el)).to.equal(settled);
  });

  it('keeps navigation keys local to the divider while it has focus', async () => {
    const el = await mountPanel();
    let reachedHost = false;
    const onKeyDown = (): void => {
      reachedHost = true;
    };
    el.addEventListener('keydown', onKeyDown);

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    });
    handle(el).dispatchEvent(event);
    el.removeEventListener('keydown', onKeyDown);

    // ArrowUp is also the global "previous commit" shortcut; if it bubble
    // through, selecting a commit switches this panel to Details and hides the
    // pane the user is resizing.
    expect(reachedHost, 'the global shortcut must not also fire').to.be.false;
    expect(event.defaultPrevented, 'the browser default is cancelled').to.be.true;
  });

  it('leaves no document listeners behind when disconnected mid-drag', async () => {
    const el = await mountPanel();
    const divider = handle(el);
    divider.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientY: 500 })
    );

    el.remove();

    // The listener was removed, so a move now must not throw or touch the store.
    const before = settingsStore.getState().commitPanelHeight;
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 100 }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientY: 100 }));

    expect(settingsStore.getState().commitPanelHeight).to.equal(before);
  });
});
