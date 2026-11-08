import { createHash } from 'node:crypto';

/**
 * Derivación del GUID de IW4x desde el contenido crudo de `guid.dat`.
 *
 * El juego deriva su GUID EXACTAMENTE así (iw4x-client r5318):
 *
 * 1. `guid.dat` (en %LOCALAPPDATA%\iw4x\guid.dat) es un protobuf `Certificate`
 *    (src/Proto/auth.proto):
 *
 *      message Certificate {
 *        bytes privatekey = 1;
 *        bytes token      = 2;
 *        bytes ctoken     = 3;
 *      }
 *
 * 2. `Auth::LoadKey` (src/Components/Modules/Auth.cpp) importa el campo
 *    `privatekey` con `GuidKey.deserialize(cert.privatekey())`. Ese blob es el
 *    `ecc_export(PK_PRIVATE)` de libtomcrypt (deps/libtomcrypt):
 *
 *      SEQUENCE {
 *        BIT_STRING  flags      (1 bit: 1 = privada, 0 = pública)
 *        INTEGER     key_size   ("NIST byte size" de la curva; P-521 → 66)
 *        INTEGER     pubkey.x
 *        INTEGER     pubkey.y
 *        INTEGER     k          (solo si flags = privada)
 *      }
 *
 *    Nota: X e Y del punto público VAN DENTRO del guid.dat → la derivación es
 *    replicable server-side sin matemática EC (no hay que multiplicar puntos).
 *
 * 3. El GUID es el hash de la clave PÚBLICA en formato ANSI X9.63 sin comprimir
 *    (`ECC::Key::getPublicKey` → `ecc_ansi_x963_export` → `ltc_ecc_export_point`:
 *    `0x04 || X || Y`, con X e Y big-endian rellenadas a ceros hasta key_size):
 *
 *      unsigned __int64 Auth::GetKeyHash(const std::string& key)
 *      {
 *        std::string hash = Utils::Cryptography::SHA1::Compute(key);
 *        if (hash.size() >= 8) {
 *          return *reinterpret_cast<unsigned __int64*>(const_cast<char*>(hash.data()));
 *        }
 *        return 0;
 *      }
 *      // llamado como GetKeyHash(GuidKey.getPublicKey())
 *
 *    → GUID (u64) = primeros 8 bytes de SHA1(publicKey) interpretados en
 *    LITTLE-ENDIAN. El engine lo imprime `{:016x}` (hex lowercase, 16 chars):
 *    p. ej. el guid.dat real del dueño deriva c103bb7531742427 =
 *    13908166186265486375 (formato decimal que usa Player.guid en la DB).
 *
 * `deriveGuidFromGuidDat` devuelve ese hex lowercase, o null si el buffer no
 * parece un guid.dat válido (protobuf de Certificate con privatekey que se
 * pueda parsear como la secuencia anterior).
 */

/** Tamaño DER de cada INTEGER de coordenada según la curva (límites sanos). */
const MIN_KEY_SIZE = 20; // octetos: mínimo soportado por libtomcrypt (secp160r1)
const MAX_KEY_SIZE = 66; // octetos: secp521r1, el mayor de la tabla de NIST

interface Tlv {
  tag: number;
  contentStart: number;
  contentEnd: number;
  next: number;
}

/** Lee un TLV DER con longitud short/long-form. null si se sale de bounds. */
function readTlv(buf: Buffer, pos: number): Tlv | null {
  if (pos + 2 > buf.length) return null;
  const tag = buf[pos] as number;
  let len = buf[pos + 1] as number;
  let header = 2;
  if ((len & 0x80) !== 0) {
    const n = len & 0x7f;
    if (n === 0 || pos + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) {
      const byte = buf[pos + 2 + i] as number;
      len = len * 256 + byte;
    }
    header = 2 + n;
  }
  const contentStart = pos + header;
  const contentEnd = contentStart + len;
  if (contentEnd > buf.length) return null;
  return { tag, contentStart, contentEnd, next: contentEnd };
}

/** Contenido de un campo length-delimited del protobuf, sin parsear varints de más. */
interface ProtoBytesField {
  field: number;
  value: Buffer;
}

/**
 * Parser de protobuf mínimo (solo lo que tiene un Certificate): campos
 * length-delimited (wire type 2) y varints (wire type 0). Cualquier otra cosa
 * (sub-mensajes, fixed32/64) → null: un guid.dat legítimo no los contiene.
 */
