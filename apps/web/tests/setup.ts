/**
 * Vitest setup. Runs once before the suite.
 *
 * We deliberately do NOT clear sessionStorage between tests inside a
 * single file, because tests that explicitly cover persistence need
 * state continuity. Tests that need a clean slate should call
 * `sessionStorage.clear()` themselves in `beforeEach`.
 *
 * React Testing Library auto-cleanup is registered here so each test
 * starts with a clean DOM.
 */
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});
