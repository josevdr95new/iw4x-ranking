import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  getDefaultClass,
  parseConsoleLog,
  type ParsedLoadoutClass,
} from '../src/lib/classes/parse-console-log.js';
import {
  FIXTURE_CLASSES,
  buildConsoleLogDump,
  wrapInFullConsoleLog,
} from './fixtures/console-log-fixture.js';
import { registerUser, req, resetDb, type TestUser } from './helpers.js';

// ── Parser puro (port 1:1 de back1ply/mw2-class-editor) ─────────────────────

describe('parseConsoleLog — fixture real (15 clases)', () => {
  const dump = buildConsoleLogDump();
  const result = parseConsoleLog(dump);

  it('parsea SIEMPRE 15 slots y count=15 clases halladas', () => {
    expect(result.classes).not.toBeNull();
    expect(result.classes).toHaveLength(15);
    expect(result.count).toBe(15);
    expect(result.errors).toEqual([]);
  });

  it('clase 0: todos los campos con sus valores exactos del fixture', () => {
    const cls = result.classes![0]!;
    expect(cls.slot).toBe(0);
    expect(cls.name).toBe('THE NOOB2');
    expect(cls.inUse).toBe(true);
    expect(cls.primaryWeapon).toBe('ump45');
    expect(cls.primaryAttach1).toBe('silencer');
    expect(cls.primaryAttach2).toBe('none');
    expect(cls.primaryCamo).toBe('none');
    expect(cls.secondaryWeapon).toBe('beretta393');
    expect(cls.secondaryAttach1).toBe('silencer');
    expect(cls.secondaryAttach2).toBe('none');
    expect(cls.secondaryCamo).toBe('none');
    expect(cls.equipment).toBe('frag_grenade_mp'); // perks[0] = LETHAL
    expect(cls.specialGrenade).toBe('concussion_grenade'); // SIN sufijo _mp
    expect(cls.perk1).toBe('specialty_scavenger');
    expect(cls.perk2).toBe('specialty_coldblooded');
    expect(cls.perk3).toBe('specialty_heartbreaker');
    expect(cls.deathstreak).toBe('specialty_combathigh'); // perks[4]
  });

  it('15/15 clases: cada slot coincide campo a campo con el fixture real', () => {
    result.classes!.forEach((cls: ParsedLoadoutClass, slot: number) => {
      const expected = FIXTURE_CLASSES[slot]!;
      expect(cls.slot).toBe(slot);
      expect(cls.name).toBe(expected.name);
      expect(cls.primaryWeapon).toBe(expected.primaryWeapon);
      expect(cls.primaryAttach1).toBe(expected.primaryAttach1);
      expect(cls.primaryAttach2).toBe(expected.primaryAttach2);
      expect(cls.primaryCamo).toBe(expected.primaryCamo);
      expect(cls.secondaryWeapon).toBe(expected.secondaryWeapon);
      expect(cls.secondaryAttach1).toBe(expected.secondaryAttach1);
      expect(cls.secondaryAttach2).toBe(expected.secondaryAttach2);
      expect(cls.secondaryCamo).toBe(expected.secondaryCamo);
      expect(cls.equipment).toBe(expected.equipment);
      expect(cls.specialGrenade).toBe(expected.specialGrenade);
      expect(cls.perk1).toBe(expected.perk1);
      expect(cls.perk2).toBe(expected.perk2);
      expect(cls.perk3).toBe(expected.perk3);
      expect(cls.deathstreak).toBe(expected.deathstreak);
      expect(cls.inUse).toBe(true);
    });
  });

  it('golden cases del editor: camo desert (#5), gold (#9), akimbo (#8), riotshield (#4), OMA como secundaria (#3/#6)', () => {
    const classes = result.classes!;
    expect(classes[5]!.primaryCamo).toBe('desert');
    expect(classes[5]!.primaryWeapon).toBe('famas');
    expect(classes[9]!.secondaryCamo).toBe('gold');
    expect(classes[9]!.secondaryWeapon).toBe('deserteaglegold');
    expect(classes[8]!.secondaryAttach1).toBe('akimbo');
    expect(classes[4]!.primaryWeapon).toBe('riotshield');
    expect(classes[4]!.secondaryAttach1).toBe('tactical'); // tactical knife
    expect(classes[3]!.secondaryWeapon).toBe('onemanarmy');
    expect(classes[6]!.secondaryWeapon).toBe('onemanarmy');
    expect(classes[7]!.primaryWeapon).toBe('peacekeeper'); // custom IW4x
    expect(classes[9]!.primaryWeapon).toBe('ak47classic'); // custom IW4x
    expect(classes[11]!.secondaryWeapon).toBe('stinger'); // lanzador
    expect(classes[14]!.secondaryWeapon).toBe('javelin'); // lanzador
  });

  it('invariante del fixture real: primaryWeapon/secondaryWeapon ≠ none en las 15', () => {
    for (const cls of result.classes!) {
      expect(cls.primaryWeapon).not.toBe('none');
      expect(cls.secondaryWeapon).not.toBe('none');
    }
  });

  it('nombres con códigos de color ^N preservados EN CRUDO', () => {
    const classes = result.classes!;
    expect(classes[3]!.name).toBe('^2FAL Ninja');
    expect(classes[4]!.name).toBe('^1Cancer Riot');
    expect(classes[13]!.name).toBe('^4Scar-H Ninja');
  });
});

