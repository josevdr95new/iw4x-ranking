import { prisma } from '../lib/prisma.js';
import { parseGuidDat, guidHexToDecimal } from '../lib/identity/derive-guid.js';

/**
 * IDENTIDAD GUID ↔ guid.dat (anti robo de identidad en PCs compartidas).
 *
 * PROBLEMA REAL: `guid.dat` es la identidad IW4x (de él deriva el GUID). El
 * launcher lo respalda/restaura POR CUENTA desde la nube; antes del
 * aislamiento varias cuentas subieron EL MISMO guid.dat compartido, y el
 * launcher restauraba "el guid.dat de mi nube" sin verificar a quién
 * pertenecía de verdad → usuarios distintos en la MISMA PC se robaban la
 * identidad (el guid c103bb75… apareció vinculado a cuentas distintas).
 *
 * SOLUCIÓN: el launcher llama a `POST /api/identity/guid-from-file` con el
 * contenido crudo del guid.dat ANTES de restaurarlo y comprueba si el GUID
 * derivado (el mismo cálculo que hace el juego al arrancar, ver
 * src/lib/identity/derive-guid.ts) es de la cuenta del token.
 */

export interface GuidFromFileResult {
  /** GUID derivado en hex lowercase 16 chars (formato del engine) o null. */
  guid: string | null;
  /** El GUID derivado en decimal (formato Player.guid de la DB), o null. */
  guidDecimal: string | null;
  /** true si el guid ∈ linkedGuids de la cuenta del token. */
  ownedByMe: boolean;
  /** displayName del dueño REAL cuando el guid lo tiene OTRA cuenta; null si no. */
  ownerNick: string | null;
}

/**
 * Deriva el GUID de un guid.dat (base64) y comprueba de quién es.
 * Nunca lanza por contenido inválido: `guid: null` (con ownedByMe false) es la
 * respuesta válida para "esto no parece un guid.dat derivable".
 */
export async function resolveGuidFromFile(userId: number, dataBase64: string): Promise<GuidFromFileResult> {
  const buffer = Buffer.from(dataBase64, 'base64');
  const parsed = parseGuidDat(buffer);
  if (parsed === null) {
    return { guid: null, guidDecimal: null, ownedByMe: false, ownerNick: null };
  }

  const link = await prisma.accountLink.findUnique({
    where: { guid: parsed.guidDecimal },
    select: { userId: true, user: { select: { displayName: true } } },
  });

  const ownedByMe = link?.userId === userId;
  // ownerNick SOLO cuando el guid pertenece a OTRA cuenta (logs/UI del launcher).
  const ownerNick = link && link.userId !== userId ? link.user.displayName : null;

  return {
    guid: parsed.guidHex,
    guidDecimal: parsed.guidDecimal,
    ownedByMe,
    ownerNick,
  };
}

export interface ClaimFreshResult {
  ok: true;
  /** Instante de la marca (ISO). One-shot: se limpia al producirse el link nuevo. */
  claimFreshAt: string;
  /** session.guid que quedó desreferenciado (era un guid colgante/ajeno). */
  clearedSessionGuid: string | null;
  /** Guids que siguen vinculados a la cuenta tras la marca (los legítimos). */
  linkedGuids: string[];
}

/**
 * CUARENTENA de identidad (POST /api/identity/claim-fresh): la cuenta declara
 * que espera una identidad NUEVA (su guid.dat se contaminó: compartido en la
 * nube entre cuentas, herencia cruzada, etc.). Efectos:
 *
 *  1. Marca User.claimFreshAt = now. Mientras esté seteada, el auto-link por
 *     sesión ACEPTA un guid nuevo aunque la cuenta ya tenga guids viejos
 *     vinculados (hoy, sin la marca, esas cuentas están fuera del auto-link).
 *     One-shot: el propio auto-link limpia la marca al crear el link.
 *  2. Limpia el PlaySession.guid colgante: la sesión activa de la cuenta deja
 *     de matchear por guids viejos (solo aceptará el guid nuevo que nazca, que
 *     se sellará en la misma sesión al auto-linkarse).
 *
 * NO borra AccountLinks (la decisión sobre links heredados es del usuario desde
 * la UI de vinculación o del admin).
 */
export async function claimFreshIdentity(userId: number): Promise<ClaimFreshResult> {
  const now = new Date();

  const session = await prisma.playSession.findUnique({ where: { userId } });
  let clearedSessionGuid: string | null = null;
  if (session !== null && session.guid !== null) {
    await prisma.playSession.update({ where: { userId }, data: { guid: null } });
    clearedSessionGuid = session.guid;
  }

  await prisma.user.update({ where: { id: userId }, data: { claimFreshAt: now } });

  const links = await prisma.accountLink.findMany({ where: { userId }, select: { guid: true }, orderBy: [{ id: 'asc' }] });
  return {
    ok: true,
    claimFreshAt: now.toISOString(),
    clearedSessionGuid,
    linkedGuids: links.map((link) => link.guid),
  };
}
