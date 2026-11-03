const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gbkStrict = new TextDecoder('gbk', { fatal: true });

function tryDecode(decoder, bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function looksBinary(buf) {
  if (hasUtf16Bom(buf)) return false;
  const end = Math.min(buf.length, 65536);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function hasUtf16Bom(buf) {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
}

// Decodes a whole file and reports the encoding so edits can write it back unchanged.
export function decodeFile(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: Buffer.from(buf.subarray(2)).swap16().toString('utf16le'), encoding: 'utf16be' };
  }
  const utf8 = tryDecode(utf8Strict, buf);
  if (utf8 !== null) return { text: utf8, encoding: 'utf8' };
  const gbk = tryDecode(gbkStrict, buf);
  if (gbk !== null) return { text: gbk, encoding: 'gbk' };
  return { text: buf.toString('utf8'), encoding: 'unknown' };
}

let gbkTable = null;

// Node can decode GBK but not encode it, so the table is built from the decoder.
function gbkEncoder() {
  if (gbkTable) return gbkTable;
  gbkTable = new Map();
  const decoder = new TextDecoder('gbk');
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const char = decoder.decode(Uint8Array.of(lead, trail));
      if (char.length >= 1 && !char.includes('�') && !gbkTable.has(char)) {
        gbkTable.set(char, [lead, trail]);
      }
    }
  }
  return gbkTable;
}

export function encodeFile(text, encoding) {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
    case 'gbk': {
      const table = gbkEncoder();
      const out = [];
      for (const char of text) {
        const code = char.codePointAt(0);
        if (code < 0x80) {
          out.push(code);
          continue;
        }
        const pair = table.get(char);
        if (!pair) throw new Error(`character "${char}" cannot be stored in this GBK file`);
        out.push(pair[0], pair[1]);
      }
      return Buffer.from(out);
    }
    default:
      return Buffer.from(text, 'utf8');
  }
}

// Command output can mix encodings, so anything that is not UTF-8 is retried line by line as GBK.
export function decodeOutput(buf) {
  const whole = tryDecode(utf8Strict, buf);
  if (whole !== null) return whole;
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    end = end === -1 ? buf.length : end + 1;
    const line = buf.subarray(start, end);
    parts.push(tryDecode(utf8Strict, line) ?? tryDecode(gbkStrict, line) ?? line.toString('utf8'));
    start = end;
  }
  return parts.join('');
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function cleanOutput(text) {
  return text.replace(ANSI, '').replace(/\r\n/g, '\n');
}
