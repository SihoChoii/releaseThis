import { expect, test } from 'bun:test';
import { add } from './library.js';

test('adds positive and negative numbers', () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-2, 3)).toBe(1);
});
