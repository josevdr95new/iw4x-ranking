import { createHash } from 'node:crypto';

/**
 * Fabrica guid.dat SINTÉTICOS deterministas (mismo wire format que IW4x:
 * protobuf Certificate { privatekey=1, token=2, ctoken=3 } con un
 * ecc_export(PK_PRIVATE) de libtomcrypt dentro). Sirven para los tests de
 * derivación y de los endpoints de identidad.
 *
 * Cada `variant` produce un par de claves distinto → un GUID distinto y
 * estable, que viene calculado en el resultado (el hash SHA1 no se puede
 * "elegir" a priori).
 */

export interface GuidDatFixture {
  /** Contenido crudo del guid.dat (lo que el launcher sube/envía en base64). */
  data: Buffer;
  /** GUID derivado, hex lowercase 16 chars (formato del engine). */
  guidHex: string;
  /** GUID derivado, decimal (formato Player.guid de la DB). */
  guidDecimal: string;
}

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derInteger(magnitude: Buffer): Buffer {
  let s = 0;
  while (s < magnitude.length - 1 && magnitude[s] === 0) s += 1;
  let mag = magnitude.subarray(s);
  if ((mag[0]! & 0x80) !== 0) mag = Buffer.concat([Buffer.from([0]), mag]);
  return derTlv(0x02, mag);
}

function protoBytesField(field: number, payload: Buffer): Buffer {
  const out: number[] = [];
  let v = payload.length;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.concat([Buffer.from([(field << 3) | 2]), Buffer.from(out), payload]);
}

export function makeGuidDatFixture(variant = 1): GuidDatFixture {
  const keySize = 66; // secp521r1, lo que el juego genera con ecc_make_key(64)
  const x = Buffer.alloc(keySize);
  const y = Buffer.alloc(keySize);
  const k = Buffer.alloc(keySize);
  for (let i = 0; i < keySize; i++) {
    x[i] = (variant * 31 + i * 7 + 1) & 0xff;
    y[i] = (variant * 17 + i * 13 + 5) & 0xff;
    k[i] = (variant * 11 + i * 29 + 9) & 0xff;
  }
  // Asegurar magnitudes no triviales (evitar coordenadas 0 por el patrón lineal).
  x[0] = (x[0]! | 0x40) & 0x7f;
  y[0] = (y[0]! | 0x20) & 0x7f;
  k[0] = (k[0]! | 0x10) & 0x7f;

  const flags = derTlv(0x03, Buffer.from([7, 0x80])); // BIT STRING de 1 bit = 1 (privada)
  const seq = derTlv(
    0x30,
    Buffer.concat([flags, derInteger(Buffer.from([keySize])), derInteger(x), derInteger(y), derInteger(k)]),
  );
  const data = Buffer.concat([
    protoBytesField(1, seq),
    protoBytesField(2, Buffer.from([0x11 * variant, 0x22, 0x33])), // token
    protoBytesField(3, Buffer.from([0x44, 0x55, 0x66])), // ctoken
  ]);

  // publicKey = 0x04 || X || Y (big-endian, keySize bytes cada una) → GUID = LE u64 de sha1[0..8]
  const pub = Buffer.alloc(1 + keySize * 2);
  pub[0] = 0x04;
  pub.set(x, 1 + keySize - x.length);
  pub.set(y, 1 + keySize * 2 - y.length);
  const guid64 = createHash('sha1').update(pub).digest().readBigUInt64LE(0);
  return { data, guidHex: guid64.toString(16).padStart(16, '0'), guidDecimal: guid64.toString(10) };
}

/** Solo el buffer (para bodies { dataBase64 }). */
export function buildGuidDatFixture(variant = 1): Buffer {
  return makeGuidDatFixture(variant).data;
}
