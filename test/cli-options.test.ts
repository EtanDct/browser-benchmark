import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { swallowedByNpm } from '../src/cli-options.js';

describe('options npm kept for itself', () => {
  it('finds them in npm_config_*, negated flags included', () => {
    // What npm exports for `npm run bench --resume --modes=full,lite --no-history` (the "--" lost).
    const env = { npm_config_resume: 'true', npm_config_modes: 'full,lite', npm_config_history: '', npm_config_noproxy: '' };
    assert.deepEqual(swallowedByNpm(env), ['--modes', '--no-history', '--resume']);
  });

  it('finds nothing when every option reached the script', () => {
    assert.deepEqual(swallowedByNpm({ npm_config_cache: '/tmp/npm', npm_config_noproxy: '' }), []);
  });
});
