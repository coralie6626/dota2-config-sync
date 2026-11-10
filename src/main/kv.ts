// Valve KeyValues (VDF / .vcfg) parser. Used only to read and compare files;
// the app never re-serializes them (pushes copy the raw bytes).

export type KVValue = string | KVObject;
/** Ordered entries; Valve files can repeat a key. */
export type KVObject = Array<[string, KVValue]>;

export interface ParseOptions {
  /**
   * Steam's own .vdf files escape quotes and backslashes (\" and \\).
   * Dota's .vcfg files don't: the backslash key is written as "\".
   */
  escapes: boolean;
}

type Token =
  | { t: 'str'; v: string }
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'cond' };

export class KVParseError extends Error {}

export function parseKV(text: string, opts: ParseOptions): KVObject {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  if (text.includes('\0')) throw new KVParseError('Binary data');

  const skip = () => {
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else break;
    }
  };

  const readQuoted = (): string => {
    i++; // opening quote
    if (!opts.escapes) {
      const end = text.indexOf('"', i);
      if (end < 0) throw new KVParseError('Unterminated string');
      const v = text.slice(i, end);
      i = end + 1;
      return v;
    }
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\' && i + 1 < n) {
        const e = text[i + 1];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '"' ? '"' : '\\' + e;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    throw new KVParseError('Unterminated string');
  };

  const next = (): Token | null => {
    skip();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{') {
      i++;
      return { t: 'open' };
    }
    if (c === '}') {
      i++;
      return { t: 'close' };
    }
    if (c === '"') return { t: 'str', v: readQuoted() };
    if (c === '[') {
      const end = text.indexOf(']', i);
      if (end < 0) throw new KVParseError('Unterminated conditional');
      i = end + 1;
      return { t: 'cond' };
    }
    const start = i;
    i++; // always advance, so a stray character can't stall the parser
    while (i < n && !/[\s{}"]/.test(text[i])) i++;
    return { t: 'str', v: text.slice(start, i) };
  };

  const parseObject = (top: boolean): KVObject => {
    const obj: KVObject = [];
    for (;;) {
      const key = next();
      if (!key) {
        if (top) return obj;
        throw new KVParseError('Unexpected end of file');
      }
      if (key.t === 'close') {
        if (top) throw new KVParseError('Unexpected }');
        return obj;
      }
      if (key.t === 'cond') continue;
      if (key.t !== 'str') throw new KVParseError('Expected a key');
      let value = next();
      while (value && value.t === 'cond') value = next();
      if (!value) throw new KVParseError(`Missing value for "${key.v}"`);
      if (value.t === 'open') obj.push([key.v, parseObject(false)]);
      else if (value.t === 'str') obj.push([key.v, value.v]);
      else throw new KVParseError(`Unexpected } after "${key.v}"`);
    }
  };

  return parseObject(true);
}

/** Parse a Dota config file: try without escapes first, then with them. */
export function parseDotaKV(text: string): KVObject {
  try {
    return parseKV(text, { escapes: false });
  } catch {
    return parseKV(text, { escapes: true });
  }
}

/**
 * Binary KeyValues, as in herobuilds.cfg: optional "VBKV" + CRC32 header,
 * then entries of [type byte][NUL-terminated name][value], ended by 0x08.
 */
export function parseBinaryKV(buf: Buffer): KVObject {
  let i = buf.length >= 8 && buf.toString('latin1', 0, 4) === 'VBKV' ? 8 : 0;
  const cstr = () => {
    const end = buf.indexOf(0, i);
    if (end < 0) throw new KVParseError('Unterminated name');
    const s = buf.toString('utf8', i, end);
    i = end + 1;
    return s;
  };
  const need = (len: number) => {
    if (i + len > buf.length) throw new KVParseError('Truncated binary KV');
  };
  const parseObject = (depth: number): KVObject => {
    if (depth > 64) throw new KVParseError('Too deep');
    const obj: KVObject = [];
    for (;;) {
      need(1);
      const type = buf[i++];
      if (type === 0x08 || type === 0x0b) return obj;
      const name = cstr();
      switch (type) {
        case 0x00:
          obj.push([name, parseObject(depth + 1)]);
          break;
        case 0x01:
          obj.push([name, cstr()]);
          break;
        case 0x02:
        case 0x04:
        case 0x06:
          need(4);
          obj.push([name, String(type === 0x02 ? buf.readInt32LE(i) : buf.readUInt32LE(i))]);
          i += 4;
          break;
        case 0x03:
          need(4);
          obj.push([name, String(buf.readFloatLE(i))]);
          i += 4;
          break;
        case 0x07:
        case 0x0a:
          need(8);
          obj.push([name, String(type === 0x07 ? buf.readBigUInt64LE(i) : buf.readBigInt64LE(i))]);
          i += 8;
          break;
        default:
          throw new KVParseError(`Unknown binary KV type ${type}`);
      }
    }
  };
  const root = parseObject(0);
  return root;
}

/** Case-insensitive lookup of a nested key. */
export function kvGet(obj: KVObject, path: string[]): KVValue | undefined {
  let cur: KVValue = obj;
  for (const part of path) {
    if (typeof cur === 'string') return undefined;
    const lower = part.toLowerCase();
    const hit: [string, KVValue] | undefined = cur.find(([k]) => k.toLowerCase() === lower);
    if (!hit) return undefined;
    cur = hit[1];
  }
  return cur;
}

/** The value of the first top-level block, ignoring its name (e.g. "UserLocalConfigStore"). */
export function kvRoot(obj: KVObject): KVObject | undefined {
  const first = obj.find(([, v]) => typeof v !== 'string');
  return first ? (first[1] as KVObject) : undefined;
}
