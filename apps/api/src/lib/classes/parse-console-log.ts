/**
 * Parser del dump `/dumpPlayerData` de IW4x → clases de loadout (customClasses).
 *
 * Port 1:1 del `parseConsoleLog` de back1ply/mw2-class-editor (js/parser.js),
 * según el informe `apps/api/gsc/class-editor-notes.md` §2: regex exactas,
 * máquina de estados y las 7 sutilezas documentadas (indentación relativa de
 * clase raíz, valores inline solo en attachment/perks, comillas solo en los
 * extremos, cabeceras de sección exactas, weapon/camo salen del bloque
 * attachment, specialGrenade resetea la sección, fallback CFG).
 *
 * Contexto (notas §3/§6): el blob iw4x.stat está cifrado y las clases viven en
 * el offset 3643 (inaccesible por GSC: GetStat acotado a índices 0..3499). La
 * vía probada de la comunidad es el dump de TEXTO que el CLIENTE imprime en su
 * console_mp.log al ejecutar `/dumpPlayerData`: el MISMO árbol DDL, con los
 * enums resueltos a nombres string. Este parser convierte ese texto en clases.
 *
 * Decisión sobre defaults (notas §4): distinguimos "clase ausente" del dump
 * (`inUse: false`) de "clase con datos" y NO inventamos armas: los defaults son
 * los de producción del editor (js/data.js:265-282, valores reales del juego,
 * nombre `Custom Class N`). El dump es verdad del cliente: NO validamos enums
 * (mods pueden añadir armas/camos custom) y los valores desconocidos se
 * guardan tal cual.
 */

/** Una clase de loadout parseada. `slot` es el índice 0-14 del dump. */
export interface ParsedLoadoutClass {
  slot: number;
  name: string;
  /** true si el jugador tiene la clase en uso (campo `inUse` del dump). */
  inUse: boolean;
  primaryWeapon: string;
  primaryAttach1: string;
  primaryAttach2: string;
  primaryCamo: string;
  secondaryWeapon: string;
  secondaryAttach1: string;
  secondaryAttach2: string;
  secondaryCamo: string;
  /** Lethal: perks[0] del dump (`frag_grenade_mp`, `semtex_mp`, …). ¡[0] NO es un perk! */
  equipment: string;
  /** Tactical SIN sufijo `_mp`: `concussion_grenade`, `flash_grenade`, `smoke_grenade`. */
  specialGrenade: string;
  perk1: string;
  perk2: string;
  perk3: string;
  /** perks[4] del dump (`specialty_null` = ninguno). */
  deathstreak: string;
}

export interface ParseConsoleLogResult {
  /**
   * Las 15 clases (siempre 15 slots: los ausentes van como defaults).
   * `null` SOLO si el texto no contiene ni la sección `customClasses` (árbol)
   * ni líneas `setPlayerData customClasses` (CFG): no es un dump válido.
   */
  classes: ParsedLoadoutClass[] | null;
  /** Clases realmente halladas en el dump (0 si el dump estaba vacío). */
  count: number;
  /** Errores no fatales del parseo (el original nunca la llenaba; nosotros sí). */
  errors: string[];
}

/** Nº de clases custom que IW4x expone (vanilla MW2 tenía 10; IW4x las sube a 15). */
export const NUM_CUSTOM_CLASSES = 15;

/** Timestamp de consola opcional al inicio de línea: `[  18215383]` (espacios internos variables). */
const TIMESTAMP_PATTERN = /^\[\s*\d+\s*\]/;
/** Línea indexada: `[N]` sola (nuevo objeto) o `[N] = valor` (valor inline). */
const INDEXED_LINE_PATTERN = /^\[(\d+)\]\s*=?\s*(.*)$/;
/** Campo KV del dump (separador real: TAB + `= `; la regex es tolerante). */
const KV_PATTERN = /^(\w+)\s*=\s*(.+)$/;
/** Cabecera de sección: palabra sola sin `=`. */
const SECTION_HEADER_PATTERN = /^(\w+)\s*$/;

