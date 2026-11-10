// Which files make up each category, and what a push writes.

import { CATEGORIES, CATEGORY_IDS, type CategoryId } from '../shared/types';
import { fileState, type FileState } from './diff';
import { isNeverCopied, matchPattern, readIfExists, safeJoin } from './files';

/**
 * Pairs of files that hold the same data in remote/ and local/cfg/.
 * If the source has only one of them, it's written to both on the target.
 */
const PAIRS: Partial<Record<CategoryId, Array<[string, string]>>> = {
  hotkeys: [['remote/user_keys.vcfg', 'local/cfg/user_keys_0_slot0.vcfg']],
  convars: [['remote/user_convars.vcfg', 'local/cfg/user_convars_0_slot0.vcfg']],
};

export function isCategoryId(x: unknown): x is CategoryId {
  return typeof x === 'string' && (CATEGORY_IDS as readonly string[]).includes(x);
}

export function patternsOf(cat: CategoryId): string[] {
  return CATEGORIES.find((c) => c.id === cat)!.patterns;
}

/** Every existing file of a category in one account's 570 folder. */
export async function listCategoryFiles(root: string, cat: CategoryId): Promise<string[]> {
  const found = new Set<string>();
  for (const p of patternsOf(cat)) for (const f of await matchPattern(root, p)) found.add(f);
  return [...found].filter((f) => !isNeverCopied(f)).sort();
}

export async function readCategory(root: string, cat: CategoryId): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of await listCategoryFiles(root, cat)) {
    const buf = await readIfExists(safeJoin(root, f));
    if (buf) out.set(f, buf);
  }
  return out;
}

export async function readCategoryState(root: string, cat: CategoryId): Promise<Record<string, FileState>> {
  const out: Record<string, FileState> = {};
  for (const [f, buf] of await readCategory(root, cat)) out[f] = fileState(f, buf);
  return out;
}

/**
 * Convars that hold per-account state rather than settings (the in-game name,
 * counters, "seen"/"acknowledged" markers, timestamps). A push keeps the
 * target's own values for these.
 */
const ACCOUNT_BOUND_CONVARS = [
  /^name$/,
  /^dota_conduct_scorecard_/,
  /(^|_)seen(_|$)/,
  /^dota_last_/,
  /_acknowledged_id$/,
  /_launch_count$/,
  /_matches_played$/,
  /_splash_time$/,
  /^dota_client_first_session$/,
  /^dota_active_play_section/,
  /_onboarding_state$/,
];

export function isAccountBoundConvar(name: string): boolean {
  return ACCOUNT_BOUND_CONVARS.some((re) => re.test(name));
}

const isConvarFile = (rel: string) => /convars[^/]*\.vcfg$/i.test(rel);
const LINE_RE = /^(\s*)"([^"]+)"(\s+)"([^"]*)"\s*$/;

/**
 * Rewrite a source convars file so account-bound convars carry the target's
 * values (or are absent, if the target doesn't have them). Every other line
 * is left byte for byte as it is in the source.
 */
export function keepAccountConvars(sourceBuf: Buffer, targetBuf: Buffer | null): Buffer {
  const targetVals = new Map<string, string>();
  if (targetBuf) {
    for (const line of targetBuf.toString('utf8').split(/\r?\n/)) {
      const m = LINE_RE.exec(line);
      if (m && isAccountBoundConvar(m[2]) && !targetVals.has(m[2])) targetVals.set(m[2], m[4]);
    }
  }
  const text = sourceBuf.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const used = new Set<string>();
  let lastKeyLine = -1;
  let indent = '\t\t';
  let gap = '\t\t';
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) {
      indent = m[1];
      gap = m[3];
      if (isAccountBoundConvar(m[2])) {
        if (!targetVals.has(m[2])) continue; // target never had it: don't add the source's
        out.push(`${m[1]}"${m[2]}"${m[3]}"${targetVals.get(m[2])}"`);
        used.add(m[2]);
      } else out.push(line);
      lastKeyLine = out.length - 1;
    } else out.push(line);
  }
  const missing = [...targetVals].filter(([k]) => !used.has(k));
  if (missing.length && lastKeyLine >= 0) {
    out.splice(lastKeyLine + 1, 0, ...missing.map(([k, v]) => `${indent}"${k}"${gap}"${v}"`));
  }
  const result = Buffer.from(out.join(eol), 'utf8');
  return result.equals(sourceBuf) ? sourceBuf : result;
}

/**
 * The exact files (relative path -> bytes) a push of this category writes to a target.
 * With a target, convars files keep the target's account-bound values.
 */
export async function planCopy(sourceRoot: string, cat: CategoryId, targetRoot?: string): Promise<Map<string, Buffer>> {
  const plan = await readCategory(sourceRoot, cat);
  for (const [a, b] of PAIRS[cat] ?? []) {
    if (plan.has(a) && !plan.has(b)) plan.set(b, plan.get(a)!);
    else if (plan.has(b) && !plan.has(a)) plan.set(a, plan.get(b)!);
  }
  if (targetRoot) {
    const partner = (f: string) => (PAIRS[cat] ?? []).flatMap(([a, b]) => (a === f ? [b] : b === f ? [a] : []))[0];
    for (const [f, buf] of plan) {
      if (!isConvarFile(f)) continue;
      // The target's own values come from the same file, or from its pair copy if that's all it has.
      let own = await readIfExists(safeJoin(targetRoot, f));
      const p = partner(f);
      if (!own && p) own = await readIfExists(safeJoin(targetRoot, p));
      plan.set(f, keepAccountConvars(buf, own));
    }
  }
  return plan;
}