function parseProtobufBytesFields(buf: Buffer): ProtoBytesField[] | null {
  const fields: ProtoBytesField[] = [];
  let i = 0;
  while (i < buf.length) {
    // varint de tag
    let tag = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) return null;
      const b = buf[i] as number;
      i += 1;
      tag += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return null; // varint imposible en un Certificate real
    }
    const wireType = tag & 7;
    if (wireType === 0) {
      // varint (Certificate no lo usa, pero hay que saltarlo para ser tolerantes)
      let inner = 0;
      let innerShift = 0;
      for (;;) {
        if (i >= buf.length) return null;
        const b = buf[i] as number;
        i += 1;
        inner += (b & 0x7f) * 2 ** innerShift;
        if ((b & 0x80) === 0) break;
        innerShift += 7;
        if (innerShift > 63) return null;
      }
      continue;
    }
    if (wireType !== 2) return null; // fixed32/64, groups, etc.: no es un guid.dat
    // varint de longitud
    let len = 0;
    shift = 0;
    for (;;) {
      if (i >= buf.length) return null;
      const b = buf[i] as number;
      i += 1;
      len += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return null;
    }
    if (len < 0 || i + len > buf.length) return null;
    fields.push({ field: tag >>> 3, value: buf.subarray(i, i + len) });
    i += len;
  }
  return fields;
}

export interface GuidDatParse {
  /** Hex lowercase 16 chars del GUID derivado. */
  guidHex: string;
  /** El mismo GUID en decimal (formato Player.guid de la DB). */
  guidDecimal: string;
  /** true si el blob incluye el escalar k (export PK_PRIVATE, el caso normal). */
  hasPrivateKey: boolean;
}

/**
 * Parsea un guid.dat y deriva su GUID. null si el buffer no es un guid.dat
 * válido (no protobuf Certificate / DER incoherente / coordenadas imposibles).
 */
export function parseGuidDat(buffer: Buffer): GuidDatParse | null {
  // Sanity estructural mínima: un guid.dat real son >100 bytes (DER de P-521
  // + tokens); bajo esto no puede haber ni SEQUENCE ni coordenadas.
  if (buffer.length < 8) return null;

  const fields = parseProtobufBytesFields(buffer);
  if (fields === null) return null;
  const privateKey = fields.find((f) => f.field === 1);
  if (!privateKey) return null;
  const der = privateKey.value;

  const seq = readTlv(der, 0);
  if (seq === null || seq.tag !== 0x30) return null; // SEQUENCE de ecc_export al inicio (len short o long-form)

  const ints: Buffer[] = [];
  let pos = seq.contentStart;
  while (pos < seq.contentEnd) {
    const tlv = readTlv(der, pos);
    if (tlv === null) return null;
    if (tlv.tag === 0x02) {
      // INTEGER: strip del 0x00 de signo (magnitud sin signo big-endian)
      let s = tlv.contentStart;
      while (s < tlv.contentEnd - 1 && der[s] === 0) s += 1;
      ints.push(der.subarray(s, tlv.contentEnd));
    } else if (tlv.tag === 0x03) {
      // BIT_STRING (flags): no afecta la derivación (X/Y están siempre);
      // solo exigimos contenido bien formado.
      if (tlv.contentEnd - tlv.contentStart < 1) return null;
    } else {
      return null; // la secuencia de ecc_export solo contiene BIT_STRING + INTEGERs
    }
    pos = tlv.next;
  }

  // [key_size, x, y] (+ k en export privado → índice 3)
  if (ints.length !== 3 && ints.length !== 4) return null;
  const keySizeInt = ints[0] as Buffer;
  const xInt = ints[1] as Buffer;
  const yInt = ints[2] as Buffer;
  if (keySizeInt.length < 1 || keySizeInt.length > 2) return null;
  let keySize = 0;
  for (const b of keySizeInt) keySize = keySize * 256 + (b as number);
  if (keySize < MIN_KEY_SIZE || keySize > MAX_KEY_SIZE) return null;
  if (xInt.length < 1 || xInt.length > keySize) return null;
  if (yInt.length < 1 || yInt.length > keySize) return null;
  const hasPrivateKey = ints.length === 4;

  // publicKey = 0x04 || X(key_size, big-endian) || Y(key_size, big-endian)
  const publicKey = Buffer.alloc(1 + keySize * 2);
  publicKey[0] = 0x04;
  publicKey.set(xInt, 1 + keySize - xInt.length);
  publicKey.set(yInt, 1 + keySize * 2 - yInt.length);

  // GUID = LE u64 de los 8 primeros bytes de SHA1(publicKey) (Auth::GetKeyHash)
  const sha1 = createHash('sha1').update(publicKey).digest();
  const guid64 = sha1.readBigUInt64LE(0);
  return {
    guidHex: guid64.toString(16).padStart(16, '0'),
    guidDecimal: guid64.toString(10),
    hasPrivateKey,
  };
}

/**
 * Deriva el GUID de un guid.dat (contenido crudo). Devuelve el hex lowercase de
 * 16 chars exactamente como lo imprime el engine (`{:016x}`), o null si el
 * buffer no parece un guid.dat válido.
 */
export function deriveGuidFromGuidDat(buffer: Buffer): string | null {
  return parseGuidDat(buffer)?.guidHex ?? null;
}

/** Convierte un GUID hex (16 chars) al formato decimal de la DB (Player.guid). */
export function guidHexToDecimal(hex: string): string {
  return BigInt(`0x${hex}`).toString(10);
}
