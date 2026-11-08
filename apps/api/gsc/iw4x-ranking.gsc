// iw4x-ranking.gsc v2 — script SERVER-SIDE para el server dedicado IW4x (AlterWare).
//
// Qué hace: cada ~60s escribe un SNAPSHOT (no append) con las stats de
// progresión de los jugadores HUMANOS conectados a:
//     <raíz del juego>/userraw/scriptdata/iw4x-ranking.json
// (FileWrite antepone "scriptdata/" si falta y resuelve relativo a userraw;
// ver src/Components/Modules/GSC/IO.cpp de iw4x-client: BuildPath +
// DefaultDestPath = "userraw"). La API ingiere ese archivo (env
// LIVE_STATS_FILE) para LVL en vivo y detección de unlockstats.
//
// CAMBIOS v2 (fix del bug "solo cabecera, 0 líneas de jugador"):
//  1) AISLAMIENTO DE ERRORES: el bucle principal lanza CADA ciclo en un HILO
//     HIJO (`thread iw4xranking_dump_once()`). En GSC un error de runtime
//     (Scr_Error) MATA EL HILO donde ocurre; antes mataba al hilo del bucle y
//     el archivo quedaba congelado hasta la próxima carga de mapa. Ahora el
//     bucle padre SOBREVIVE y el siguiente ciclo reintenta. Fuente del error
//     conocido: Stats.cpp AddMethod("GetStat") hace Scr_Error("GetStat:
//     called on a disconnected player") si sess.connected <= CON_DISCONNECTED
//     (carrera de desconexión a mitad de dump).
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
    // Reinicia el log de debug en cada carga de mapa (archivo acotado).
    filewrite( "scriptdata/iw4x-ranking-debug.log", "[iw4x-ranking] init v2: script cargado en esta carga de mapa\n", "write" );
    iw4xranking_log( "init v2 ok: dump cada 60s (primer dump a los 5s)" );
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

// Un ciclo: construye el snapshot completo y REESCRIBE el archivo.
// Formato (una línea por jugador; name al FINAL para tolerar ';' en el nick):
//   #iw4x-ranking v1
//   <guid>;<xp>;<prestige>;<kills>;<deaths>;<headshots>;<timePlayed>;<name>
// Sin humanos conectados el archivo queda solo con la cabecera (snapshot vacío).
iw4xranking_dump_once()
{
    contents = "#iw4x-ranking v1";
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

    iw4xranking_log( "ciclo inicio: fuente=" + source + " total=" + players.size );

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

        // GetStat (Stats.cpp): ÍNICIO de la zona que puede Scr_Error si el
        // jugador se desconecta AHORA MISMO. Si pasa, muere SOLO este hilo
        // hijo (el bucle padre reintenta en el siguiente ciclo).
        iw4xranking_log( "slot " + i + ": humano \"" + pname + "\" guid=" + guid + " leyendo GetStat..." );

        xp = player GetStat( 2300 );        // experience (XP acumulada)
        prestige = player GetStat( 2325 );  // prestige
        kills = player GetStat( 2305 );     // career kills
        deaths = player GetStat( 2315 );    // career deaths
        headshots = player GetStat( 2321 ); // career headshots
        timePlayed = player GetStat( 2324 ); // timePlayedTotal (minutos)

        contents = contents + "\n" + guid + ";" + xp + ";" + prestige + ";" + kills + ";" + deaths + ";" + headshots + ";" + timePlayed + ";" + pname;
        humans += 1;
        iw4xranking_log( "slot " + i + ": linea OK xp=" + xp + " prestige=" + prestige + " kills=" + kills + " deaths=" + deaths + " hs=" + headshots + " tp=" + timePlayed );
    }

    // ÚNICA escritura atómica del snapshot completo (IO.cpp FileWrite).
    filewrite( "scriptdata/iw4x-ranking.json", contents, "write" );
    iw4xranking_log( "ciclo fin: total=" + players.size + " humanos=" + humans + " bots=" + bots + " bytes=" + contents.size );
}
