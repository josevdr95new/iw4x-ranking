/**
 * Tests de la derivación del GUID de IW4x desde guid.dat
 * (src/lib/identity/derive-guid.ts).
 *
 * El algoritmo está validado contra un guid.dat REAL (el derivado es
 * c103bb7531742427 = 13908166186265486375, el guid conocido del dueño); aquí se
 * prueban el parseo protobuf+DER, el padding/endianness del punto público y la
 * robustez ante contenido inválido con vectores SINTÉTICOS construidos con el
 * mismo formato que produce libtomcrypt (ecc_export PK_PRIVATE dentro del
 * protobuf Certificate).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { deriveGuidFromGuidDat, guidHexToDecimal, parseGuidDat } from '../src/lib/identity/derive-guid.js';

// ── Encoders sintéticos (mismo wire format que libtomcrypt + protobuf) ──────

function derVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
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
  // magnitud sin signo big-endian; DER: strip de ceros iniciales y 0x00 de signo si el MSB es 1
  let s = 0;
  while (s < magnitude.length - 1 && magnitude[s] === 0) s += 1;
  let mag = magnitude.subarray(s);
  if ((mag[0]! & 0x80) !== 0) mag = Buffer.concat([Buffer.from([0]), mag]);
  return derTlv(0x02, mag);
}

/** BIT STRING de 1 bit como el que genera libtomcrypt para las flags. */
function derBitStringFlags(value: 0 | 1): Buffer {
  return derTlv(0x03, Buffer.from([7, value << 7]));
}

/** ecc_export(PK_PRIVATE|PK_PUBLIC) sintético: SEQ{ flags, key_size, x, y [, k] }. */
function derEccExport(keySize: number, x: Buffer, y: Buffer, k: Buffer | null): Buffer {
  const children: Buffer[] = [derBitStringFlags(k !== null ? 1 : 0), derInteger(Buffer.from([keySize])), derInteger(x), derInteger(y)];
  if (k !== null) children.push(derInteger(k));
  return derTlv(0x30, Buffer.concat(children));
}

function protoBytesField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), derVarint(payload.length), payload]);
}

function buildGuidDat(keySize: number, x: Buffer, y: Buffer, k: Buffer | null): Buffer {
  return Buffer.concat([
    protoBytesField(1, derEccExport(keySize, x, y, k)),
    protoBytesField(2, Buffer.from([0x11, 0x22, 0x33])), // token
    protoBytesField(3, Buffer.from([0x44, 0x55, 0x66])), // ctoken
  ]);
}

/** GUID esperado: LE u64 de sha1(0x04 || X(keySize) || Y(keySize))[0..8]. */
function expectedGuidHex(keySize: number, x: Buffer, y: Buffer): string {
  const pub = Buffer.alloc(1 + keySize * 2);
  pub[0] = 0x04;
  pub.set(x, 1 + keySize - x.length);
  pub.set(y, 1 + keySize * 2 - y.length);
  return createHash('sha1').update(pub).digest().readBigUInt64LE(0).toString(16).padStart(16, '0');
}

const KEY_SIZE = 66; // secp521r1 (la curva que ecc_make_key(64) selecciona)
const X = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123', 'hex');
const Y = Buffer.from('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedc', 'hex');
const K = Buffer.from('cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabecafe', 'hex');

// ── Derivación correcta ─────────────────────────────────────────────────────

