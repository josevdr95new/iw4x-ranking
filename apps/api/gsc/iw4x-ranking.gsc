// iw4x-ranking.gsc v4 — script SERVER-SIDE para el server dedicado IW4x (AlterWare).
//
// Qué hace: cada ~60s escribe un SNAPSHOT (no append) con las stats de
// progresión de los jugadores HUMANOS conectados a:
//     <raíz del juego>/userraw/scriptdata/iw4x-ranking.json
// (FileWrite antepone "scriptdata/" si falta y resuelve relativo a userraw;
// ver src/Components/Modules/GSC/IO.cpp de iw4x-client: BuildPath +
// DefaultDestPath = "userraw"). La API ingiere ese archivo (env
// LIVE_STATS_FILE) para LVL en vivo y detección de unlockstats.
//
// ✅ CAMBIO v4 — ÍNDICES CALIBRADOS EMPÍRICAMENTE (calib-analyze.mjs sobre el
//  dump real del dueño "admin" en partida: 3 ciclos, 215 valores no-cero,
//  evidencia 2026-11-08, userraw/scriptdata/iw4x-ranking-calib.txt):
//   · XP    = GetStat( 2266 ) — valor 5120 estable y creciente con el juego;
//     su nivel derivado = 4 = Private First Class, COINCIDE con su Barracks.
//   · KILLS = GetStat( 2059 ) — valor 14, EXACTO a sus kills de la sesión.
//   · deaths / wins / losses / headshots: AMBIGUOS — los índices
//     {2490, 2511, 2515, 2556, 2572, 2593, 2594, 3205} valen TODOS 1 y calzan
//     con varios contadores a la vez → NO se leen en el snapshot principal
//     (nada inventado; se desambiguan con el DIFF de abajo).
// Con esos dos índices la línea principal vuelve a llevar datos REALES:
//   #iw4x-ranking v4
//   <guid>;<xp>;<kills>;<name>
// La ingesta (src/services/livestats.service.ts) acepta el formato v4 de 4
// campos Y el legacy v2 de 8 (guid;xp;prestigio;kills;deaths;hs;tp;name),
// autodetectado por cabecera/cantidad de campos. Sanity: XP 0..2516000,
// kills 0..10M. LVL se DERIVA de XP (levelFromXp) — no se lee índice de nivel.
//
// 📡 DIFF DE DESAMBIGUACIÓN (nuevo en v4, el dump de calibración SIGUE activo):
//  Por cada ciclo se compara el valor de cada índice CANDIDATO del grupo =1
//  contra el valor del CICLO ANTERIOR (memoria del hilo/level; se resetea por
//  carga de mapa — la desambiguación ocurre DENTRO de una partida, donde
//  mueres/HS/victorias ocurren). Cuando un candidato CAMBIA:
//      [iw4x-ranking] >>> CALIB-DIFF: idx N paso de A a B <<<
//  queda en games_mp.log (logPrint) y scriptdata/iw4x-ranking-debug.log
//  (append). Con la próxima muerte/HS del dueño se identifica el índice exacto
//  SIN análisis manual: el índice que cambie justo cuando él reporta la acción
//  es el bueno (p.ej. si muere una vez y SOLO idx 2556 pasa de 1 a 2 → 2556 =
//  deaths).
//
// HEREDADO de v3 (sigue igual en v4):
//  1) AISLAMIENTO DE ERRORES: el bucle principal lanza CADA ciclo en un HILO
//     HIJO (`thread iw4xranking_dump_once()`). En GSC un error de runtime
//     (Scr_Error) MATA EL HILO donde ocurre; antes mataba al hilo del bucle y
//     el archivo quedaba congelado hasta la próxima carga de mapa. Ahora el
//     bucle padre SOBREVIVE y el siguiente ciclo reintenta. El dump de
//     calibración es ADEMÁS otro hilo hijo propio: un Scr_Error de GetStat
//     (carrera de desconexión a mitad de los 1498 índices) mata SOLO ese
//     dump; el ciclo sigue y el snapshot principal se escribe igual. Los 8
//     reads del DIFF van PRIMERO dentro del dump: si el jugador se desconecta
//     a mitad, los candidatos ya se procesaron y el diff del ciclo no se pierde.
//  2) FILTRO DE BOTS NATIVO: iw4x registra el método GSC `IsBot()`/
//     `IsTestClient()` (Bots.cpp AddScriptMethods → SV_IsTestClient). Se usa
//     como filtro primario y `issubstr(getguid()+"","bot")` queda como
//     fallback (así detecta bots Bot Warfare en _bot_utility.gsc:227).
//  3) FUENTE DE JUGADORES CON FALLBACK: `level.players` primero; si no está
//     definida o vacía, `getentarray("player","classname")` (builtin stock,
//     usado por Bot Warfare _bot_utility.gsc:3428).
//  4) DEBUG NIVEL LOG BAJO (dejar en producción): cada ciclo escribe una
//     línea por jugador con sus decisiones en DOS canales:
//       · `logPrint` → games_mp.log (logfile 2, g_logSync 1; console_mp.log
//         NO se escribe en dedicated — queda a 0 bytes).
//       · filewrite append → userraw/scriptdata/iw4x-ranking-debug.log
//         (se REINICIA en cada carga de mapa; rotación de ~10 min del server
//         lo mantiene pequeño).
//
// VERIFICADO contra iw4x-client (master, nov-2026) + Bot Warfare ineedbots:
//  - GetStat: método de la ENTIDAD player, índices 0..3499 (Stats.cpp);
//    SV_GetClientStat (Game/Server.cpp) solo tiene asserts (NDEBUG en release
//    → compilan fuera); el único error GSC posible es el de disconnected.
//  - getguid(): builtin stock; humanos → int (hex→decimal al concatenar ""),
//    bots → string con "bot"; Bot Warfare lo usa así en producción.
//  - filewrite(<path>, <data>, <mode>): modo "write" = reescritura atómica
//    ÚNICA (Utils::IO::WriteFile), modo "append" soportado.
//  - Iteración de players: for (i = 0; i < players.size; i++) — mismo estilo
//    de _bot_utility.gsc:953. `&&`/`||` cortocircuitan (L975) y `\n` es
//    escape válido en literales (L1247).
//
// INSTALACIÓN: copiar a  <raíz del juego>/userraw/scripts/iw4x-ranking.gsc
// ACTIVACIÓN: el server carga scripts por CARGA DE MAPA (GSC/Script.cpp
//     GScr_LoadGameTypeScript_Stub → LoadCustomScripts; init se ejecuta en
//     Scr_StartupGameType_Stub). El server rota mapa solo (~10:30 min de
//     sv_mapRotation) o vía map_rotate desde el panel: NO hace falta
//     reiniciar; un fast_restart NO recarga el VM de GSC.

