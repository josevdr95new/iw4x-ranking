/**
 * Fixture REAL del dump `/dumpPlayerData` — transcripción COMPLETA de la sección
 * customClasses del `sample_from_console_mp.log` de back1ply/mw2-class-editor
 * (15 clases con todos los campos), según `apps/api/gsc/class-editor-notes.md` §1.
 *
 * El builder reproduce el formato literal del log: timestamp de consola opcional
 * `[  NNNNN]`, separador KV TAB + `= `, arrays anidados por indentación, campos
 * en orden alfabético (ASCII) a cada nivel y strings entre comillas solo en name.
 */

export interface FixtureClass {
  name: string;
  primaryWeapon: string;
  primaryAttach1: string;
  primaryAttach2: string;
  primaryCamo: string;
  secondaryWeapon: string;
  secondaryAttach1: string;
  secondaryAttach2: string;
  secondaryCamo: string;
  equipment: string;
  specialGrenade: string;
  perk1: string;
  perk2: string;
  perk3: string;
  deathstreak: string;
}

/** Las 15 clases del fixture real (todas inUse=true), en orden de slot 0-14. */
export const FIXTURE_CLASSES: FixtureClass[] = [
  { name: 'THE NOOB2', primaryWeapon: 'ump45', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'beretta393', secondaryAttach1: 'silencer', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'frag_grenade_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_combathigh' },
  { name: 'UMP Tryhard', primaryWeapon: 'ump45', primaryAttach1: 'fmj', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'deserteaglegold', secondaryAttach1: 'silencer', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'frag_grenade_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_bulletdamage', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_combathigh' },
  { name: 'UMP Rush', primaryWeapon: 'ump45', primaryAttach1: 'fmj', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'coltanaconda', secondaryAttach1: 'tactical', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'semtex_mp', specialGrenade: 'flash_grenade', perk1: 'specialty_marathon', perk2: 'specialty_lightweight', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_combathigh' },
  { name: '^2FAL Ninja', primaryWeapon: 'fal', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'onemanarmy', secondaryAttach1: 'none', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'frag_grenade_mp', specialGrenade: 'flash_grenade', perk1: 'specialty_onemanarmy', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_grenadepulldeath' },
  { name: '^1Cancer Riot', primaryWeapon: 'riotshield', primaryAttach1: 'none', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'coltanaconda', secondaryAttach1: 'tactical', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'throwingknife_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_marathon', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_grenadepulldeath' },
  { name: '^1Cancer Loud', primaryWeapon: 'famas', primaryAttach1: 'acog', primaryAttach2: 'none', primaryCamo: 'desert', secondaryWeapon: 'spas12', secondaryAttach1: 'grip', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'semtex_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_fastreload', perk2: 'specialty_bulletdamage', perk3: 'specialty_bulletaccuracy', deathstreak: 'specialty_finalstand' },
  { name: '^1Cancer Ninja', primaryWeapon: 'famas', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'onemanarmy', secondaryAttach1: 'none', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'claymore_mp', specialGrenade: 'smoke_grenade', perk1: 'specialty_onemanarmy', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_combathigh' },
  { name: '^1Cancer Noob', primaryWeapon: 'peacekeeper', primaryAttach1: 'none', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'pp2000', secondaryAttach1: 'silencer', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'frag_grenade_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_bulletdamage', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_grenadepulldeath' },
  { name: 'Sniper Tryhard', primaryWeapon: 'barrett', primaryAttach1: 'thermal', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'glock', secondaryAttach1: 'akimbo', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'frag_grenade_mp', specialGrenade: 'smoke_grenade', perk1: 'specialty_fastreload', perk2: 'specialty_bulletdamage', perk3: 'specialty_bulletaccuracy', deathstreak: 'specialty_grenadepulldeath' },
  { name: 'AK Tryhard', primaryWeapon: 'ak47classic', primaryAttach1: 'fmj', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'deserteaglegold', secondaryAttach1: 'fmj', secondaryAttach2: 'none', secondaryCamo: 'gold', equipment: 'frag_grenade_mp', specialGrenade: 'flash_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_bulletdamage', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_grenadepulldeath' },
  { name: 'Cancer HC Snipe', primaryWeapon: 'm21', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'beretta393', secondaryAttach1: 'silencer', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'semtex_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_fastreload', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_grenadepulldeath' },
  { name: 'M4 Anti Air', primaryWeapon: 'm4', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'stinger', secondaryAttach1: 'none', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'frag_grenade_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_fastreload', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_grenadepulldeath' },
  { name: 'ACR Ninja', primaryWeapon: 'masada', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'beretta393', secondaryAttach1: 'silencer', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'claymore_mp', specialGrenade: 'concussion_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_bulletdamage', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_combathigh' },
  { name: '^4Scar-H Ninja', primaryWeapon: 'scar', primaryAttach1: 'silencer', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'spas12', secondaryAttach1: 'silencer', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'claymore_mp', specialGrenade: 'flash_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_coldblooded', perk3: 'specialty_heartbreaker', deathstreak: 'specialty_combathigh' },
  { name: 'Cancer', primaryWeapon: 'aug', primaryAttach1: 'fmj', primaryAttach2: 'none', primaryCamo: 'none', secondaryWeapon: 'javelin', secondaryAttach1: 'none', secondaryAttach2: 'none', secondaryCamo: 'none', equipment: 'semtex_mp', specialGrenade: 'flash_grenade', perk1: 'specialty_scavenger', perk2: 'specialty_bulletdamage', perk3: 'specialty_bulletaccuracy', deathstreak: 'specialty_grenadepulldeath' },
];

/**
 * Construye el texto del dump. Con `timestamps: true` cada línea lleva el
 * timestamp de consola `[  18215383]` (espacios internos variables, como el
 * log real); sin él, líneas limpias — el parser debe producir el MISMO
 * resultado con y sin timestamps (golden case del editor).
 */
export function buildConsoleLogDump(options: { timestamps?: boolean; classes?: FixtureClass[] } = {}): string {
  const { timestamps = true, classes = FIXTURE_CLASSES } = options;
  const p = timestamps ? '[  18215383]' : '';
  const out: string[] = [];
  out.push(`${p}     customClasses`);
  classes.forEach((cls, slot) => {
    // Campos en orden alfabético ASCII: _deathstreak < inUse < name < perks < specialGrenade < weaponSetups
    out.push(`${p}       [${slot}]`);
    out.push(`${p}         _deathstreak\t= specialty_null`);
    out.push(`${p}         inUse\t= true`);
    out.push(`${p}         name\t= "${cls.name}"`);
    out.push(`${p}         perks`);
    out.push(`${p}           [0]\t= ${cls.equipment}`);
    out.push(`${p}           [1]\t= ${cls.perk1}`);
    out.push(`${p}           [2]\t= ${cls.perk2}`);
    out.push(`${p}           [3]\t= ${cls.perk3}`);
    out.push(`${p}           [4]\t= ${cls.deathstreak}`);
    out.push(`${p}         specialGrenade\t= ${cls.specialGrenade}`);
    out.push(`${p}         weaponSetups`);
    // Dentro de cada weaponSetup: attachment < camo < weapon
    out.push(`${p}           [0]`);
    out.push(`${p}             attachment`);
    out.push(`${p}               [0]\t= ${cls.primaryAttach1}`);
    out.push(`${p}               [1]\t= ${cls.primaryAttach2}`);
    out.push(`${p}             camo\t= ${cls.primaryCamo}`);
    out.push(`${p}             weapon\t= ${cls.primaryWeapon}`);
    out.push(`${p}           [1]`);
    out.push(`${p}             attachment`);
    out.push(`${p}               [0]\t= ${cls.secondaryAttach1}`);
    out.push(`${p}               [1]\t= ${cls.secondaryAttach2}`);
    out.push(`${p}             camo\t= ${cls.secondaryCamo}`);
    out.push(`${p}             weapon\t= ${cls.secondaryWeapon}`);
  });
  return `${out.join('\n')}\n`;
}

/** Envuelve el dump en un console_mp.log "entero" (basura antes y después). */
export function wrapInFullConsoleLog(dump: string): string {
  return [
    'IW4x r4785 multiplayer',
    'execing autoexec_mp',
    '[  18215001] "say_team hola"',
    '------- Game Initialization -------',
    dump,
    '[  18216000] prestige = 1',
    '[  18216001] experience = 502700',
    '------ Unloads ------',
  ].join('\n');
}
