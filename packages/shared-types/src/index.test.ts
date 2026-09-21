import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@jambu/shared-types', () => {
  it('is wired into the test runner', () => {
    expect(PACKAGE_NAME).toBe('@jambu/shared-types');
  });
});