init()
{
    // DIFF de calibración: valor previo por índice CANDIDATO del grupo =1
    // (-1 = aún sin ciclo previo → el primer ciclo nunca difama). Memoria
    // level: se resetea con la carga de mapa (por diseño, ver cabecera v4).
    level.iw4xranking_prev2490 = -1;
    level.iw4xranking_prev2511 = -1;
    level.iw4xranking_prev2515 = -1;
    level.iw4xranking_prev2556 = -1;
    level.iw4xranking_prev2572 = -1;
    level.iw4xranking_prev2593 = -1;
    level.iw4xranking_prev2594 = -1;
    level.iw4xranking_prev3205 = -1;

    // Dump de CALIBRACIÓN activo (region 2000..3497 + DIFF de candidatos).
    // Se puede poner a 0 cuando deaths/wins/losses/hs queden calibrados.
    level.iw4xranking_calib = 1;
    level.iw4xranking_cycle = 0;

    // Reinicia los logs en cada carga de mapa (archivos acotados).
    filewrite( "scriptdata/iw4x-ranking-debug.log", "[iw4x-ranking] init v4: script cargado en esta carga de mapa\n", "write" );
    filewrite( "scriptdata/iw4x-ranking-calib.txt", "#iw4x-ranking-calib v1\n", "write" );
    iw4xranking_log( "init v4 ok: snapshot guid;xp(2266);kills(2059);name + calib dump ON con DIFF candidatos {2490,2511,2515,2556,2572,2593,2594,3205}" );
    level thread iw4xranking_dump_loop();
}

// Log de diagnóstico a DOS canales: games_mp.log (logPrint) y
// scriptdata/iw4x-ranking-debug.log (append). Nivel bajo: 1-20 líneas/min.
iw4xranking_log( msg )
{
    logline = "[iw4x-ranking] " + msg;
    logPrint( logline + "\n" );
    filewrite( "scriptdata/iw4x-ranking-debug.log", logline + "\n", "append" );
}

