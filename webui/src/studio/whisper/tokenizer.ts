// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Whisper's byte-level BPE vocabulary, used only for decoding. Token strings
// spell bytes with GPT-2's printable byte alphabet; a Turkish letter can be
// split across two tokens, so words are assembled from bytes, not strings.

function byteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  return new Map(bs.map((b, i) => [String.fromCharCode(cs[i]), b]));
}

const SPACE = 0x20;

export class WhisperTokenizer {
  private bytes: Uint8Array[] = [];
  private utf8 = new TextDecoder();

  /** `vocab`: vocab.json, token string -> id (special tokens are not needed). */
  constructor(vocab: Record<string, number>) {
    const dec = byteDecoder();
    for (const [s, id] of Object.entries(vocab)) {
      this.bytes[id] = Uint8Array.from(s, (ch) => dec.get(ch) ?? 0);
    }
  }

  tokenBytes(id: number): Uint8Array {
    return this.bytes[id] ?? new Uint8Array(0);
  }

  /** True if the token starts a new word (leading space). */
  startsWord(id: number): boolean {
    return this.bytes[id]?.[0] === SPACE;
  }

  decode(ids: number[]): string {
    const parts = ids.map((id) => this.tokenBytes(id));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return this.utf8.decode(out);
  }
}
