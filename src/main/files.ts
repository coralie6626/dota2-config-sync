// File helpers: path checks, pattern matching, atomic writes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Files that are tied to one account and must never be written by the app. */
const NEVER_COPY = [
  /(^|\/)remotecache\.vdf$/i,
  /(^|\/)stats\.dat$/i,
  /(^|\/)last_match\.dat$/i,
  /(^|\/)voice_ban\.dt$/i,
  /(^|\/)favorite_friends\.json$/i,
  /(^|\/)item_clientacks\.txt$/i,
  /(^|\/)guild\//i,
  /(^|\/)replays\//i,
  /\.dem$/i,
  /_lastclouded$/i,
];

export function isNeverCopied(rel: string): boolean {
  return NEVER_COPY.some((re) => re.test(rel));
}

/**
 * Join a relative path onto a root and make sure the result stays inside it.
 * Rejects absolute paths, "..", drive letters and alternate data streams.
 */
export function safeJoin(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || /[:*?"<>|\0]/.test(rel)) throw new Error(`Bad path: ${rel}`);
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new Error(`Bad path: ${rel}`);
  const full = path.resolve(root, ...parts);
  const back = path.relative(path.resolve(root), full);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`Path escapes ${root}: ${rel}`);
  return full;
}

/**
 * Check that a path we're about to write resolves (following junctions and
 * symlinks on the existing part) to somewhere inside the root folder.
 */
export async function assertRealInside(root: string, full: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let probe = path.dirname(full);
  const tail: string[] = [path.basename(full)];
  // Walk up to the deepest existing ancestor.
  for (;;) {
    try {
      const realProbe = await fs.realpath(probe);
      const resolved = path.join(realProbe, ...tail);
      const back = path.relative(realRoot, resolved);
      if (!back || back.startsWith('..') || path.isAbsolute(back)) {
        throw new Error(`Refusing to write outside ${root}: ${full}`);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isFile();
  } catch {
    return false;
  }
}

export async function readIfExists(p: string): Promise<Buffer | null> {
  if (!(await isFile(p))) return null;
  return fs.readFile(p);
}

/** List files under root matching a pattern like "local/cfg/user_keys_0_slot*.vcfg". */
export async function matchPattern(root: string, pattern: string): Promise<string[]> {
  const slash = pattern.lastIndexOf('/');
  const dir = pattern.slice(0, slash);
  const name = pattern.slice(slash + 1);
  if (!name.includes('*')) {
    return (await isFile(safeJoin(root, pattern))) ? [pattern] : [];
  }
  const re = new RegExp(
    '^' + name.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/\\\\]*') + '$',
    'i',
  );
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(safeJoin(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && re.test(e.name))
    .map((e) => `${dir}/${e.name}`)
    .sort();
}

/** Write to a temp file next to the target, then rename it into place. */
export async function atomicWrite(full: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.d2cs-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data, { flag: 'wx' });
    await fs.rename(tmp, full);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
