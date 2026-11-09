// iw4x-ranking.gsc v3 — script SERVER-SIDE para el server dedicado IW4x (AlterWare).
//
// Qué hace: cada ~60s escribe un SNAPSHOT (no append) con las stats de
// progresión de los jugadores HUMANOS conectados a:
//     <raíz del juego>/userraw/scriptdata/iw4x-ranking.json
// (FileWrite antepone "scriptdata/" si falta y resuelve relativo a userraw;
// ver src/Components/Modules/GSC/IO.cpp de iw4x-client: BuildPath +
// DefaultDestPath = "userraw"). La API ingiere ese archivo (env
// LIVE_STATS_FILE) para LVL en vivo y detección de unlockstats.
//
// ⚠️ CAMBIO v3 — MODO CALIBRACIÓN (bug: los índices viejos leen BASURA):
//  Evidencia 2026-11-08 (games_mp.log, dueño en partida con 40 kills / 0
//  deaths / 5 hs / 4840 XP conocidos por el Barracks):
//      slot 0: linea OK xp=0 prestige=1935764547 kills=268439040
//              deaths=0 hs=1056974848 tp=544042868
//  → los índices 2300/2325/2305/2315/2321/2324 (confianza MEDIA, heredados de
//  la suposición de layout del blob) NO corresponden en esta build: leen
//  floats y texto del buffer server-side, no stats de career. Mientras no
//  estén CALIBRADOS los índices reales:
//  1) El snapshot principal iw4x-ranking.json se escribe SOLO CON CABECERA
//     (la API no ingiere NADA — mejor vacío que basura; los LVL quedan "—").
//  2) Por cada HUMANO conectado se escribe un DUMP DE CALIBRACIÓN en
//     scriptdata/iw4x-ranking-calib.txt: índices 2000..3497 (la región
//     int32 completa del buffer server-side; fórmula índice→offset
//     2004 + 4*(i-2000)), una línea "index;valor" por cada valor != 0,
//     precedida por un bloque "#cycle <n> guid=<guid> name=<nombre>".
//     El archivo se REINICIA en cada carga de mapa (acotado) y los bloques
//     se ACUMULAN por append para poder ver CRECIMIENTO entre ciclos
//     (XP/kills suben, timePlayed sube +1 por minuto).
//  3) En games_mp.log queda una línea por ciclo: "calib: N valores no-cero".
//  Calibración = buscar en calib.txt los valores conocidos del dueño
//  (XP 4840, kills 40, hs 5, score 4000, timePlayed 8) y cruzar qué índice
//  los contiene y CRECE acorde. Cuando los índices reales estén validados,
//  poner level.iw4xranking_calib = 0 y rellenar los índices del bloque
//  LECTURA NORMAL de abajo.
//
// HEREDADO de v2 (fix del bug "solo cabecera, 0 líneas de jugador"):
//  1) AISLAMIENTO DE ERRORES: el bucle principal lanza CADA ciclo en un HILO
//     HIJO (`thread iw4xranking_dump_once()`). En GSC un error de runtime
//     (Scr_Error) MATA EL HILO donde ocurre; antes mataba al hilo del bucle y
//     el archivo quedaba congelado hasta la próxima carga de mapa. Ahora el
//     bucle padre SOBREVIVE y el siguiente ciclo reintenta. El dump de
//     calibración es ADEMÁS otro hilo hijo propio: un Scr_Error de GetStat
//     (carrera de desconexión a mitad de los 1498 índices) mata SOLO ese
//     dump; el ciclo sigue y el snapshot principal se escribe igual.
//     Fuente del error conocido: Stats.cpp AddMethod("GetStat") hace
//     Scr_Error("GetStat: called on a disconnected player") si
//     sess.connected <= CON_DISCONNECTED.
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
    // MODO CALIBRACIÓN: 1 = snapshot principal SOLO cabecera + dump calib por
    // humano. Poner a 0 (y rellenar los índices de la LECTURA NORMAL) cuando
    // los índices reales estén validados con el calib.txt.
    level.iw4xranking_calib = 1;
    level.iw4xranking_cycle = 0;

    // Reinicia los logs en cada carga de mapa (archivos acotados).
    filewrite( "scriptdata/iw4x-ranking-debug.log", "[iw4x-ranking] init v3: script cargado en esta carga de mapa\n", "write" );
    filewrite( "scriptdata/iw4x-ranking-calib.txt", "#iw4x-ranking-calib v1\n", "write" );
    iw4xranking_log( "init v3 ok: CALIBRACION ON (dump idx 2000..3497 -> calib.txt); snapshot principal SOLO cabecera" );
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

