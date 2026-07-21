// src/classify.ts
import { basename, extname } from 'node:path';
import type { Modality, Category } from './types.js';

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic', '.ico', '.icns']);
const VECTOR = new Set(['.svg', '.mmd', '.dot', '.puml', '.plantuml']);
const CODE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.swift', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.c', '.h', '.cpp', '.m', '.sh']);
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
  // The icon naming rule only applies to image assets, so text files like visual_icon.md aren't misclassified
  if (ext === '.icns' || ext === '.ico' || ((RASTER.has(ext) || ext === '.svg') && name.includes('icon'))) category = 'icon';
  else if (modality === 'raster_image') category = 'visual';
  else if (isSpecPath) category = 'spec'; // path contains a spec/specs segment; avoids misjudging *.spec.ts
  else if (/(?:^|[-_])flow(?:[-_.]|$)/.test(name)) category = 'flow'; // explicit flow naming (any extension)
  else if (ext === '.svg') category = 'visual'; // generic vector graphics = design assets (design §2 -> visual_icon); .mmd/.dot/.puml are diagram languages instead
  else if (modality === 'vector_diagram') category = 'flow';
  else if (CODE.has(ext)) category = 'code';
  else if (DOC.has(ext)) category = 'doc';
  else if (CONFIG.has(ext)) category = 'config';
  else category = 'other';

  return { modality, category };
}
