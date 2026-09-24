import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { screenshotSimilarity } from '../src/aggregate/visual.js';

function solid(width: number, height: number, gray: number): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([gray, gray, gray, 255], i);
  return png;
}

describe('screenshotSimilarity', () => {
  it('is 1 for identical captures and 0 for opposite ones', () => {
    assert.equal(screenshotSimilarity(solid(4, 4, 255), solid(4, 4, 255)), 1);
    assert.equal(screenshotSimilarity(solid(4, 4, 255), solid(4, 4, 0)), 0);
  });

  it('counts the area missing from a smaller capture as mismatched', () => {
    assert.equal(screenshotSimilarity(solid(4, 4, 255), solid(4, 2, 255)), 0.5);
  });
});
