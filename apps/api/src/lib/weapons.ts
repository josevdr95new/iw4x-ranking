/**
 * Diccionario de nombres de armas MW2/IW4x: decodifica el weaponCode crudo del
 * games_mp.log (ej. "ump45_eotech_mp") a nombre display humano ("UMP45 + EOTech").
 *
 * Formato de código IW: <base>[_<attachment1>][_<attachment2>]_mp
 *  - Ej. "mp5k_reflex_silencer_mp" → "MP5K + Mira holográfica + Silenciador".
 *
 * Decodificación:
 *  1. Strip del sufijo "_mp".
 *  2. Lookup del código COMPLETO en WEAPON_DISPLAY_NAMES (equipamiento y
 *     killstreaks compuestos: "frag_grenade", "precision_airstrike", ...).
 *  3. Si no, primer token = arma base (diccionario), resto = attachments.
 *  4. Último recurso: humanizar el token (capitalize, sin guiones bajos) para
 *     NUNCA mostrar el crudo al usuario.
 *
 * Cobertura: arsenal estándar de MW2 (ars, smg, lmg, sniper, shotgun, machine
 * pistol, pistol, launcher) + equipamiento/killstreaks que aparecen en el
 * killfeed. Alias de códigos internos: "masada" es el ACR, "sa80" es el
 * L86 LSW (código visto REAL en el log del dueño), "scarh"/"scar" → SCAR-H,
 * "m21"/"m21ebr" → M21 EBR.
 *
 * Español para los attachments (convención de la web); nombres propios de arma
 * se mantienen en su forma oficial (UMP45, FAMAS, AK-47...).
 */

/** Nombres display por código base (sin "_mp") y códigos compuestos completos. */
const WEAPON_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // ── Assault Rifles ────────────────────────────────────────────────
  m4: 'M4A1',
  ak47: 'AK-47',
  famas: 'FAMAS',
  m16: 'M16A4',
  scar: 'SCAR-H',
  scarh: 'SCAR-H',
  tar21: 'TAR-21',
  tavor: 'TAR-21',
  masada: 'ACR',
  acr: 'ACR',
  fn2000: 'F2000',
  // ── SMGs ──────────────────────────────────────────────────────────
  mp5k: 'MP5K',
  ump45: 'UMP45',
  vector: 'Vector',
  p90: 'P90',
  uzi: 'Mini-Uzi',
  // ── LMGs ──────────────────────────────────────────────────────────
  l86: 'L86 LSW',
  sa80: 'L86 LSW', // código interno REAL visto en el log (familia SA80)
  mg4: 'MG4',
  m240: 'M240',
  aug: 'AUG HBAR',
  rpd: 'RPD',
  // ── Snipers ───────────────────────────────────────────────────────
  cheytac: 'Intervention',
  barrett: 'Barrett .50cal',
  wa2000: 'WA2000',
  m21: 'M21 EBR',
  m21ebr: 'M21 EBR',
  // ── Shotguns ──────────────────────────────────────────────────────
  spas12: 'SPAS-12',
  aa12: 'AA-12',
  model1887: 'Model 1887',
  ranger: 'Ranger',
  striker: 'Striker',
  m1014: 'M1014', // herencia COD4 presente en fixtures/logs mixtos
  // ── Machine pistols ───────────────────────────────────────────────
  pp2000: 'PP2000',
  glock: 'G18',
  glock18: 'G18',
  tmp: 'TMP',
  skorpion: 'Skorpion',
  // ── Pistols ───────────────────────────────────────────────────────
  beretta: 'M9',
  usp: 'USP .45',
  deserteagle: 'Desert Eagle',
  deserteaglegold: 'Desert Eagle Dorada',
  coltanaconda: 'Colt Anaconda',
  // ── Launchers ─────────────────────────────────────────────────────
  at4: 'AT4',
  m79: 'Thumper',
  rpg: 'RPG-7',
  stinger: 'Stinger',
  javelin: 'Javelin',
  // ── Melee / equipamiento ──────────────────────────────────────────
  knife: 'Cuchillo',
  riotshield: 'Escudo antidisturbios',
  semtex: 'Semtex',
  frag_grenade: 'Granada de fragmentación',
  concussion_grenade: 'Granada aturdidora',
  flash_grenade: 'Granada flash',
  smoke_grenade: 'Granada de humo',
  claymore: 'Claymore',
  c4: 'C4',
  // ── Killstreaks (aparecen como "arma" en el killfeed) ─────────────
  pavelow: 'Pavelow',
  harrier: 'Harrier',
  ac130: 'AC-130',
  helicopter: 'Chopper Gunner',
  airstrike: 'Ataque aéreo',
  precision_airstrike: 'Ataque aéreo de precisión',
  stealth_airstrike: 'Ataque sigiloso',
  sentry: 'Torreta centinela',
  uav: 'UAV',
  nuke: 'Nuclear táctica',
  // ── Sin arma (world kills del log: weapon="none") ─────────────────
  none: 'Desconocida',
};

