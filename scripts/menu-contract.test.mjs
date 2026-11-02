/**
 * Application menu contract test.
 *
 * The native menu bar is built in Rust (`src-tauri/src/menu.rs`) and every item
 * it emits is routed to an action by a table in TypeScript
 * (`src/services/app-menu.service.ts`). Neither side can see the other, so a
 * menu item added, renamed or dropped on one side only compiles, type-checks
 * and ships — and shows up as a menu entry that does nothing, or an action no
 * menu can reach.
 *
 * This test compares the two tables directly:
 *   - the same ids, in the same order
 *   - the same repository-scoped flags, so an item that needs a repository is
 *     greyed out by both halves
 *   - a localised label for every row, whose English source equals the label
 *     the native table builds — that table is what a locale does NOT translate,
 *     so a re-worded native label would silently leave the menu half-English
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const RUST_MENU = 'src-tauri/src/menu.rs';
const TS_MENU = 'src/services/app-menu.service.ts';

/** Sections and items declared by the Rust menu table, in display order. */
function parseRustMenu(source) {
  const table = source.slice(
    source.indexOf('pub const APP_MENU'),
    source.indexOf('/// Every clickable item')
  );
  assert.ok(table.length > 0, `${RUST_MENU}: APP_MENU table not found`);

  const sections = [];
  for (const match of table.matchAll(/MenuSection \{\s*id: "([^"]+)",\s*label: "([^"]+)"/g)) {
    sections.push({ id: match[1], label: match[2] });
  }

  const items = [];
  const pattern = /\b(repo_item|item)\("([^"]+)",\s*"([^"]+)"\)/g;
  let match;
  while ((match = pattern.exec(table)) !== null) {
    items.push({ id: match[2], label: match[3], repositoryScoped: match[1] === 'repo_item' });
  }
  return { sections, items };
}

/** Items declared by the frontend action table, in display order. */
function parseTsMenu(source) {
  const start = source.indexOf('export const APP_MENU_ACTIONS');
  assert.notEqual(start, -1, `${TS_MENU}: APP_MENU_ACTIONS table not found`);
  const table = source.slice(start, source.indexOf('\n];', start));

  const items = [];
  for (const entry of table.match(/\{[^{}]*\}/g) ?? []) {
    const id = entry.match(/id:\s*'([^']+)'/);
    const scoped = entry.match(/repositoryScoped:\s*(true|false)/);
    assert.ok(id, `${TS_MENU}: menu entry without an id: ${entry}`);
    assert.ok(scoped, `${TS_MENU}: menu entry "${id[1]}" without repositoryScoped`);
    items.push({ id: id[1], repositoryScoped: scoped[1] === 'true' });
  }
  return items;
}

/** The localised label table: `['id', msg('English source')]` pairs, in order. */
function parseTsLabels(source) {
  const start = source.indexOf('export function localizedMenuLabels');
  assert.notEqual(start, -1, `${TS_MENU}: localizedMenuLabels() not found`);
  const end = source.indexOf('] satisfies', start);
  assert.notEqual(end, -1, `${TS_MENU}: localizedMenuLabels() has no satisfies clause`);
  const body = source.slice(start, end);

  const pairs = [];
  for (const match of body.matchAll(/\['([^']+)',\s*msg\('([^']*)'\)\]/g)) {
    pairs.push({ id: match[1], label: match[2] });
  }
  assert.ok(pairs.length > 20, `${TS_MENU}: only ${pairs.length} labels parsed`);
  return pairs;
}

const { sections: rustSections, items: rustItems } = parseRustMenu(
  readFileSync(RUST_MENU, 'utf8')
);
const tsMenuSource = readFileSync(TS_MENU, 'utf8');
const tsItems = parseTsMenu(tsMenuSource);
const tsLabels = parseTsLabels(tsMenuSource);

test('both tables declare at least the documented menu items', () => {
  assert.ok(rustItems.length >= 20, `only ${rustItems.length} items parsed from ${RUST_MENU}`);
  assert.ok(tsItems.length >= 20, `only ${tsItems.length} items parsed from ${TS_MENU}`);
});

test('neither table repeats an id', () => {
  for (const [file, items] of [
    [RUST_MENU, rustItems],
    [TS_MENU, tsItems],
  ]) {
    const ids = items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `${file} has duplicate menu ids`);
  }
});

test('every native menu item has a frontend action, and vice versa', () => {
  const rustIds = rustItems.map((i) => i.id);
  const tsIds = tsItems.map((i) => i.id);

  const missingInTs = rustIds.filter((id) => !tsIds.includes(id));
  const missingInRust = tsIds.filter((id) => !rustIds.includes(id));

  assert.deepEqual(
    missingInTs,
    [],
    `menu items with no frontend action in ${TS_MENU}: ${missingInTs.join(', ')}`
  );
  assert.deepEqual(
    missingInRust,
    [],
    `frontend actions no menu item emits in ${RUST_MENU}: ${missingInRust.join(', ')}`
  );
});

test('the two tables stay in the same order', () => {
  assert.deepEqual(
    tsItems.map((i) => i.id),
    rustItems.map((i) => i.id),
    'reorder the two menu tables together so they stay readable side by side'
  );
});

test('repository-scoped flags agree on both sides', () => {
  const rustScoped = new Map(rustItems.map((i) => [i.id, i.repositoryScoped]));

  for (const item of tsItems) {
    assert.equal(
      item.repositoryScoped,
      rustScoped.get(item.id),
      `"${item.id}" is repository-scoped in one table but not the other; ` +
        'the native item would be clickable with no repository open, or greyed out with one'
    );
  }
});

test('every native menu row has a localised label, and nothing else does', () => {
  // `edit` is the macOS Edit submenu Tauri builds for the clipboard roles; it
  // is not part of APP_MENU but its title is translatable too.
  const rustIds = [...rustSections.map((s) => s.id), ...rustItems.map((i) => i.id), 'edit'];
  const labelIds = tsLabels.map((pair) => pair.id);

  assert.deepEqual(
    labelIds.filter((id) => !rustIds.includes(id)),
    [],
    `${TS_MENU} labels rows the native menu does not build`
  );
  assert.deepEqual(
    rustIds.filter((id) => !labelIds.includes(id)),
    [],
    `native menu rows with no localised label in ${TS_MENU}: ` +
      rustIds.filter((id) => !labelIds.includes(id)).join(', ')
  );
});

test('the localised labels’ English source matches the native labels', () => {
  const expected = new Map([
    ...rustSections.map((s) => [s.id, s.label]),
    ...rustItems.map((i) => [i.id, i.label]),
    ['edit', 'Edit'],
  ]);

  for (const pair of tsLabels) {
    assert.equal(
      pair.label,
      expected.get(pair.id),
      `"${pair.id}" is "${pair.label}" in ${TS_MENU} but "${expected.get(pair.id)}" in ${RUST_MENU}; ` +
        'the source text must match so the translations stay attached to the right row'
    );
  }
});
