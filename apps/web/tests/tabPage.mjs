// What a Chrome tab gives a push from the extension (src/services/tabPage.ts): which pages
// can be pushed, and when the tab's title is only its URL, which is pushed as no title so a
// phone may still find one. Run by `npm run test:keys`, in plain Node.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isWebPage, titleOfTab } from '../src/services/tabPage.ts';

describe('isWebPage', () => {
  test('takes http and https', () => {
    assert.equal(isWebPage('https://example.com/a'), true);
    assert.equal(isWebPage('http://example.com/'), true);
  });

  test('refuses what no other device can open', () => {
    for (const url of [
      'chrome://extensions/',
      'chrome-extension://abc/index.html',
      'file:///Users/someone/notes.txt',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,hi',
    ]) {
      assert.equal(isWebPage(url), false, url);
    }
  });

  test('refuses nothing and what is not a URL', () => {
    assert.equal(isWebPage(undefined), false);
    assert.equal(isWebPage(''), false);
    assert.equal(isWebPage('example.com'), false);
  });
});

describe('titleOfTab', () => {
  test('keeps a real title, trimmed', () => {
    assert.equal(titleOfTab('  An example page ', 'https://example.com/a'), 'An example page');
  });

  test('drops a title that is the URL', () => {
    assert.equal(titleOfTab('https://example.com/a', 'https://example.com/a'), '');
    assert.equal(titleOfTab('example.com/a', 'http://example.com/a'), '');
  });

  test('gives no title for none', () => {
    assert.equal(titleOfTab(undefined, 'https://example.com/a'), '');
    assert.equal(titleOfTab('   ', 'https://example.com/a'), '');
  });
});