/** Sufijos de attachment → etiqueta display (con prefijo " + " para concatenar). */
const ATTACHMENT_LABELS: Readonly<Record<string, string>> = {
  grip: ' + Empuñadura',
  reflex: ' + Mira holográfica',
  eotech: ' + EOTech',
  silencer: ' + Silenciador',
  fmj: ' + FMJ',
  heartbeat: ' + Heartbeat',
  thermal: ' + Térmica',
  akimbo: ' + Akimbo',
  gl: ' + Lanzagranadas',
  m203: ' + M203',
  shotgun: ' + Escopeta',
  reddot: ' + Punto rojo',
  xmag: ' + Cargador ampliado',
  xmags: ' + Cargador ampliado', // sufijo real de MW2
  rapidfire: ' + Fuego rápido',
  acog: ' + Mira ACOG',
  // Pistols: "_tactical" = Tactical Knife de MW2 (solo armas secondary).
  tactical: ' + Cuchillo táctico',
};

/** Capitaliza un token para el fallback de códigos desconocidos. */
function humanizeToken(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Variantes que llegan como PREFIJO del código en logs/mods viejos (el diccionario
 * solo trae códigos base y el attachment infix "_gl_"): "gl_famas" → base "famas".
 * Mismo patrón que apps/web/src/pages/PlayerPage.tsx WEAPON_CODE_PREFIXES.
 */
const WEAPON_CODE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['gl_', ' + Lanzagranadas'],
];

/**
 * Decodifica un weaponCode crudo del log a nombre display humano.
 * Unknown → título humanizado del código (strip "_mp", split por "_",
 * capitalize); nunca devuelve el crudo. null/vacío → "Desconocida".
 */
export function weaponDisplayName(code: string | null | undefined): string {
  if (code === null || code === undefined) return 'Desconocida';
  const stripped = code.trim().toLowerCase().replace(/_mp$/, '');
  if (stripped === '') return 'Desconocida';

  // 1) Código completo (equipamiento/killstreaks compuestos: frag_grenade, ...).
  const full = WEAPON_DISPLAY_NAMES[stripped];
  if (full !== undefined) return full;

  // 2) Variante como PREFIJO (mods/logs viejos, ej. "gl_famas_mp"): se decodifica
  //    la base con esta misma función (diccionario o fallback humanizado) y la
  //    variante va al final → "FAMAS + Lanzagranadas" (nunca "Gl Famas").
  for (const [prefix, suffix] of WEAPON_CODE_PREFIXES) {
    if (stripped.startsWith(prefix) && stripped.length > prefix.length) {
      return `${weaponDisplayName(stripped.slice(prefix.length))}${suffix}`;
    }
  }

  // 3) Primer token = arma base; resto = attachments. Con base DESCONOCIDA los
  //    tokens no-attachment se humanizan como palabras (nunca "X + Y" falso):
  //    "mystery_gun_mp" → "Mystery Gun", "exotic_sniper_thermal_mp" → "Exotic Sniper + Térmica".
  const tokens = stripped.split('_').filter((token) => token.length > 0);
  if (tokens.length === 0) return 'Desconocida';

  const baseToken = tokens[0] ?? '';
  const baseKnown = WEAPON_DISPLAY_NAMES[baseToken] !== undefined;
  const extraWords: string[] = [];
  const attachments: string[] = [];
  for (const token of tokens.slice(1)) {
    const label = ATTACHMENT_LABELS[token];
    if (label !== undefined) attachments.push(label);
    else if (baseKnown) attachments.push(` + ${humanizeToken(token)}`);
    else extraWords.push(humanizeToken(token));
  }
  if (baseKnown) {
    const base = WEAPON_DISPLAY_NAMES[baseToken] ?? humanizeToken(baseToken);
    return `${base}${attachments.join('')}`;
  }
  return `${[humanizeToken(baseToken), ...extraWords].join(' ')}${attachments.join('')}`;
}

export interface WeaponDictionaryEntry {
  /** Código crudo del log (sin "_mp"). */
  code: string;
  /** Nombre display humano. */
  name: string;
}

export interface WeaponDictionaryResponse {
  total: number;
  weapons: WeaponDictionaryEntry[];
}

/**
 * Diccionario estático completo code→name (para la web: decodifica códigos
 * de otros endpoints sin duplicar la tabla en el frontend). Ordenado por
 * nombre, luego código (determinista). Incluye alias internos (sa80, masada...).
 */
export function weaponDictionary(): WeaponDictionaryResponse {
  const weapons = Object.entries(WEAPON_DISPLAY_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  return { total: weapons.length, weapons };
}
