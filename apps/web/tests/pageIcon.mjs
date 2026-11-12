// Which page icons the list draws (src/services/pageIcon.ts): only what the envelope's
// `icon` may hold, a PNG of at most 64 by 64 in base64, read from its header, so that every
// client passes over the same wrong ones. Run by `npm run test:keys`, in plain Node.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { iconOf } from '../src/services/pageIcon.ts';

/** The first 33 bytes of a PNG of `width` by `height`: its signature and its IHDR. */
const pngHeader = (width, height) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
};

describe('iconOf', () => {
  test('takes a PNG within 64 by 64', () => {
    for (const [w, h] of [
      [64, 64],
      [1, 1],
      [64, 32],
      [16, 16],
    ]) {
      assert.equal(iconOf(pngHeader(w, h)), pngHeader(w, h));
    }
  });

  test('passes over a PNG larger than 64 a side, or with no pixels', () => {
    for (const [w, h] of [
      [65, 64],
      [64, 65],
      [4096, 4096],
      [0, 16],
    ]) {
      assert.equal(iconOf(pngHeader(w, h)), undefined);
    }
  });

  test('passes over what is not a PNG', () => {
    const gif = Buffer.from('GIF89a' + '\0'.repeat(27), 'binary').toString('base64');
    assert.equal(iconOf(gif), undefined);
    assert.equal(iconOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')), undefined);
  });

  test('passes over a string that is not base64, or is too long, before reading it', () => {
    assert.equal(iconOf(undefined), undefined);
    assert.equal(iconOf(''), undefined);
    assert.equal(iconOf(`${pngHeader(16, 16)}"onerror="x`), undefined);
    assert.equal(iconOf(pngHeader(16, 16).slice(0, -1)), undefined);
    assert.equal(iconOf(pngHeader(16, 16) + 'A'.repeat(5464)), undefined);
  });

  test('takes 4096 bytes and not one more', () => {
    const icon = (bytes) => {
      const png = Buffer.alloc(bytes);
      Buffer.from(pngHeader(16, 16), 'base64').copy(png);
      return png.toString('base64');
    };
    assert.equal(iconOf(icon(4096)), icon(4096));
    assert.equal(iconOf(icon(4097)), undefined);
    assert.equal(iconOf(icon(4098)), undefined);
  });
});
