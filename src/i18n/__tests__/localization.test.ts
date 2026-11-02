/**
 * Localization runtime.
 *
 * The language setting hands arbitrary strings to this module — a locale that
 * was persisted before it was dropped, a system language we do not ship — so
 * everything here has to resolve to something renderable rather than throw.
 */

import { expect, waitUntil } from '@open-wc/testing';
import { msg, str } from '@lit/localize';
import {
  getAppLocale,
  isSupportedLocale,
  resolveLocale,
  setAppLocale,
  supportedLocales,
} from '../index.ts';

describe('i18n runtime', () => {
  afterEach(async () => {
    await setAppLocale('en');
  });

  it('ships English as the source locale, with French and Chinese alongside it', () => {
    expect(supportedLocales.map((l) => l.code)).to.deep.equal(['en', 'fr', 'zh']);
    // Endonyms: the picker stays readable whatever the active locale is.
    expect(supportedLocales.map((l) => l.name)).to.deep.equal(['English', 'Français', '中文']);
  });

  it('recognises only the locales it ships', () => {
    expect(isSupportedLocale('fr')).to.be.true;
    expect(isSupportedLocale('zh')).to.be.true;
    expect(isSupportedLocale('de')).to.be.false;
  });

  it('resolves a regional tag to the base locale it ships', () => {
    expect(resolveLocale('fr-CA')).to.equal('fr');
    expect(resolveLocale('en-GB')).to.equal('en');
    // Chinese ships as one translation: every regional/spelling tag lands on it.
    expect(resolveLocale('zh-CN')).to.equal('zh');
    expect(resolveLocale('zh-TW')).to.equal('zh');
    expect(resolveLocale('zh-Hans')).to.equal('zh');
  });

  it('resolves an unknown or empty locale to English', () => {
    expect(resolveLocale('xx-YY')).to.equal('en');
    expect(resolveLocale('')).to.equal('en');
    expect(resolveLocale(null)).to.equal('en');
  });

  it('renders source strings under the source locale', () => {
    expect(getAppLocale()).to.equal('en');
    expect(msg('Open')).to.equal('Open');
  });

  it('translates msg() after switching to a shipped locale', async () => {
    const applied = await setAppLocale('fr');
    expect(applied).to.equal('fr');
    expect(getAppLocale()).to.equal('fr');
    await waitUntil(() => msg('Open') === 'Ouvrir', 'French templates became active');
    expect(msg('A powerful, open-source Git client')).to.equal(
      'Un client Git puissant et open source'
    );
  });

  it('loads a locale asynchronously, so the first paint is in the source locale', async () => {
    // What src/index.ts documents: applyPersistedLocale() is deliberately not
    // awaited before the app shell is imported, because a locale's templates
    // arrive through a dynamic import(). Nothing is translated until that
    // promise settles, and the @localized() surfaces re-render when it does.
    const pending = setAppLocale('fr');
    expect(msg('Open'), 'nothing is translated synchronously').to.equal('Open');
    expect(getAppLocale(), 'and the active locale has not moved yet').to.equal('en');

    await pending;
    await waitUntil(() => msg('Open') === 'Ouvrir', 'French templates became active');
  });

  it('falls back to English for an unsupported locale instead of throwing', async () => {
    const applied = await setAppLocale('xx');
    expect(applied).to.equal('en');
    expect(getAppLocale()).to.equal('en');
    expect(msg('Open')).to.equal('Open');
  });

  it('takes a regional tag straight to the locale it ships', async () => {
    const applied = await setAppLocale('fr-CA');
    expect(applied).to.equal('fr');
    expect(msg('Clone')).to.equal('Cloner');

    // Chinese is shipped as one translation, so every zh-* tag lands on it.
    const chinese = await setAppLocale('zh-TW');
    expect(chinese).to.equal('zh');
    await waitUntil(() => msg('Open') === '打开', 'Chinese templates became active');
    expect(msg('Clone')).to.equal('克隆');
  });

  /**
   * Every string on the localised surfaces has to have a translation in EVERY
   * locale we ship, or that UI silently mixes English into it. A message whose
   * source text is not in the bundle falls back to the source, so "still
   * English under fr/zh" is exactly the failure this catches.
   *
   * This used to iterate a hand-written list of ~20 source strings, which meant
   * any string it did not happen to name could lose its translation and still
   * pass. It now enumerates each locale's XLIFF and drives every unit through
   * the real `msg()` runtime, so the check grows with the catalogue — and it
   * runs per locale, so adding a language cannot ship half-checked.
   *
   * The other half of the contract — that the XLIFF's ids are exactly the ids
   * the `msg()` call sites in `src/**` hash to — cannot be checked from a
   * browser, which has no view of the source tree. `scripts/i18n-coverage.test.mjs`
   * derives and asserts that, and `npm test` runs it alongside these tests.
   */
  describe('every shipped catalogue resolves through the runtime', () => {
    /** One translation unit, with template expressions split out. */
    interface Unit {
      id: string;
      /** Literal chunks of the source, one more than there are expressions. */
      strings: string[];
      /** Literal chunks of the target. */
      targetStrings: string[];
      /** For each gap in the target, which source expression fills it. */
      targetOrder: number[];
      /** True when the trans-unit carries no `<target>` at all. */
      missingTarget: boolean;
      /**
       * True when a single `<x>` tag stands for MORE than one template
       * expression (lit-localize folds adjacent `${a} ${b}` into one tag and
       * keeps both expressions in its `equiv-text`). The chunks below then
       * describe the rendered gap, not the source code's template-strings
       * array, so the message id cannot be reconstructed from them and the
       * runtime check skips the unit — the translation-coverage contract still
       * fails on it if it is untranslated.
       */
      multiExpression: boolean;
      /**
       * True for an `msg(html`…`)` unit. lit-localize folds the HTML tags around
       * an expression into the placeholder's `equiv-text`, so the XLIFF no
       * longer carries the literal chunks the id was hashed from — the same
       * reason `multiExpression` units are skipped below.
       */
      isHtml: boolean;
    }

    /**
     * `<source>Opened workspace: <x id="0"/></source>` becomes the template
     * strings `["Opened workspace: ", ""]` — the same shape `str` produces, and
     * the shape the message id is hashed from.
     */
    function split(element: Element | null): { strings: string[]; order: number[] } {
      const strings: string[] = [''];
      const order: number[] = [];
      if (element === null) return { strings, order };
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          strings[strings.length - 1] += node.textContent ?? '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          order.push(Number((node as Element).getAttribute('id')));
          strings.push('');
        }
      }
      return { strings, order };
    }

    /**
     * The translation each bundle must produce for `Open`, used as the sentinel
     * that its templates are really active. Not a second translation suite — a
     * known-good string per locale so `beforeEach` can wait on something.
     */
    const OPEN: Record<string, string> = { fr: 'Ouvrir', zh: '打开' };

    const catalogues = new Map<string, Unit[]>();
    const targetLocales = supportedLocales.filter((locale) => locale.code !== 'en');

    before(async () => {
      for (const locale of targetLocales) {
        const response = await fetch(`/src/i18n/xliff/${locale.code}.xlf`);
        expect(response.ok, `the ${locale.code} XLIFF is readable`).to.be.true;
        const xliff = new DOMParser().parseFromString(await response.text(), 'application/xml');
        expect(
          xliff.querySelector('parsererror'),
          `the ${locale.code} XLIFF is well-formed XML`
        ).to.not.exist;

        catalogues.set(
          locale.code,
          Array.from(xliff.querySelectorAll('trans-unit')).map((unit) => {
            const source = split(unit.querySelector('source'));
            const targetElement = unit.querySelector('target');
            const target = split(targetElement);
            // A tag whose equiv-text holds 2+ `${…}` stands for several source
            // expressions; those units cannot be driven through `msg()` (see the
            // `multiExpression` note on Unit).
            const multiExpression = Array.from(
              unit.querySelectorAll('source > x')
            ).some(
              (tag) => ((tag.getAttribute('equiv-text') ?? '').match(/\$\{/g)?.length ?? 0) > 1
            );
            return {
              id: unit.getAttribute('id') ?? '',
              strings: source.strings,
              targetStrings: target.strings,
              targetOrder: target.order,
              missingTarget: targetElement === null,
              multiExpression,
              isHtml: (unit.getAttribute('id') ?? '').startsWith('h'),
            };
          })
        );
      }
    });

    for (const locale of targetLocales) {
      const code = locale.code;

      describe(`the ${code} catalogue`, () => {
        beforeEach(async () => {
          await setAppLocale(code);
          await waitUntil(
            () => msg('Open') === OPEN[code],
            `${code} templates became active`
          );
        });

        it('has a catalogue to check, and every unit carries a target', () => {
          const units = catalogues.get(code) ?? [];
          expect(units.length, `trans-units in src/i18n/xliff/${code}.xlf`).to.be.greaterThan(100);
          expect(units.every((unit) => unit.id !== '')).to.be.true;
          expect(
            units.filter((unit) => unit.missingTarget).map((unit) => unit.id),
            `trans-unit(s) in src/i18n/xliff/${code}.xlf have no <target> — they render English`
          ).to.deep.equal([]);
        });

        it('renders every translated unit', () => {
          const untranslated: string[] = [];

          // Units whose adjacent template expressions were folded into one
          // `<x>` tag, and `msg(html`…`)` units whose markup was folded into a
          // placeholder's equiv-text, cannot be reproduced through `msg()` —
          // the id hashes the code's template-strings array, which the XLIFF no
          // longer carries. Their translation is still enforced by the "every
          // unit carries a target" assertion above and by the coverage contract
          // in scripts/i18n-coverage.test.mjs.
          const renderable = (catalogues.get(code) ?? []).filter(
            (unit) => !unit.multiExpression && !unit.isHtml
          );

          for (const unit of renderable) {
            // One distinct marker per expression, so a value that lands in the
            // wrong gap after translation reorders them is visible in the diff.
            const values = unit.strings.slice(1).map((_, i) => `\u27e6${i}\u27e7`);
            const rendered =
              unit.strings.length === 1
                ? msg(unit.strings[0])
                : msg(str(unit.strings as unknown as TemplateStringsArray, ...values));
            const expected = unit.targetStrings.reduce(
              (acc, chunk, i) => (i === 0 ? chunk : acc + values[unit.targetOrder[i - 1]] + chunk),
              ''
            );
            if (rendered !== expected) {
              untranslated.push(
                `${unit.id}: got ${JSON.stringify(rendered)}, want ${JSON.stringify(expected)}`
              );
            }
          }

          expect(
            untranslated,
            `${untranslated.length} unit(s) in src/i18n/xliff/${code}.xlf do not render their ` +
              `translated target — the generated bundle src/i18n/generated/locales/${code}.ts ` +
              `is out of step with the XLIFF:\n` +
              untranslated.join('\n')
          ).to.deep.equal([]);
        });
      });
    }

    it('still substitutes values into a translated message', async () => {
      const label = 'X';

      await setAppLocale('fr');
      await waitUntil(() => msg('Open') === 'Ouvrir', 'French templates became active');
      expect(msg(str`${label} copied to clipboard`)).to.equal('X copié dans le presse-papiers');

      await setAppLocale('zh');
      await waitUntil(() => msg('Open') === '打开', 'Chinese templates became active');
      const chinese = msg(str`${label} copied to clipboard`);
      expect(chinese, 'the value is still substituted').to.contain('X');
      expect(chinese, 'and the sentence around it is translated').to.not.equal(
        'X copied to clipboard'
      );
    });
  });
});
