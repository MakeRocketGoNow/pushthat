// Which pushed files are shown as images (src/services/viewable.ts): the check that keeps an
// SVG or HTML file out of an object URL in the app's origin, where a script in it would run
// as the signed-in app. Run by `npm run test:keys`, in plain Node, with no emulator.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { viewableType } from '../src/services/viewable.ts';

const file = (mime, ext) => ({ objectPath: 'uploads/someone/x', envelope: { name: `x.${ext}`, mime, size: 0, ext } });

describe('viewableType', () => {
  test('shows the raster types a browser draws, by their MIME type', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      assert.equal(viewableType(file(mime, 'bin')), mime);
    }
  });

  test('reads the MIME type and extension in any case, and answers in lower case', () => {
    assert.equal(viewableType(file('IMAGE/PNG', 'png')), 'image/png');
    assert.equal(viewableType(file('', 'JPG')), 'image/jpeg');
  });

  test('goes by the extension when the type is empty, as for a push migrated from before encryption', () => {
    assert.equal(viewableType(file('', 'jpeg')), 'image/jpeg');
    assert.equal(viewableType(file('', 'webp')), 'image/webp');
  });

  test('goes by the extension when the type is application/octet-stream, which says nothing', () => {
    assert.equal(viewableType(file('application/octet-stream', 'png')), 'image/png');
  });

  test('never shows SVG or HTML, whatever the type or extension says', () => {
    assert.equal(viewableType(file('image/svg+xml', 'svg')), undefined);
    assert.equal(viewableType(file('image/svg+xml', 'png')), undefined);
    assert.equal(viewableType(file('text/html', 'jpg')), undefined);
    assert.equal(viewableType(file('', 'svg')), undefined);
    assert.equal(viewableType(file('', 'html')), undefined);
    assert.equal(viewableType(file('application/octet-stream', 'svg')), undefined);
    assert.equal(viewableType(file('application/octet-stream', 'html')), undefined);
  });

  test('a named type that is not an image is saved, even with an image extension', () => {
    assert.equal(viewableType(file('application/pdf', 'jpg')), undefined);
  });

  test('saves types a browser cannot draw everywhere, and files with no extension', () => {
    assert.equal(viewableType(file('image/heic', 'heic')), undefined);
    assert.equal(viewableType(file('image/tiff', 'tiff')), undefined);
    assert.equal(viewableType(file('', '')), undefined);
  });
});
