import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig, restartServer, updateServerConfig } from '../src/services/serverconfig.service.js';
import { registerUser } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures', 'server.cfg');
const WORK = resolve(here, 'data', 'work-server.cfg'); // copia editable (tests/data está en .gitignore)

const savedEnv: Record<string, string | undefined> = {
  SERVER_CFG_PATH: process.env.SERVER_CFG_PATH,
  ALLOW_SERVER_CONTROL: process.env.ALLOW_SERVER_CONTROL,
  SERVER_RESTART_COMMAND: process.env.SERVER_RESTART_COMMAND,
};

function useWorkCopy(): void {
  mkdirSync(dirname(WORK), { recursive: true });
  copyFileSync(FIXTURE, WORK);
  process.env.SERVER_CFG_PATH = WORK;
}

beforeAll(async () => {
  await registerUser('cfg-admin@test.local'); // no interfiere: los tests de servicio van directos
});

beforeEach(() => {
  useWorkCopy();
  delete process.env.ALLOW_SERVER_CONTROL;
  delete process.env.SERVER_RESTART_COMMAND;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(WORK, { force: true });
  // Limpieza de backups/tmp generados por los PUT.
  const dir = dirname(WORK);
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (file.startsWith('work-server.cfg.bak-') || file.startsWith('.server.cfg.tmp-')) {
        rmSync(resolve(dir, file), { force: true });
      }
    }
  }
});

describe('GET server-config (parseo del cfg oficial)', () => {
  it('extrae hostname, motd, gametype, maxclients, logfile/g_log, bots y rotación', async () => {
    const config = await getServerConfig();

    expect(config.hostname).toBe('^7[^1RANKING^7] ^7Test Fixture');
    expect(config.motd).toBe('Bienvenidos al ranking');
    expect(config.gametype).toBe('war');
    expect(config.maxclients).toBe(12);
    expect(config.logfile).toBe(2);
    expect(config.g_log).toBe('logs/games_mp.log');
    expect(config.bots).toBe(4);

    expect(config.rotation).toEqual([
      { map: 'mp_rust', gametype: 'war' },
      { map: 'mp_terminal', gametype: 'war' },
      { map: 'mp_shipment', gametype: 'dm' },
    ]);

    expect(config.metadata.path.toLowerCase()).toBe(WORK.toLowerCase());
    expect(typeof config.metadata.lastModified).toBe('string');
    expect(config.metadata.sizeBytes).toBeGreaterThan(0);
  });

  it('enmascara rcon/password y expone unknownLines intactas', async () => {
    const config = await getServerConfig();

    expect(config.rconSet).toBe(true);
    expect(config.rcon).toBe('se••••45'); // 2 primeros + 2 últimos, nunca el valor completo
    expect(config.rcon).not.toContain('creto');
    expect(config.passwordSet).toBe(false);
    expect(config.password).toBeNull();

    expect(config.unknownLines).toEqual([
      'seta g_logSync "1"                               // 1 always flush games_mp.log',
      'set sv_securityLevel "23"',
      'set g_inactivity "300"',
      'seta custom_thing "abc"',
      'map_rotate',
    ]);
  });

  it('503 SERVER_CFG_NOT_CONFIGURED sin env y 503 SERVER_CFG_NOT_FOUND si no existe', async () => {
    delete process.env.SERVER_CFG_PATH;
    await expect(getServerConfig()).rejects.toMatchObject({ code: 'SERVER_CFG_NOT_CONFIGURED' });

    process.env.SERVER_CFG_PATH = resolve(here, 'data', 'no-existe.cfg');
    await expect(getServerConfig()).rejects.toMatchObject({ code: 'SERVER_CFG_NOT_FOUND' });
  });
});