/** Cabeceras de sección reconocidas: EXACTAMENTE estas tres (sutileza 4). */
const SECTION_HEADERS = new Set<string>(['weaponSetups', 'perks', 'attachment']);

type Section = '' | 'weaponSetups' | 'perks' | 'attachment';

/** Defaults de producción del editor (js/data.js:265-282): valores reales del juego. */
export function getDefaultClass(slot: number): ParsedLoadoutClass {
  return {
    slot,
    name: `Custom Class ${slot + 1}`,
    inUse: false,
    primaryWeapon: 'm4',
    primaryAttach1: 'none',
    primaryAttach2: 'none',
    primaryCamo: 'none',
    secondaryWeapon: 'usp',
    secondaryAttach1: 'none',
    secondaryAttach2: 'none',
    secondaryCamo: 'none',
    equipment: 'frag_grenade_mp',
    specialGrenade: 'concussion_grenade',
    perk1: 'specialty_marathon',
    perk2: 'specialty_bulletdamage',
    perk3: 'specialty_heartbreaker',
    deathstreak: 'specialty_combathigh',
  };
}

/**
 * Limpia el valor inline: solo comillas EXTREMAS (sutileza 3; no hay trim de
 * comillas internas — los códigos de color `^N` del name se preservan en crudo).
 */
