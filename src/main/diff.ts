// Flattening config files into key -> value maps and comparing them key by key.

import { createHash } from 'node:crypto';
import { parseBinaryKV, parseDotaKV, type KVObject } from './kv';
import { PATH_SEP, type FileDiff, type KeyChange } from '../shared/types';

/** Key path (joined with PATH_SEP) -> value, in file order. */
export type Flat = Record<string, string>;

/** What the app remembers about one file: a hash, plus its keys when it parses. */
export interface FileState {
  hash: string;
  flat: Flat | null;
}

export function hashBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function flattenKV(obj: KVObject, prefix: string[], out: Flat) {
  const seen = new Map<string, number>();
  for (const [k, v] of obj) {
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    const path = [...prefix, count > 1 ? `${k} #${count}` : k];
    if (typeof v === 'string') out[path.join(PATH_SEP)] = v;
    else if (v.length === 0) out[path.join(PATH_SEP)] = '{}';
    else flattenKV(v, path, out);
  }
}

function flattenJSON(value: unknown, prefix: string[], out: Flat) {
  if (Array.isArray(value)) {
    if (value.length === 0) out[prefix.join(PATH_SEP)] = '[]';
    value.forEach((v, i) => flattenJSON(v, [...prefix, `[${i}]`], out));
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) out[prefix.join(PATH_SEP)] = '{}';
    for (const [k, v] of entries) flattenJSON(v, [...prefix, k], out);
  } else {
    out[prefix.join(PATH_SEP)] = typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** Parse a config file into a flat map, or null if it can't be parsed. */
export function flattenFile(file: string, buf: Buffer): Flat | null {
  const text = buf.toString('utf8');
  const out: Flat = {};
  try {
    if (file.toLowerCase().endsWith('.json')) {
      flattenJSON(JSON.parse(text.replace(/^﻿/, '')), [], out);
      return out;
    }
    let obj = buf.toString('latin1', 0, 4) === 'VBKV' ? parseBinaryKV(buf) : parseDotaKV(text);
    // Skip a single wrapping block such as "config" { ... } to keep keys short.
    if (obj.length === 1 && typeof obj[0][1] !== 'string') obj = obj[0][1];
    flattenKV(obj, [], out);
    return out;
  } catch {
    return null;
  }
}

export function fileState(file: string, buf: Buffer): FileState {
  return { hash: hashBytes(buf), flat: flattenFile(file, buf) };
}

export function diffFlat(before: Flat, after: Flat): KeyChange[] {
  const changes: KeyChange[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) {
      changes.push({ path: key.split(PATH_SEP), kind: 'added', before: null, after: value });
    } else if (before[key] !== value) {
      changes.push({ path: key.split(PATH_SEP), kind: 'changed', before: before[key], after: value });
    }
  }
  for (const [key, value] of Object.entries(before)) {
    if (!(key in after)) {
      changes.push({ path: key.split(PATH_SEP), kind: 'removed', before: value, after: null });
    }
  }
  return changes;
}

/** Compare two versions of one file. Returns null when neither exists. */
export function diffFile(file: string, before: FileState | null, after: FileState | null): FileDiff | null {
  if (!before && !after) return null;
  if (before && after && before.hash === after.hash) return { file, status: 'same', changes: [] };

  const status: FileDiff['status'] = !before ? 'added' : !after ? 'removed' : 'changed';
  const bFlat = before ? before.flat : {};
  const aFlat = after ? after.flat : {};
  if (!bFlat || !aFlat) {
    return {
      file,
      status,
      unparsed: true,
      changes: [{ path: ['(file content)'], kind: status === 'added' ? 'added' : status === 'removed' ? 'removed' : 'changed', before: null, after: null }],
    };
  }
  const changes = diffFlat(bFlat, aFlat);
  return { file, status, changes, formattingOnly: status === 'changed' && changes.length === 0 };
}
