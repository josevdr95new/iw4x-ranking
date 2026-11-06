import { afterEach, describe, expect, it } from 'vitest';
import { getServersList } from '../src/services/servers.service.js';

const savedServerEnv = process.env.SERVERS;
const savedGameServer = process.env.GAME_SERVER_ADDRESS;

afterEach(() => {
  if (savedServerEnv === undefined) delete process.env.SERVERS;
  else process.env.SERVERS = savedServerEnv;
  if (savedGameServer === undefined) delete process.env.GAME_SERVER_ADDRESS;
  else process.env.GAME_SERVER_ADDRESS = savedGameServer;
});

describe('GET /api/servers (getServersList)', () => {
  it('usa SERVERS (JSON array) y respeta isDefault', () => {
    process.env.SERVERS = JSON.stringify([
      { name: 'LAN Server', address: '192.168.2.251:28960' },
      { name: 'Test Local', address: '192.168.3.99:28961', isDefault: true },
    ]);
    delete process.env.GAME_SERVER_ADDRESS;

    const res = getServersList();
    expect(res.source).toBe('env');
    expect(res.servers).toHaveLength(2);
    expect(res.servers[0]).toEqual({ name: 'LAN Server', address: '192.168.2.251:28960', isDefault: false });
    expect(res.servers[1]?.isDefault).toBe(true);
  });

  it('sin isDefault explícito, la primera es la default', () => {
    process.env.SERVERS = '[{"name":"A","address":"1.2.3.4:28960"},{"name":"B","address":"5.6.7.8:28961"}]';
    delete process.env.GAME_SERVER_ADDRESS;

    const res = getServersList();
    expect(res.source).toBe('env');
    expect(res.servers[0]?.isDefault).toBe(true);
    expect(res.servers[1]?.isDefault).toBe(false);
  });

  it('SERVERS inválido → fallback derivado de GAME_SERVER_ADDRESS', () => {
    process.env.SERVERS = 'no-soy-json';
    process.env.GAME_SERVER_ADDRESS = '192.168.3.99:28961';

    const res = getServersList();
    expect(res.source).toBe('derived');
    expect(res.servers).toEqual([{ name: 'Servidor del ranking', address: '192.168.3.99:28961', isDefault: true }]);
  });

  it('sin SERVERS: deriva de GAME_SERVER_ADDRESS', () => {
    delete process.env.SERVERS;
    process.env.GAME_SERVER_ADDRESS = '10.0.0.5:28960';

    const res = getServersList();
    expect(res.source).toBe('derived');
    expect(res.servers[0]?.address).toBe('10.0.0.5:28960');
    expect(res.servers[0]?.isDefault).toBe(true);
  });

  it('sin ninguna fuente → lista vacía', () => {
    delete process.env.SERVERS;
    delete process.env.GAME_SERVER_ADDRESS;

    const res = getServersList();
    expect(res.source).toBe('none');
    expect(res.servers).toEqual([]);
  });

  it('rechaza entradas mal formadas (address inválido) y cae al fallback', () => {
    process.env.SERVERS = '[{"name":"X","address":"no soy una direccion!!"}]';
    process.env.GAME_SERVER_ADDRESS = '192.168.3.99:28961';

    const res = getServersList();
    expect(res.source).toBe('derived');
  });
});