function stripQuotes(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

function ensureClass(classMap: Map<number, ParsedLoadoutClass>, idx: number): ParsedLoadoutClass {
  const existing = classMap.get(idx);
  if (existing) return existing;
  const created = getDefaultClass(idx);
  classMap.set(idx, created);
  return created;
}

function finishResult(classMap: Map<number, ParsedLoadoutClass>, errors: string[]): ParseConsoleLogResult {
  const classes: ParsedLoadoutClass[] = [];
  for (let i = 0; i < NUM_CUSTOM_CLASSES; i += 1) {
    classes.push(classMap.get(i) ?? getDefaultClass(i)); // SIEMPRE 15 clases
  }
  return { classes, count: classMap.size, errors };
}

/**
 * Parser principal (formato dumpPlayerData). Dos modos, árbol > CFG:
 *  - Si NINGUNA línea (trim) === 'customClasses' y hay líneas
 *    `setPlayerData customClasses ...` → modo CFG (`parseCfgLines`).
 *  - Si no hay ni árbol ni CFG → `classes: null` (no es un dump válido).
 */
export function parseConsoleLog(rawText: string): ParseConsoleLogResult {
  // El strip del timestamp va PRIMERO: la detección de sección compara la línea
  // ya limpia (en el log real TODAS las líneas llevan `[  NNNNN]` delante).
  const lines = rawText.split(/\r?\n/).map((line) => line.replace(TIMESTAMP_PATTERN, ''));
  if (!lines.some((line) => line.trim() === 'customClasses')) {
    if (lines.some((line) => line.includes('setPlayerData customClasses'))) {
      return parseCfgLines(lines);
    }
    return { classes: null, count: 0, errors: ['El texto no contiene la sección customClasses ni comandos setPlayerData.'] };
  }
  return parseTreeLines(lines);
}

/** Máquina de estados del árbol DDL (formato dumpPlayerData). Recibe líneas ya sin timestamp. */
function parseTreeLines(strippedLines: string[]): ParseConsoleLogResult {
  const errors: string[] = [];
  const classMap = new Map<number, ParsedLoadoutClass>();
  let inCustomClasses = false;
  let currentClassIdx = -1;
  // Indentación (sin trim) del primer [N] "desnudo" bajo customClasses: fija la
  // indentación de clase raíz de forma RELATIVA (sutileza 1).
  let expectedClassIndent = -1;
  let currentSection: Section = '';
  let currentWeaponIdx = -1;
  let currentAttachIdx = -1;

  for (const line of strippedLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (trimmed === 'customClasses') {
      inCustomClasses = true;
      continue;
    }
    if (!inCustomClasses) continue; // ignora todo lo demás del console_mp.log

    const indexed = trimmed.match(INDEXED_LINE_PATTERN);
    if (indexed) {
      const idx = Number.parseInt(indexed[1] ?? '', 10);
      const inlineVal = stripQuotes(indexed[2] ?? '');
      const lineIndent = line.search(/\S/);

      if (!trimmed.includes('=')) {
        // [N] desnudo: nueva clase raíz o nuevo slot de arma.
        if (expectedClassIndent === -1 && currentSection === '') {
          expectedClassIndent = lineIndent;
        }
        if (lineIndent === expectedClassIndent) {
          // NUEVA CLASE RAÍZ.
          currentClassIdx = idx;
          currentSection = '';
          currentWeaponIdx = -1;
          currentAttachIdx = -1;
          ensureClass(classMap, idx);
        } else if (currentSection === 'weaponSetups' || currentSection === 'attachment') {
          // NUEVO SLOT DE ARMA (en dumps reales weaponSetups[0]/[1] está más indentado).
          currentSection = 'weaponSetups';
          currentWeaponIdx = idx;
          currentAttachIdx = -1;
        } else if (idx >= NUM_CUSTOM_CLASSES) {
          errors.push(`Slot de clase fuera de rango ignorado: [${idx}]`);
        }
        continue;
      }

      // [N] = valor inline SOLO se consume en 'attachment' y 'perks' (sutileza 2);
      // el propio [N] de la línea es el índice del elemento del array.
      if (currentSection === 'attachment' && inlineVal) {
        const cls = ensureClass(classMap, currentClassIdx);
        if (currentWeaponIdx === 0 && idx === 0) cls.primaryAttach1 = inlineVal;
        else if (currentWeaponIdx === 0 && idx === 1) cls.primaryAttach2 = inlineVal;
        else if (currentWeaponIdx === 1 && idx === 0) cls.secondaryAttach1 = inlineVal;
        else if (currentWeaponIdx === 1 && idx === 1) cls.secondaryAttach2 = inlineVal;
      } else if (currentSection === 'perks' && inlineVal) {
        const cls = ensureClass(classMap, currentClassIdx);
        if (idx === 0) cls.equipment = inlineVal; // perks[0] = LETHAL, no perk
        else if (idx === 1) cls.perk1 = inlineVal;
        else if (idx === 2) cls.perk2 = inlineVal;
        else if (idx === 3) cls.perk3 = inlineVal;
        else if (idx === 4) cls.deathstreak = inlineVal;
      }
      continue;
    }

    if (currentClassIdx < 0) continue;

    const kv = trimmed.match(KV_PATTERN);
    if (kv) {
      const key = kv[1] ?? '';
      const val = stripQuotes(kv[2] ?? '');
      const cls = ensureClass(classMap, currentClassIdx);
      if (currentSection === '') {
        // Campos raíz. `inUse` no estaba modelado por el editor: nosotros SÍ lo usamos.
        if (key === 'name') cls.name = val;
        else if (key === 'inUse') cls.inUse = val === 'true';
        else if (key === 'specialGrenade') cls.specialGrenade = val;
        // `_deathstreak` (espejo interno del deathstreak) y resto: ignorados.
      } else if (key === 'specialGrenade') {
        // Sutileza 6: specialGrenade es SIEMPRE el último campo raíz del dump
        // (orden alfabético), así que resetear la sección aquí es seguro y deja
        // el estado limpio para la siguiente clase.
        cls.specialGrenade = val;
        currentSection = '';
      } else if ((currentSection === 'weaponSetups' || currentSection === 'attachment') && currentWeaponIdx >= 0) {
        // Sutileza 5: 'weapon'/'camo' tras un bloque attachment reordenan el
        // estado a weaponSetups (el dump ordena attachment < camo < weapon).
        if (currentSection === 'attachment') currentSection = 'weaponSetups';
        if (currentWeaponIdx === 0) {
          if (key === 'weapon') cls.primaryWeapon = val;
          else if (key === 'camo') cls.primaryCamo = val;
        } else if (currentWeaponIdx === 1) {
          if (key === 'weapon') cls.secondaryWeapon = val;
          else if (key === 'camo') cls.secondaryCamo = val;
        }
      }
      continue;
    }

    const header = trimmed.match(SECTION_HEADER_PATTERN);
    if (header) {
      const section = header[1] ?? '';
      if (SECTION_HEADERS.has(section)) {
        currentSection = section as Section;
        // weaponSetups/attachment resetean sus índices (perks no tiene sub-estado).
        if (section === 'weaponSetups') {
          currentWeaponIdx = -1;
          currentAttachIdx = -1;
        } else if (section === 'attachment') {
          currentAttachIdx = -1;
        }
      }
      // Otras palabras sueltas (inUse, _deathstreak, camo…): ignoradas sin romper el estado.
    }
  }

  return finishResult(classMap, errors);
}

/**
 * Modo CFG histórico (fallback): líneas `setPlayerData customClasses <idx>
 * <field> [subidx] <value>` — el formato exacto que genera el editor
 * (js/app.js `generateCommandsForClass`) y el exporter GSC.
 */
export function parseCfgLines(lines: string[]): ParseConsoleLogResult {
  const errors: string[] = [];
  const classMap = new Map<number, ParsedLoadoutClass>();

  for (const rawLine of lines) {
    const line = rawLine.replace(TIMESTAMP_PATTERN, '').trim();
    const parts = line.split(/\s+/);
    if (parts[0] !== 'setPlayerData' || parts[1] !== 'customClasses') continue;

    const idx = Number.parseInt(parts[2] ?? '', 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= NUM_CUSTOM_CLASSES) {
      if (parts[2] !== undefined) errors.push(`Índice de clase fuera de rango descartado: ${parts[2]}`);
      continue;
    }
    const field = parts[3] ?? '';
    const cls = ensureClass(classMap, idx);

    if (field === 'name') {
      // Sobre la línea COMPLETA: soporta nombres con espacios entrecomillados.
      const m = line.match(/name\s+"?(.*?)"?$/);
      if (m) cls.name = m[1] ?? '';
      continue;
    }
    if (field === 'inUse') {
      // El exporter emite inUse (js/core/exporter.js L26-27); el dump CFG del
      // editor no siempre lo trae: si falta, queda el default (false).
      cls.inUse = (parts[4] ?? '') === 'true';
      continue;
    }
    if (field === 'weaponSetups') {
      const slot = Number.parseInt(parts[4] ?? '', 10);
      if (slot !== 0 && slot !== 1) continue;
      const prop = parts[5] ?? '';
      const value = parts[6] ?? '';
      if (prop === 'weapon') {
        if (slot === 0) cls.primaryWeapon = value;
        else cls.secondaryWeapon = value;
      } else if (prop === 'camo') {
        if (slot === 0) cls.primaryCamo = value;
        else cls.secondaryCamo = value;
      } else if (prop === 'attachment') {
        const attachIdx = Number.parseInt(parts[6] ?? '', 10);
        const attachValue = parts[7] ?? '';
        if (attachIdx !== 0 && attachIdx !== 1) continue;
        if (slot === 0 && attachIdx === 0) cls.primaryAttach1 = attachValue;
        else if (slot === 0 && attachIdx === 1) cls.primaryAttach2 = attachValue;
        else if (slot === 1 && attachIdx === 0) cls.secondaryAttach1 = attachValue;
        else if (slot === 1 && attachIdx === 1) cls.secondaryAttach2 = attachValue;
      }
      continue;
    }
    if (field === 'perks') {
      const perkIdx = Number.parseInt(parts[4] ?? '', 10);
      const value = parts[5] ?? '';
      if (perkIdx === 0) cls.equipment = value;
      else if (perkIdx === 1) cls.perk1 = value;
      else if (perkIdx === 2) cls.perk2 = value;
      else if (perkIdx === 3) cls.perk3 = value;
      else if (perkIdx === 4) cls.deathstreak = value;
      continue;
    }
    if (field === 'specialGrenade') {
      cls.specialGrenade = parts[4] ?? '';
      continue;
    }
  }

  return finishResult(classMap, errors);
}