describe('PUT server-config (regeneración con backup y escritura atómica)', () => {
  it('actualiza hostname/maxclients preservando comentarios, desconocidas y map_rotate', async () => {
    const result = await updateServerConfig({ hostname: '^7[^1RANKING^7] ^7Renombrado', maxclients: 20 });
    expect(result.saved).toBe(true);
    expect(result.restarted).toBe(false); // sin ALLOW_SERVER_CONTROL
    expect(result.warnings.join(' ')).toContain('ALLOW_SERVER_CONTROL');
    expect(existsSync(result.backupPath)).toBe(true);
    expect(result.backupPath).toMatch(/\.bak-/);

    const content = readFileSync(WORK, 'utf8');
    expect(content).toContain('set sv_hostname "^7[^1RANKING^7] ^7Renombrado"        // Sets the server hostname');
    expect(content).toContain('seta sv_maxclients "20"');
    // Preservados:
    expect(content).toContain('set sv_securityLevel "23"');
    expect(content).toContain('seta custom_thing "abc"');
    expect(content).toContain('map_rotate');
    expect(content).toContain('set rcon_password "secreto-12345"');
    // Sin archivos temporales remanentes
    expect(existsSync(`${WORK}.tmp`)).toBe(false);
    expect(readFileSync(WORK, 'utf8')).not.toMatch(/\.tmp-/);
  });

  it('regenera el bloque de rotación (addGametype/addMap)', async () => {
    await updateServerConfig({
      rotation: [
        { map: 'mp_rust', gametype: 'war' },
        { map: 'mp_strike', gametype: 'war' },
        { map: 'mp_dome', gametype: 'dm' },
      ],
    });

    const content = readFileSync(WORK, 'utf8');
    expect(content).toContain('addGametype war');
    expect(content).toContain('addMap mp_strike');
    expect(content).toContain('addGametype dm');
    expect(content).toContain('addMap mp_dome');
    expect(content).not.toContain('addMap mp_terminal'); // rotación vieja eliminada
    expect(content).not.toContain('addMap mp_shipment');
  });

  it('reconoce el eco enmascarado como "sin cambio" y acepta valores nuevos/limpieza', async () => {
    await updateServerConfig({ rcon: 'se••••45', password: 'nueva-clave-99' });
    let content = readFileSync(WORK, 'utf8');
    expect(content).toContain('set rcon_password "secreto-12345"'); // eco = sin cambio
    expect(content).toContain('set g_password "nueva-clave-99"');

    await updateServerConfig({ rcon: null, password: null });
    content = readFileSync(WORK, 'utf8');
    expect(content).toContain('set rcon_password ""');
    expect(content).toContain('set g_password ""');
  });

  it('añade dvars pedidas que no estaban en el archivo (sección PANEL)', async () => {
    await updateServerConfig({ bots: 6 });
    const content = readFileSync(WORK, 'utf8');
    expect(content).toContain('seta scr_testclients "6"'); // sí existía: sustituida en su línea
    expect(content).toContain('set sv_motd'); // original intacto

    // sv_wwwDownload no existe en el fixture → no editable vía schema; probamos con
    // una dvar editable ausente: quitamos la línea de bots del fixture temporalmente.
    const original = readFileSync(FIXTURE, 'utf8').replace(/seta scr_testclients "4"\r?\n/, '');
    mkdirSync(dirname(WORK), { recursive: true });
    writeFileSync(WORK, original, 'utf8');

    await updateServerConfig({ bots: 2 });
    const content2 = readFileSync(WORK, 'utf8');
    expect(content2).toContain('==== CONFIG EDITADA DESDE EL PANEL');
    expect(content2).toContain('set scr_testclients "2"');
  });

  it('valida rangos y campos: 400 con maxclients fuera de rango, bots>maxclients y claves desconocidas', async () => {
    await expect(updateServerConfig({ maxclients: 99 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateServerConfig({ maxclients: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateServerConfig({ bots: 30 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // > maxclients (12)
    await expect(updateServerConfig({ hostname: 'con "comillas" dentro' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(updateServerConfig({ unknownLines: ['quit -9'] } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // strict: no acepta líneas crudas
    await expect(updateServerConfig({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // body vacío
    // El cfg quedó intacto tras los errores.
    expect(readFileSync(WORK, 'utf8')).toContain('seta sv_maxclients "12"');
  });

  it('PUT con ALLOW_SERVER_CONTROL=1 pero sin comando → guardado con warning y sin restart', async () => {
    process.env.ALLOW_SERVER_CONTROL = '1';
    const result = await updateServerConfig({ motd: 'Con control activo' });
    expect(result.saved).toBe(true);
    expect(result.restarted).toBe(false);
    expect(result.warnings.join(' ')).toContain('SERVER_RESTART_COMMAND');
    expect(readFileSync(WORK, 'utf8')).toContain('set sv_motd "Con control activo"');
  });

  it('PUT con flag+comando reinicia tras guardar (comando benigno inyectado para test)', async () => {
    process.env.ALLOW_SERVER_CONTROL = '1';
    // El PUT usa restartDedicatedServerInternal (comando del env): usamos `node` como comando seguro.
    process.env.SERVER_RESTART_COMMAND = 'node -e "process.stdout.write(\'ok\')"';

    const result = await updateServerConfig({ motd: 'Con restart' });
    expect(result.restarted).toBe(true);
  });
});

describe('POST /api/admin/server/restart (guard de seguridad)', () => {
  it('403 FORBIDDEN sin ALLOW_SERVER_CONTROL (nunca ejecuta nada)', async () => {
    delete process.env.ALLOW_SERVER_CONTROL;
    process.env.SERVER_RESTART_COMMAND = 'echo nunca-debe-ejecutarse';
    await expect(restartServer()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('403 FORBIDDEN con flag pero sin SERVER_RESTART_COMMAND', async () => {
    process.env.ALLOW_SERVER_CONTROL = '1';
    delete process.env.SERVER_RESTART_COMMAND;
    await expect(restartServer()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('con flag+comando ejecuta y devuelve restarted=true', async () => {
    process.env.ALLOW_SERVER_CONTROL = '1';
    const result = await restartServer('node -e "process.stdout.write(\'restarted\')"');
    expect(result.restarted).toBe(true);
  });
});
