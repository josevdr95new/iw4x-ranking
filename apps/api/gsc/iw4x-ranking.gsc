// iw4x-ranking.gsc — script SERVER-SIDE para el server dedicado IW4x (AlterWare).
//
// Qué hace: cada ~60s escribe un SNAPSHOT (no append) con las stats de
// progresión de los jugadores HUMANOS conectados a:
//     <raíz del juego>/userraw/scriptdata/iw4x-ranking.json
// (FileWrite antepone "scriptdata/" si falta y resuelve relativo a userraw;
// ver src/Components/Modules/GSC/IO.cpp de iw4x-client: BuildPath +
// DefaultDestPath = "userraw"). La API ingiere ese archivo (env
// LIVE_STATS_FILE) para LVL en vivo y detección de unlockstats.
//
// VERIFICADO contra iw4x-client (main, nov-2026):
//  - GetStat: método de la ENTIDAD player, índices 0..3499, exige cliente
//    conectado (Stats.cpp::AddScriptFunctions → SV_GetClientStat). Layout de
//    índices IDÉNTICO al parser de la API (src/lib/save-parser).
//  - getguid(): builtin stock (USAGE: self getGuid()); para humanos devuelve
//    el guid (formato decimal al concatenar con ""); para los bots el string
//    contiene "bot" (así los detecta Bot Warfare en _bot_utility.gsc:227).
//  - filewrite(<path>, <data>, <mode>): builtin de IW4x (GSC/IO.cpp); modo
//    "write" = reescribe completo. Bot Warfare lo usa igual server-side.
//  - NO existe level.onPeriod / Scheduler GSC en iw4x-client: el patrón
//    correcto (el que usa Bot Warfare) es level thread + for(;;) + wait N.
//
// INSTALACIÓN: copiar a  <raíz del juego>/userraw/scripts/iw4x-ranking.gsc
// ACTIVACIÓN: el server carga scripts por CARGA DE MAPA (GSC/Script.cpp
//     LoadCustomScripts → Scr_StartupGameType ejecuta init). Hace falta
//     map_rotate (o reiniciar el server) DESPUÉS de copiar el archivo; un
//     fast_restart NO recarga el VM de GSC. Ver docs/SETUP.md §4H.

init()
{
    level thread iw4xranking_dump_loop();
}

// Bucle periódico: primer dump a los ~5s de cargar el mapa, luego cada 60s.
iw4xranking_dump_loop()
{
    wait 5;
    for ( ;; )
    {
        iw4xranking_dump_once();
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

    if ( !isdefined( level.players ) )
    {
        filewrite( "scriptdata/iw4x-ranking.json", contents, "write" );
        return;
    }

    players = level.players;
    for ( i = 0; i < players.size; i++ )
    {
        player = players[ i ];

        // Defensivo: un cliente puede desconectarse a mitad del dump. Un error
        // de GSC mata el thread (el script renace en la próxima carga de mapa).
        if ( !isdefined( player ) )
        {
            continue;
        }

        guid = player getguid() + "";
        if ( !isdefined( guid ) || guid == "" )
        {
            continue;
        }

        // BOTS FUERA (scr_testclients / Bot Warfare): su guid string contiene
        // "bot" (ver _bot_utility.gsc de ineedbots). La API re-filtra además
        // por /^bot/i y por el rango 0xb07… (isBotGuid).
        if ( issubstr( guid, "bot" ) )
        {
            continue;
        }

        if ( !isdefined( player.name ) )
        {
            continue;
        }

        xp = player GetStat( 2300 );        // experience (XP acumulada)
        prestige = player GetStat( 2325 );  // prestige
        kills = player GetStat( 2305 );     // career kills
        deaths = player GetStat( 2315 );    // career deaths
        headshots = player GetStat( 2321 ); // career headshots
        timePlayed = player GetStat( 2324 ); // timePlayedTotal (minutos)

        contents = contents + "\n" + guid + ";" + xp + ";" + prestige + ";" + kills + ";" + deaths + ";" + headshots + ";" + timePlayed + ";" + player.name;
    }

    filewrite( "scriptdata/iw4x-ranking.json", contents, "write" );
}
