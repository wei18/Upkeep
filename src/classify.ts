// src/classify.ts
import { basename, extname } from 'node:path';
import type { Modality, Category } from './types.js';

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic', '.ico', '.icns']);
const VECTOR = new Set(['.svg', '.mmd', '.dot', '.puml', '.plantuml']);
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.swift', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.c', '.h', '.cpp', '.m', '.sh']);
const DOC = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);
const CONFIG = new Set(['.yml', '.yaml', '.json', '.toml', '.plist', '.xml']);

function hasNul(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function classify(path: string, content: Buffer): { modality: Modality; category: Category } {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  const lower = path.toLowerCase();

  // modality
  let modality: Modality;
  if (RASTER.has(ext)) modality = 'raster_image';
  else if (VECTOR.has(ext)) modality = 'vector_diagram';
  else if (hasNul(content)) modality = 'binary';
  else modality = 'text';

  // category
  const segs = lower.split('/');
  const isSpecPath = segs.some((s) => s === 'spec' || s === 'specs');
  let category: Category;
  if (name.includes('icon') || ext === '.icns' || ext === '.ico') category = 'icon';
  else if (modality === 'raster_image') category = 'visual';
  else if (isSpecPath) category = 'spec'; // 路徑含 spec/specs 區段；避免 *.spec.ts 誤判
  else if (modality === 'vector_diagram' || /(?:^|[-_])flow(?:[-_.]|$)/.test(name)) category = 'flow';
  else if (CODE.has(ext)) category = 'code';
  else if (DOC.has(ext)) category = 'doc';
  else if (CONFIG.has(ext)) category = 'config';
  else category = 'other';

  return { modality, category };
}