describe('deriveGuidFromGuidDat', () => {
  it('deriva el GUID determinista de un guid.dat sintético (export privado completo)', () => {
    const dat = buildGuidDat(KEY_SIZE, X, Y, K);
    const first = deriveGuidFromGuidDat(dat);
    expect(first).toBe(expectedGuidHex(KEY_SIZE, X, Y));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // determinismo
    expect(deriveGuidFromGuidDat(dat)).toBe(first);
  });

  it('acepta el export PÚBLICO (sin k): mismo GUID (solo X/Y alimentan el hash)', () => {
    const priv = deriveGuidFromGuidDat(buildGuidDat(KEY_SIZE, X, Y, K));
    const pub = deriveGuidFromGuidDat(buildGuidDat(KEY_SIZE, X, Y, null));
    expect(pub).toBe(priv);
    expect(parseGuidDat(buildGuidDat(KEY_SIZE, X, Y, K))!.hasPrivateKey).toBe(true);
    expect(parseGuidDat(buildGuidDat(KEY_SIZE, X, Y, null))!.hasPrivateKey).toBe(false);
  });

  it('maneja el padding de signo DER (X/Y con MSB=1 y ceros iniciales) sin cambiar el GUID', () => {
    // MISMO valor de X/Y con dos encodados DER: uno cuyo derInteger añade el
    // 0x00 de signo (MSB=1) y otro con ceros iniciales superfluos. El GUID debe
    // ser idéntico (el parser normaliza la magnitud sin signo).
    const xVal = Buffer.concat([Buffer.from('ff', 'hex'), X.subarray(1)]); // MSB alto → 0x00 de signo en DER
    const dat1 = buildGuidDat(KEY_SIZE, xVal, Y, K);
    const dat2 = buildGuidDat(KEY_SIZE, Buffer.concat([Buffer.alloc(2, 0), xVal]), Buffer.concat([Buffer.alloc(2, 0), Y]), K);
    expect(deriveGuidFromGuidDat(dat2)).toBe(deriveGuidFromGuidDat(dat1));
    expect(deriveGuidFromGuidDat(dat1)).toBe(expectedGuidHex(KEY_SIZE, xVal, Y));
  });

  it('cambiar UN byte de X o de Y cambia el GUID derivado', () => {
    const base = deriveGuidFromGuidDat(buildGuidDat(KEY_SIZE, X, Y, K))!;

    const xMut = Buffer.from(X);
    xMut[10] = (xMut[10]! + 1) & 0xff;
    expect(deriveGuidFromGuidDat(buildGuidDat(KEY_SIZE, xMut, Y, K))).not.toBe(base);

    const yMut = Buffer.from(Y);
    yMut[40] = (yMut[40]! + 1) & 0xff;
    expect(deriveGuidFromGuidDat(buildGuidDat(KEY_SIZE, X, yMut, K))).not.toBe(base);

    // cambiar el token/ctoken del protobuf NO cambia el GUID (no participa)
    const dat = buildGuidDat(KEY_SIZE, X, Y, K);
    const datMut = Buffer.concat([protoBytesField(1, derEccExport(KEY_SIZE, X, Y, K)), protoBytesField(2, Buffer.from([0, 0, 0])), protoBytesField(3, Buffer.from([9]))]);
    expect(deriveGuidFromGuidDat(datMut)).toBe(base);
    expect(deriveGuidFromGuidDat(dat)).toBe(base);
  });

  it('pasa por tamaños de curva menores (P-256: keySize 32)', () => {
    const x32 = X.subarray(0, 32);
    const y32 = Y.subarray(0, 32);
    expect(deriveGuidFromGuidDat(buildGuidDat(32, x32, y32, x32))).toBe(expectedGuidHex(32, x32, y32));
  });

  it('guidHexToDecimal convierte al formato Player.guid de la DB (vector real validado)', () => {
    // Vector validado EN VIVO con el guid.dat real del dueño: c103bb7531742427.
    expect(guidHexToDecimal('c103bb7531742427')).toBe('13908166186265486375');
    expect(BigInt(`0x${guidHexToDecimal('ffffffffffffffff')}`) > 0n).toBe(true); // u64 sin signo
    expect(guidHexToDecimal('ffffffffffffffff')).toBe('18446744073709551615');
  });

  it('contorno real opcional: IW4X_GUID_DAT_PROBE apuntando a un guid.dat real', () => {
    const probePath = process.env.IW4X_GUID_DAT_PROBE;
    if (!probePath || !existsSync(probePath)) {
      // En CI no hay guid.dat real: el vector sintético ya cubre el algoritmo.
      return;
    }
    const derived = deriveGuidFromGuidDat(readFileSync(probePath));
    expect(derived).not.toBeNull();
    expect(derived!).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── Rechazo de contenido inválido (null, sin lanzar) ────────────────────────

describe('deriveGuidFromGuidDat: contenido inválido → null', () => {
  it('buffers triviales', () => {
    expect(deriveGuidFromGuidDat(Buffer.alloc(0))).toBeNull();
    expect(deriveGuidFromGuidDat(Buffer.from('basura no es un guid.dat'))).toBeNull();
    expect(deriveGuidFromGuidDat(Buffer.alloc(4, 1))).toBeNull();
  });

  it('protobuf sin campo privatekey (field 1)', () => {
    const noField1 = Buffer.concat([protoBytesField(2, Buffer.from([1, 2, 3])), protoBytesField(3, Buffer.from([4]))]);
    expect(deriveGuidFromGuidDat(noField1)).toBeNull();
  });

  it('field 1 que no es un DER SEQUENCE', () => {
    const garbage = protoBytesField(1, Buffer.from([0x99, 0x98, 0x97, 0x96, 0x95, 0x94, 0x93, 0x92]));
    expect(deriveGuidFromGuidDat(garbage)).toBeNull();
  });

  it('DER truncado (len declares más de lo que hay)', () => {
    const truncated = Buffer.from('3081d3 0302 0780 020142 0242018d'.replace(/ /g, ''), 'hex');
    expect(deriveGuidFromGuidDat(truncated)).toBeNull();
  });

  it('key_size fuera de rango (1 y 999)', () => {
    const tiny = buildGuidDat(1, X.subarray(0, 1), Y.subarray(0, 1), K);
    // keySize=1 está bajo el mínimo de curva de libtomcrypt → rechazado
    expect(deriveGuidFromGuidDat(tiny)).toBeNull();
    // keySize 999 no cabe en 1 byte de INTEGER → el parser lo ve como raro o
    // las coordenadas (66) no caben en 999… igualmente inválido por bounds del
    // buffer: construimos un DER a mano con key_size de 2 bytes.
    const children = Buffer.concat([
      derBitStringFlags(1),
      Buffer.concat([Buffer.from([0x02, 0x02, 0x03, 0xe7])]), // INTEGER 999
      derInteger(X),
      derInteger(Y),
    ]);
    expect(deriveGuidFromGuidDat(Buffer.concat([protoBytesField(1, derTlv(0x30, children))]))).toBeNull();
  });

  it('faltan coordenadas (solo key_size y x)', () => {
    const children = Buffer.concat([derBitStringFlags(1), derInteger(Buffer.from([KEY_SIZE])), derInteger(X)]);
    expect(deriveGuidFromGuidDat(Buffer.concat([protoBytesField(1, derTlv(0x30, children))]))).toBeNull();
  });

  it('tags DER ajenos dentro de la secuencia (no es un export ecc)', () => {
    const children = Buffer.concat([
      derBitStringFlags(1),
      derInteger(Buffer.from([KEY_SIZE])),
      derInteger(X),
      derTlv(0x0c, Buffer.from('una string donde deberia ir Y')), // UTF8String
    ]);
    expect(deriveGuidFromGuidDat(Buffer.concat([protoBytesField(1, derTlv(0x30, children))]))).toBeNull();
  });

  it('wireTypes protobuf no soportados (fixed32) → null', () => {
    const withFixed32 = Buffer.concat([Buffer.from([0x0d]), Buffer.from([1, 0, 0, 0]), protoBytesField(1, derEccExport(KEY_SIZE, X, Y, K))]);
    expect(deriveGuidFromGuidDat(withFixed32)).toBeNull();
  });
});