// Un ciclo: recorre los jugadores. Con CALIBRACIÓN ON escribe el snapshot
// principal SOLO CON CABECERA (nunca líneas de jugador con índices sin
// validar) y lanza el dump de calibración por cada humano.
// Formato del snapshot (una línea por jugador; name al FINAL para tolerar
// ';' en el nick) — SOLO se produce con calib OFF:
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

        // MODO CALIBRACIÓN: dump de índices en HILO HIJO propio (un Scr_Error
        // de GetStat a mitad mata SOLO el dump) y SIN escribir la línea del
        // jugador en el archivo principal (basura garantizada hasta calibrar).
        if ( level.iw4xranking_calib )
        {
            iw4xranking_log( "slot " + i + ": humano \"" + pname + "\" guid=" + guid + " -> calib dump (snapshot principal: solo cabecera)" );
            thread iw4xranking_calib_dump( player, guid, pname );
            continue;
        }

        // LECTURA NORMAL (ÍNDICES SIN CALIBRAR — los de abajo son los VIEJOS
        // que leen BASURA; sustituir por los reales cuando el calib.txt los
        // valide, ver cabecera v3). GetStat (Stats.cpp): INICIO de la zona
        // que puede Scr_Error si el jugador se desconecta AHORA MISMO. Si
        // pasa, muere SOLO este hilo hijo (el bucle padre reintenta).
        iw4xranking_log( "slot " + i + ": humano \"" + pname + "\" guid=" + guid + " leyendo GetStat..." );

        xp = player GetStat( 2300 );        // VIEJO: experience (BASURA — sin calibrar)
        prestige = player GetStat( 2325 );  // VIEJO: prestige (BASURA — sin calibrar)
        kills = player GetStat( 2305 );     // VIEJO: career kills (BASURA — sin calibrar)
        deaths = player GetStat( 2315 );    // VIEJO: career deaths (BASURA — sin calibrar)
        headshots = player GetStat( 2321 ); // VIEJO: career headshots (BASURA — sin calibrar)
        timePlayed = player GetStat( 2324 ); // VIEJO: timePlayedTotal (BASURA — sin calibrar)

        contents = contents + "\n" + guid + ";" + xp + ";" + prestige + ";" + kills + ";" + deaths + ";" + headshots + ";" + timePlayed + ";" + pname;
        iw4xranking_log( "slot " + i + ": linea OK xp=" + xp + " prestige=" + prestige + " kills=" + kills + " deaths=" + deaths + " hs=" + headshots + " tp=" + timePlayed );
    }

    // ÚNICA escritura atómica del snapshot completo (IO.cpp FileWrite). En
    // calibración contents NO lleva líneas de jugador: queda solo la cabecera.
    filewrite( "scriptdata/iw4x-ranking.json", contents, "write" );
    iw4xranking_log( "ciclo fin: total=" + players.size + " humanos=" + humans + " bots=" + bots + " bytes=" + contents.size );
}

// DUMP DE CALIBRACIÓN (v3): lee GetStat en TODA la región int32 del buffer
// server-side (índices 2000..3497; fórmula índice→offset 2004+4*(i-2000))
// y APPENDA a scriptdata/iw4x-ranking-calib.txt un bloque:
//     #cycle <n> guid=<guid> name=<nombre>
//     <index>;<valor>          (solo valores != 0, para reducir ruido)
// Los bloques se acumulan DENTRO de una carga de mapa: XP/kills suben entre
// ciclos y timePlayed sube +1 por minuto → el cruce con los valores conocidos
// del dueño (Barracks) determina los índices reales. El archivo se reinicia
// en cada init() (acotado, ~decenas de KB por mapa).
// Corre en HILO HIJO propio: si el jugador se desconecta a mitad de los 1498
// GetStat, el Scr_Error mata SOLO este hilo (el ciclo y el bucle padre viven).
iw4xranking_calib_dump( player, guid, pname )
{
    level.iw4xranking_cycle += 1;
    cycle = level.iw4xranking_cycle;

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