describe('parseConsoleLog — variantes del formato', () => {
  it('timestamps con y sin corchetes → resultado IDÉNTICO', () => {
    const conTs = parseConsoleLog(buildConsoleLogDump({ timestamps: true }));
    const sinTs = parseConsoleLog(buildConsoleLogDump({ timestamps: false }));
    expect(sinTs.classes).toEqual(conTs.classes);
    expect(sinTs.count).toBe(conTs.count);
  });

  it('console_mp.log ENTERO (basura alrededor de la sección) → mismo resultado', () => {
    const expected = parseConsoleLog(buildConsoleLogDump());
    const full = parseConsoleLog(wrapInFullConsoleLog(buildConsoleLogDump()));
    expect(full.classes).toEqual(expected.classes);
    expect(full.count).toBe(15);
  });

  it('dual attachment (Bling): primaryAttach1+2 distintos se leen bien', () => {
    const dump = [
      'customClasses',
      '  [0]',
      '    inUse\t= true',
      '    name\t= "^7Bling Pro"',
      '    weaponSetups',
      '      [0]',
      '        attachment',
      '          [0]\t= grip',
      '          [1]\t= fmj',
      '        camo\t= none',
      '        weapon\t= m1014',
    ].join('\n');
    const result = parseConsoleLog(dump);
    expect(result.count).toBe(1);
    expect(result.classes![0]!.name).toBe('^7Bling Pro');
    expect(result.classes![0]!.primaryAttach1).toBe('grip');
    expect(result.classes![0]!.primaryAttach2).toBe('fmj');
    expect(result.classes![0]!.primaryWeapon).toBe('m1014');
    expect(result.classes![0]!.secondaryWeapon).toBe('usp'); // default intacto
  });

  it('inUse=false y clase sin name/inUse → slot vacío VÁLIDO (defaults, sin errores)', () => {
    const dump = [
      'customClasses',
      '  [0]',
      '    inUse\t= false',
      '    name\t= "guardada"',
      '  [1]',
      '    _deathstreak\t= specialty_null',
    ].join('\n');
    const result = parseConsoleLog(dump);
    expect(result.count).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.classes![0]!.inUse).toBe(false);
    expect(result.classes![0]!.name).toBe('guardada');
    // Slot 1 existe en el dump pero sin name/inUse: slot vacío válido → default.
    expect(result.classes![1]!.inUse).toBe(false);
    expect(result.classes![1]!.name).toBe('Custom Class 2');
  });

  it('enums desconocidos (mods custom) se guardan TAL CUAL, sin validación', () => {
    const dump = [
      'customClasses',
      '  [0]',
      '    name\t= "Modder"',
      '    perks',
      '      [1]\t= specialty_custommod_perk',
      '    specialGrenade\t= acid_grenade_mod',
      '    weaponSetups',
      '      [0]',
      '        attachment',
      '          [0]\t= holographic_mod',
      '        camo\t= chromium_custom',
      '        weapon\t= mycustomgun_mod',
    ].join('\n');
    const result = parseConsoleLog(dump);
    expect(result.classes![0]!.primaryWeapon).toBe('mycustomgun_mod');
    expect(result.classes![0]!.primaryAttach1).toBe('holographic_mod');
    expect(result.classes![0]!.primaryCamo).toBe('chromium_custom');
    expect(result.classes![0]!.perk1).toBe('specialty_custommod_perk');
    expect(result.classes![0]!.specialGrenade).toBe('acid_grenade_mod');
  });

  it('sutileza 2: [N] = valor inline en la RAÍZ no crea clase ni se consume', () => {
    const dump = [
      'customClasses',
      '  [0]',
      '    name\t= "A"',
      '  [0]\t= ignorado',
      '  [1]',
      '    name\t= "B"',
    ].join('\n');
    const result = parseConsoleLog(dump);
    expect(result.count).toBe(2);
    expect(result.classes![0]!.name).toBe('A');
    expect(result.classes![1]!.name).toBe('B');
  });

  it('sutileza 6: specialGrenade resetea la sección (lo que viene después no se come como perks)', () => {
    const dump = [
      'customClasses',
      '  [0]',
      '    name\t= "X"',
      '    perks',
      '      [1]\t= specialty_scavenger',
      '    specialGrenade\t= flash_grenade',
      '    [2]\t= should_not_be_perk',
    ].join('\n');
    const result = parseConsoleLog(dump);
    expect(result.classes![0]!.specialGrenade).toBe('flash_grenade');
    expect(result.classes![0]!.perk1).toBe('specialty_scavenger');
    expect(result.classes![0]!.perk2).toBe('specialty_bulletdamage'); // default: NO consumió el inline posterior
  });

  it('árbol > CFG: si ambos aparecen, gana el árbol', () => {
    const dump = `${buildConsoleLogDump()}\nsetPlayerData customClasses 0 name "DE LA CFG"\n`;
    const result = parseConsoleLog(dump);
    expect(result.count).toBe(15);
    expect(result.classes![0]!.name).toBe('THE NOOB2');
  });
});

