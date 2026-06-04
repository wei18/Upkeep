// src/hash.ts
import { createHash } from 'node:crypto';

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