// Bucle periódico: primer dump a los ~5s de cargar el mapa, luego cada 60s.
// CADA ciclo corre en HILO HIJO: un Scr_Error (p.ej. GetStat sobre un jugador
// que se desconectó a mitad del dump) mata SOLO al hijo; el padre reintenta.
iw4xranking_dump_loop()
{
    wait 5;
    for ( ;; )
    {
        thread iw4xranking_dump_once();
        wait 60;
    }
}

// Un ciclo: recorre los jugadores y escribe el SNAPSHOT v4 con los índices
// CALIBRADOS (XP=2266, KILLS=2059). Formato (una línea por jugador; name al
// FINAL para tolerar ';' en el nick):
//   #iw4x-ranking v4
//   <guid>;<xp>;<kills>;<name>
// Sin humanos conectados el archivo queda solo con la cabecera (snapshot vacío).
// NOTA v4: deaths/headshots/timePlayed/prestigio NO se leen (índices sin
// calibrar; el grupo =1 se desambigua con CALIB-DIFF). La ingesta los deja a
// null/placeholder y NO pisa el prestige guardado por el cloud save.
iw4xranking_dump_once()
{
    contents = "#iw4x-ranking v4";
    humans = 0;
    bots = 0;

    // Fuente de jugadores con fallback (ver cabecera, cambio v2.3).
    players = undefined;
    source = "ninguna";
    if ( isdefined( level.players ) && level.players.size > 0 )
    {
        players = level.players;
        source = "level.players";
    }
    else
    {
        fallback = getentarray( "player", "classname" );
        if ( isdefined( fallback ) && fallback.size > 0 )
        {
            players = fallback;
            source = "getentarray";
        }
    }

    if ( !isdefined( players ) )
    {
        lpState = "NO definida";
        if ( isdefined( level.players ) )
        {
            lpState = "definida/vacia";
        }
        iw4xranking_log( "ciclo: 0 jugadores (level.players=" + lpState + ", getentarray vacio); escribo cabecera" );
        filewrite( "scriptdata/iw4x-ranking.json", contents, "write" );
        return;
    }

    iw4xranking_log( "ciclo inicio: fuente=" + source + " total=" + players.size + " calib=" + level.iw4xranking_calib );

    for ( i = 0; i < players.size; i++ )
    {
        player = players[ i ];

        // Defensivo: un cliente puede desconectarse a mitad del dump.
        if ( !isdefined( player ) )
        {
            iw4xranking_log( "slot " + i + ": undefined (skip)" );
            continue;
        }

        pname = "";
        if ( isdefined( player.name ) )
        {
            pname = player.name;
        }

        // BOTS FUERA (filtro NATIVO de iw4x: Bots.cpp IsBot → SV_IsTestClient).
        if ( player IsBot() )
        {
            bots += 1;
            iw4xranking_log( "slot " + i + ": bot \"" + pname + "\" (skip)" );
            continue;
        }

        guid = player getguid() + "";

        // Fallback del filtro por guid (formato "botN"; _bot_utility.gsc:227).
        if ( issubstr( guid, "bot" ) )
        {
            bots += 1;
            iw4xranking_log( "slot " + i + ": guid \"" + guid + "\"=bot (skip)" );
            continue;
        }

        if ( !isdefined( guid ) || guid == "" )
        {
            iw4xranking_log( "slot " + i + ": sin guid (skip) nombre=\"" + pname + "\"" );
            continue;
        }

        if ( pname == "" )
        {
            iw4xranking_log( "slot " + i + ": guid " + guid + " sin name (skip)" );
            continue;
        }

        humans += 1;

        // Dump de CALIBRACIÓN en HILO HIJO propio: un Scr_Error de GetStat a
        // mitad mata SOLO el dump (el snapshot principal se escribe igual).
        if ( level.iw4xranking_calib )
        {
            iw4xranking_log( "slot " + i + ": humano \"" + pname + "\" guid=" + guid + " -> calib dump + DIFF" );
            thread iw4xranking_calib_dump( player, guid, pname );
        }

        // LECTURA NORMAL (v4): SOLO índices calibrados empíricamente.
        // GetStat (Stats.cpp): INICIO de la zona que puede Scr_Error si el
        // jugador se desconecta AHORA MISMO. Si pasa, muere SOLO este hilo
        // hijo (el bucle padre reintenta el ciclo completo).
        iw4xranking_log( "slot " + i + ": humano \"" + pname + "\" guid=" + guid + " leyendo GetStat..." );

        xp = player GetStat( 2266 );    // ✅ CALIBRADO: career XP (Barracks ok)
        kills = player GetStat( 2059 ); // ✅ CALIBRADO: career kills (exacto)

        contents = contents + "\n" + guid + ";" + xp + ";" + kills + ";" + pname;
        iw4xranking_log( "slot " + i + ": linea OK xp=" + xp + " kills=" + kills );
    }

    // ÚNICA escritura atómica del snapshot completo (IO.cpp FileWrite).
    filewrite( "scriptdata/iw4x-ranking.json", contents, "write" );
    iw4xranking_log( "ciclo fin: total=" + players.size + " humanos=" + humans + " bots=" + bots + " bytes=" + contents.size );
}