describe('parseConsoleLog — entradas inválidas y defaults', () => {
  it('texto sin customClasses ni setPlayerData → classes NULL (no es un dump)', () => {
    expect(parseConsoleLog('').classes).toBeNull();
    expect(parseConsoleLog('hola mundo\n nada que ver').classes).toBeNull();
    expect(parseConsoleLog('prestige = 3\nexperience = 100').classes).toBeNull();
  });

  it('customClasses vacío → 15 defaults con valores de producción (no armas inventadas)', () => {
    const result = parseConsoleLog('customClasses\n');
    expect(result.classes).toHaveLength(15);
    expect(result.count).toBe(0);
    const expected = getDefaultClass(0);
    expect(result.classes![0]).toEqual(expected);
    expect(result.classes![3]!.name).toBe('Custom Class 4');
    expect(result.classes![3]!.primaryWeapon).toBe('m4');
    expect(result.classes![3]!.secondaryWeapon).toBe('usp');
    expect(result.classes![3]!.inUse).toBe(false);
    expect(result.classes![3]!.equipment).toBe('frag_grenade_mp');
    expect(result.classes![3]!.specialGrenade).toBe('concussion_grenade');
    expect(result.classes![3]!.perk1).toBe('specialty_marathon');
    expect(result.classes![3]!.perk2).toBe('specialty_bulletdamage');
    expect(result.classes![3]!.perk3).toBe('specialty_heartbreaker');
    expect(result.classes![3]!.deathstreak).toBe('specialty_combathigh');
  });

  it('dump parcial (solo clases 0-2) → 15 slots: 3 parseadas + 12 defaults, count=3', () => {
    const result = parseConsoleLog(buildConsoleLogDump({ classes: FIXTURE_CLASSES.slice(0, 3) }));
    expect(result.count).toBe(3);
    expect(result.classes).toHaveLength(15);
    expect(result.classes![2]!.name).toBe('UMP Rush');
    expect(result.classes![3]!.name).toBe('Custom Class 4');
    expect(result.classes![14]!.inUse).toBe(false);
  });
});

