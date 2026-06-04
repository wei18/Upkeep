// test/hash.test.ts
import { describe, it, expect } from 'vitest';
import { sha256 } from '../src/hash.js';

describe('hash', () => {
  it('stable hex digest', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('same content same hash (duplicate detection basis)', () => {
    expect(sha256(Buffer.from('dup'))).toBe(sha256(Buffer.from('dup')));
  });
});
