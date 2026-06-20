/* biome-ignore-all lint/suspicious/noBitwiseOperators: MD5 is defined with 32-bit bitwise arithmetic. */
const shifts = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
] as const;

const constants = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0
);

export class IncrementalMd5 {
  private a = 0x67_45_23_01;
  private b = 0xef_cd_ab_89;
  private c = 0x98_ba_dc_fe;
  private d = 0x10_32_54_76;
  private length = 0;
  private pending = new Uint8Array(0);

  append(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    this.length += bytes.byteLength;
    const combined = new Uint8Array(this.pending.byteLength + bytes.byteLength);
    combined.set(this.pending);
    combined.set(bytes, this.pending.byteLength);
    const completeLength = combined.byteLength - (combined.byteLength % 64);
    for (let offset = 0; offset < completeLength; offset += 64) {
      this.transform(combined.subarray(offset, offset + 64));
    }
    this.pending = combined.slice(completeLength);
  }

  end() {
    const finalLength = this.pending.byteLength < 56 ? 64 : 128;
    const finalBlock = new Uint8Array(finalLength);
    finalBlock.set(this.pending);
    finalBlock[this.pending.byteLength] = 0x80;
    const bitLength = this.length * 8;
    const view = new DataView(finalBlock.buffer);
    view.setUint32(finalLength - 8, bitLength >>> 0, true);
    view.setUint32(finalLength - 4, Math.floor(bitLength / 2 ** 32), true);
    for (let offset = 0; offset < finalLength; offset += 64) {
      this.transform(finalBlock.subarray(offset, offset + 64));
    }
    return [this.a, this.b, this.c, this.d].map(toLittleEndianHex).join("");
  }

  private transform(block: Uint8Array) {
    const words = new Uint32Array(16);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < words.length; index += 1) {
      words[index] = view.getUint32(index * 4, true);
    }
    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;
    for (let index = 0; index < 64; index += 1) {
      let value: number;
      let wordIndex: number;
      if (index < 16) {
        value = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        value = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        value = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        value = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const next = d;
      d = c;
      c = b;
      const sum =
        (a +
          value +
          arrayValue(constants, index) +
          arrayValue(words, wordIndex)) >>>
        0;
      b = (b + rotateLeft(sum, arrayValue(shifts, index))) >>> 0;
      a = next;
    }
    this.a = (this.a + a) >>> 0;
    this.b = (this.b + b) >>> 0;
    this.c = (this.c + c) >>> 0;
    this.d = (this.d + d) >>> 0;
  }
}

function rotateLeft(value: number, bits: number) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function arrayValue(values: ArrayLike<number>, index: number) {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`Missing MD5 value at index ${index}`);
  }
  return value;
}

function toLittleEndianHex(value: number) {
  let result = "";
  for (let shift = 0; shift < 32; shift += 8) {
    result += ((value >>> shift) & 0xff).toString(16).padStart(2, "0");
  }
  return result;
}