describe('parseCfgLines (fallback setPlayerData)', () => {
  it('comandos CFG completos → clase con todos los campos; índice fuera de rango descartado', () => {
    const lines = [
      'setPlayerData customClasses 0 name "My Sniper Loadout"',
      'setPlayerData customClasses 0 inUse true',
      'setPlayerData customClasses 0 weaponSetups 0 weapon cheytac',
      'setPlayerData customClasses 0 weaponSetups 0 attachment 0 silencer',
      'setPlayerData customClasses 0 weaponSetups 0 attachment 1 heartbeat',
      'setPlayerData customClasses 0 weaponSetups 0 camo arctic',
      'setPlayerData customClasses 0 weaponSetups 1 weapon deserteagle',
      'setPlayerData customClasses 0 weaponSetups 1 attachment 0 akimbo',
      'setPlayerData customClasses 0 weaponSetups 1 camo gold',
      'setPlayerData customClasses 0 perks 0 claymore_mp',
      'setPlayerData customClasses 0 perks 1 specialty_bling',
      'setPlayerData customClasses 0 perks 2 specialty_hardline',
      'setPlayerData customClasses 0 perks 3 specialty_scrambler',
      'setPlayerData customClasses 0 perks 4 specialty_finalstand',
      'setPlayerData customClasses 0 specialGrenade smoke_grenade',
      'setPlayerData customClasses 15 name "OUT OF RANGE"',
    ];
    const result = parseConsoleLog(lines.join('\n'));
    expect(result.classes).toHaveLength(15);
    expect(result.count).toBe(1); // idx 15 fuera de rango
    expect(result.errors.join(' ')).toContain('15');

    const cls = result.classes![0]!;
    expect(cls.name).toBe('My Sniper Loadout'); // espacios entrecomillados OK
    expect(cls.inUse).toBe(true);
    expect(cls.primaryWeapon).toBe('cheytac');
    expect(cls.primaryAttach1).toBe('silencer');
    expect(cls.primaryAttach2).toBe('heartbeat');
    expect(cls.primaryCamo).toBe('arctic');
    expect(cls.secondaryWeapon).toBe('deserteagle');
    expect(cls.secondaryAttach1).toBe('akimbo');
    expect(cls.secondaryAttach2).toBe('none');
    expect(cls.secondaryCamo).toBe('gold');
    expect(cls.equipment).toBe('claymore_mp');
    expect(cls.perk1).toBe('specialty_bling');
    expect(cls.perk2).toBe('specialty_hardline');
    expect(cls.perk3).toBe('specialty_scrambler');
    expect(cls.deathstreak).toBe('specialty_finalstand');
    expect(cls.specialGrenade).toBe('smoke_grenade');
  });

  it('mode CFG se activa SOLO con líneas setPlayerData customClasses (sin sección árbol)', () => {
    const result = parseConsoleLog('setPlayerData customClasses 4 name "Clase Cinco"\n');
    expect(result.classes![4]!.name).toBe('Clase Cinco');
    expect(result.classes![4]!.slot).toBe(4);
    expect(result.count).toBe(1);
  });
});

// ── Endpoint POST /api/players/classes + exposición GET /api/players/:guid ──

const GUID_MAIN = '341831007923465200';
const GUID_OLD = '341831007923465201';
const GUID_RECENT = '341831007923465202';

let owner: TestUser;
let noIdentity: TestUser;
let multi: TestUser;
let unlinkedGuidOwner: TestUser;

beforeAll(async () => {
  await resetDb();
  owner = await registerUser('classes-owner@test.local', 'supersecret123', 'Classes Owner');
  noIdentity = await registerUser('classes-noid@test.local', 'supersecret123', 'Classes NoId');
  multi = await registerUser('classes-multi@test.local', 'supersecret123', 'Classes Multi');
  unlinkedGuidOwner = await registerUser('classes-unlinked@test.local', 'supersecret123', 'Classes Unlinked');

  await prisma.player.create({ data: { guid: GUID_MAIN, name: 'MainPc' } });
  await prisma.accountLink.create({ data: { userId: owner.id, guid: GUID_MAIN } });

  await prisma.player.create({ data: { guid: GUID_OLD, name: 'OldPc', lastConnection: new Date('2026-01-01T00:00:00Z') } });
  await prisma.player.create({ data: { guid: GUID_RECENT, name: 'NewPc', lastConnection: new Date('2026-11-01T00:00:00Z') } });
  await prisma.accountLink.create({ data: { userId: multi.id, guid: GUID_OLD } });
  await prisma.accountLink.create({ data: { userId: multi.id, guid: GUID_RECENT } });
});