// DIFF de desambiguación para UN índice candidato: lo lee AHORA, lo compara
// con el valor del ciclo anterior (prev; -1 = primer ciclo → nunca difama) y
// si CAMBIÓ lo loguea DESTACADO en ambos canales. Devuelve el valor leído
// (el caller lo guarda en level.iw4xranking_prev<idx> para el próximo ciclo).
// Nota: los valores previos son GLOBALES por índice (no por guid): asume 1
// humano en calibración (server privado del dueño — es el caso de uso).
iw4xranking_cand_diff( player, idx, prev )
{
    val = player GetStat( idx );
    if ( prev != -1 && val != prev )
    {
        iw4xranking_log( ">>> CALIB-DIFF: idx " + idx + " paso de " + prev + " a " + val + " <<<" );
    }
    return val;
}

// DUMP DE CALIBRACIÓN (v4): 1) DIFF de los 8 candidatos del grupo =1 (muerte/
// HS/victoria del dueño → cambia uno y queda identificado en el log), y
// 2) lectura de GetStat en TODA la región int32 del buffer server-side
// (índices 2000..3497; fórmula índice→offset 2004+4*(i-2000)) con APPEND a
// scriptdata/iw4x-ranking-calib.txt de un bloque:
//     #cycle <n> guid=<guid> name=<nombre>
//     <index>;<valor>          (solo valores != 0, para reducir ruido)
// Los bloques se acumulan DENTRO de una carga de mapa (crecimiento entre
// ciclos); el archivo se reinicia en cada init() (acotado).
// Corre en HILO HIJO propio: si el jugador se desconecta a mitad de los 1498
// GetStat, el Scr_Error mata SOLO este hilo (el ciclo y el bucle padre viven).
// Los reads del DIFF van PRIMERO: si hay desconexión, los candidatos ya
// fueron procesados y el diff de este ciclo no se pierde.
iw4xranking_calib_dump( player, guid, pname )
{
    level.iw4xranking_cycle += 1;
    cycle = level.iw4xranking_cycle;

    // 1) DIFF de candidatos (grupo =1: deaths/wins/losses/headshots).
    level.iw4xranking_prev2490 = iw4xranking_cand_diff( player, 2490, level.iw4xranking_prev2490 );
    level.iw4xranking_prev2511 = iw4xranking_cand_diff( player, 2511, level.iw4xranking_prev2511 );
    level.iw4xranking_prev2515 = iw4xranking_cand_diff( player, 2515, level.iw4xranking_prev2515 );
    level.iw4xranking_prev2556 = iw4xranking_cand_diff( player, 2556, level.iw4xranking_prev2556 );
    level.iw4xranking_prev2572 = iw4xranking_cand_diff( player, 2572, level.iw4xranking_prev2572 );
    level.iw4xranking_prev2593 = iw4xranking_cand_diff( player, 2593, level.iw4xranking_prev2593 );
    level.iw4xranking_prev2594 = iw4xranking_cand_diff( player, 2594, level.iw4xranking_prev2594 );
    level.iw4xranking_prev3205 = iw4xranking_cand_diff( player, 3205, level.iw4xranking_prev3205 );

    // 2) Dump completo (igual que v3).
    out = "#cycle " + cycle + " guid=" + guid + " name=" + pname + "\n";
    nonzero = 0;
    for ( idx = 2000; idx <= 3497; idx++ )
    {
        val = player GetStat( idx );
        if ( val != 0 )
        {
            nonzero += 1;
            out = out + idx + ";" + val + "\n";
        }
    }

    filewrite( "scriptdata/iw4x-ranking-calib.txt", out, "append" );
    iw4xranking_log( "calib: " + nonzero + " valores no-cero (cycle " + cycle + " guid=" + guid + " name=" + pname + ")" );
}