describe('POST /api/players/classes', () => {
  it('sin token → 401', async () => {
    const res = await req().post('/api/players/classes').send({ dumpText: buildConsoleLogDump() });
    expect(res.status).toBe(401);
  });

  it('400 VALIDATION_ERROR sin dumpText / vacío / campos extra', async () => {
    for (const body of [{}, { dumpText: '' }, { dumpText: buildConsoleLogDump(), extra: true }]) {
      const res = await req().post('/api/players/classes').set('Authorization', `Bearer ${owner.token}`).send(body);
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('400 CLASSES_NOT_FOUND si el texto no contiene la sección', async () => {
    const res = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ dumpText: 'esto no es un dump de clases\nprestige = 3' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('CLASSES_NOT_FOUND');
  });

  it('400 SIN_IDENTITY si la cuenta no tiene guids vinculados', async () => {
    const res = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${noIdentity.token}`)
      .send({ dumpText: buildConsoleLogDump() });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('SIN_IDENTITY');
  });

  it('1 guid vinculado: parsea el dump completo, guarda 15 clases y responde shape completo', async () => {
    const res = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ dumpText: buildConsoleLogDump() });
    expect(res.status).toBe(200);
    const body = res.body as { guid: string; count: number; classesUpdatedAt: string; classes: ParsedLoadoutClass[] };
    expect(body.guid).toBe(GUID_MAIN);
    expect(body.count).toBe(15);
    expect(body.classes).toHaveLength(15);
    expect(body.classes[0]!.name).toBe('THE NOOB2');
    expect(body.classes[9]!.secondaryCamo).toBe('gold');
    expect(new Date(body.classesUpdatedAt).toISOString()).toBe(body.classesUpdatedAt);

    const dbRow = await prisma.player.findUniqueOrThrow({ where: { guid: GUID_MAIN } });
    expect(dbRow.classesJson).not.toBeNull();
    const stored = JSON.parse(dbRow.classesJson!) as ParsedLoadoutClass[];
    expect(stored).toHaveLength(15);
    expect(stored[0]!.primaryWeapon).toBe('ump45');
    expect(dbRow.classesUpdatedAt).not.toBeNull();
  });

  it('el dump puede ser el console_mp.log ENTERO (basura alrededor)', async () => {
    const res = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ dumpText: wrapInFullConsoleLog(buildConsoleLogDump()) });
    expect(res.status).toBe(200);
    expect((res.body as { count: number }).count).toBe(15);
  });

  it('N guids vinculados → guarda en el de lastConnection MÁS RECIENTE', async () => {
    const res = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${multi.token}`)
      .send({ dumpText: buildConsoleLogDump() });
    expect(res.status).toBe(200);
    expect((res.body as { guid: string }).guid).toBe(GUID_RECENT);

    const recent = await prisma.player.findUniqueOrThrow({ where: { guid: GUID_RECENT } });
    expect(recent.classesJson).not.toBeNull();
    const old = await prisma.player.findUniqueOrThrow({ where: { guid: GUID_OLD } });
    expect(old.classesJson).toBeNull();
  });

  it('re-post SOBREESCRIBE las clases (nuevo dump gana) y refresca classesUpdatedAt', async () => {
    const first = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ dumpText: buildConsoleLogDump() });
    const firstAt = (first.body as { classesUpdatedAt: string }).classesUpdatedAt;

    const renamed = buildConsoleLogDump({ classes: [{ ...FIXTURE_CLASSES[0]!, name: 'RENOMBRADA' }] });
    const second = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ dumpText: renamed });
    expect(second.status).toBe(200);
    expect((second.body as { classesUpdatedAt: string }).classesUpdatedAt >= firstAt).toBe(true);

    const profile = await req().get(`/api/players/${GUID_MAIN}`);
    const player = (profile.body as { player: { classes: ParsedLoadoutClass[] } }).player;
    expect(player.classes![0]!.name).toBe('RENOMBRADA');
  });
});

describe('GET /api/players/:guid — exposición de clases', () => {
  it('expone classes (15) + classesUpdatedAt en el player del perfil', async () => {
    // Autocontenido: sube el dump completo ANTES de leer el perfil (otros tests
    // pueden haber sobreescrito con dumps parciales).
    const put = await req()
      .post('/api/players/classes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ dumpText: buildConsoleLogDump() });
    expect(put.status).toBe(200);

    const res = await req().get(`/api/players/${GUID_MAIN}`);
    expect(res.status).toBe(200);
    const player = (res.body as { player: { classes: ParsedLoadoutClass[] | null; classesUpdatedAt: string | null } }).player;
    expect(player.classes).toHaveLength(15);
    expect(player.classes![5]!.primaryCamo).toBe('desert');
    expect(player.classes![5]!.perk3).toBe('specialty_bulletaccuracy');
    expect(player.classes![9]!.secondaryCamo).toBe('gold');
    expect(new Date(player.classesUpdatedAt!).toISOString()).toBe(player.classesUpdatedAt);
  });

  it('jugador SIN clases subidas → classes null + classesUpdatedAt null (200 normal)', async () => {
    const created = await prisma.player.create({ data: { guid: '341831007923465299', name: 'SinClases' } });
    const res = await req().get(`/api/players/${created.guid}`);
    expect(res.status).toBe(200);
    const player = (res.body as { player: { classes: ParsedLoadoutClass[] | null; classesUpdatedAt: string | null } }).player;
    expect(player.classes).toBeNull();
    expect(player.classesUpdatedAt).toBeNull();
  });
});
