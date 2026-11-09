# Notas técnicas — `back1ply/mw2-class-editor` → lectura de CLASES para nuestro parser IW4x

**Fecha:** 2026-11-08 · **Investigación:** solo web (ningún archivo del workspace tocado salvo este informe).
**Propósito:** extraer todo el conocimiento del repo público `back1ply/mw2-class-editor` (parser del dump de `/dumpPlayerData`, modelo de clases, enums, exporter GSC) para implementar la lectura completa de clases (perks, granadas, weaponSetups con weapon/attachment/camo) en nuestro parser de `iw4x.stat`.

---

## 0. Fuentes consultadas (todas OK, rama `main`)

| Fuente | URL base | Estado |
|---|---|---|
| Parser | `https://raw.githubusercontent.com/back1ply/mw2-class-editor/main/js/parser.js` | 200 (285 líneas) |
| Fixture real | `.../main/sample_from_console_mp.log` | 200 (14.380 bytes, 15 clases) |
| Modelo/estado | `.../main/js/core/store.js` | 200 (114 líneas) |
| Exporter GSC | `.../main/js/core/exporter.js` | 200 (57 líneas) |
| Enums/BD | `.../main/js/data.js` | 200 (367 líneas) |
| Tests golden | `.../main/tests/parser.test.js` | 200 (295 líneas) |
| Helpers de test | `.../main/tests/helpers.js` | 200 |
| App (comandos CFG) | `.../main/js/app.js` | 200 (340 líneas) |
| README | `.../main/README.md` | 200 |
| Design doc | `.../main/docs/plans/2026-03-08-reset-import-tests-design.md` | 200 |
| **Fuente IW4x (evidencia blob)** | `https://raw.githubusercontent.com/iw4x/iw4x-client/main/src/Components/Modules/StructuredData.cpp` | 200 (418 líneas) |
| **Fuente IW4x (stats/GSC)** | `.../iw4x-client/main/src/Components/Modules/Stats.cpp` | 200 |

No hubo 404: la rama `main` respondió a la primera (repo de GitHub Pages, sin `master`/`develop` visibles en el árbol). El árbol completo fue listado vía `api.github.com/repos/back1ply/mw2-class-editor/git/trees/main?recursive=1` — no hay más archivos JS relevantes que estos.

---

## 1. Estructura completa de una clase según el dump

### 1.1 Notación literal (spec del formato)

Cada línea del log lleva un timestamp de consola opcional `[  NNNNN]` (con espacios internos variables). Los campos KV usan **TAB + `= `** como separador: `campo\t= valor`. Los arrays anidan por indentación. Ejemplo verbatim de la clase `[0]` del fixture:

```
[  18215383]     customClasses
[  18215383]       [0]
[  18215383]         _deathstreak\t= specialty_null
[  18215383]         inUse\t= true
[  18215383]         name\t= "THE NOOB2"
[  18215383]         perks
[  18215383]           [0]\t= frag_grenade_mp
[  18215383]           [1]\t= specialty_scavenger
[  18215383]           [2]\t= specialty_coldblooded
[  18215383]           [3]\t= specialty_heartbreaker
[  18215383]           [4]\t= specialty_combathigh
[  18215383]         specialGrenade\t= concussion_grenade
[  18215383]         weaponSetups
[  18215383]           [0]
[  18215383]             attachment
[  18215383]               [0]\t= silencer
[  18215383]               [1]\t= none
[  18215383]             camo\t= none
[  18215383]             weapon\t= ump45
[  18215383]           [1]
[  18215383]             attachment
[  18215383]               [0]\t= silencer
[  18215383]               [1]\t= none
[  18215383]             camo\t= none
[  18215383]             weapon\t= beretta393
```
(Fuente: `sample_from_console_mp.log`, líneas 2–23 del archivo; el `\t` es literal en el log.)

Reglas de notación observadas en el fixture completo:

- **Orden de campos alfabético (ASCII)** a cada nivel: `_deathstreak` < `inUse` < `name` < `perks` < `specialGrenade` < `weaponSetups` (el `_` = 0x5F ordena antes de las minúsculas). Dentro de cada weaponSetup: `attachment` < `camo` < `weapon`. **Consecuencia crítica:** `specialGrenade` aparece SIEMPRE DESPUÉS de `weaponSetups` (el parser lo aprovecha, ver §2).
- Valores string entre comillas dobles: `name\t= "UMP Tryhard"`. Los perks/grenades/weapon/camo van **sin comillas**.
- Nombres con códigos de color `^N` en crudo: `"^2FAL Ninja"` (clase 3), `"^1Cancer Riot"` (4), `"^1Cancer Loud"` (5), `"^4Scar-H Ninja"` (13).
- `inUse = true` por clase (el fixture tiene las 15 en uso; en cuentas reales habrá `false`).
- Campo raíz extra **`_deathstreak`** (con underscore) que el editor NO modela — valor observado siempre `specialty_null`. Probablemente espejo interno del deathstreak (que también vive en `perks[4]`).

### 1.2 Tabla campo-dump → campo-modelo (posición en el árbol)

Modelo del editor (`js/core/store.js:7-26`, typedef `LoadoutClass`) + mapeo que hace el parser (`js/parser.js:110-136`):

| Posición en el árbol del dump | Campo del modelo | Nota |
|---|---|---|
| `customClasses[N].name` | `name` | con `^N` de color, entre comillas |
| `customClasses[N].perks[0]` | `equipment` | letal: `frag_grenade_mp`, `semtex_mp`, … (¡[0] NO es un perk!) |
| `customClasses[N].perks[1]` | `perk1` | slot 1: `specialty_*` |
| `customClasses[N].perks[2]` | `perk2` | slot 2 |
| `customClasses[N].perks[3]` | `perk3` | slot 3 |
| `customClasses[N].perks[4]` | `deathstreak` | `specialty_null` = ninguno |
| `customClasses[N].specialGrenade` | `specialGrenade` | **SIN sufijo `_mp`**: `concussion_grenade`, `flash_grenade`, `smoke_grenade` |
| `customClasses[N].weaponSetups[0].weapon` | `primaryWeapon` | |
| `customClasses[N].weaponSetups[0].attachment[0]` | `primaryAttach1` | |
| `customClasses[N].weaponSetups[0].attachment[1]` | `primaryAttach2` | dual-attach requiere Bling |
| `customClasses[N].weaponSetups[0].camo` | `primaryCamo` | |
| `customClasses[N].weaponSetups[1].weapon` | `secondaryWeapon` | |
| `customClasses[N].weaponSetups[1].attachment[0]` | `secondaryAttach1` | |
| `customClasses[N].weaponSetups[1].attachment[1]` | `secondaryAttach2` | requiere Bling Pro |
| `customClasses[N].weaponSetups[1].camo` | `secondaryCamo` | |
| `customClasses[N].inUse` | *(no modelado por el editor)* | nosotros SÍ lo usamos |
| `customClasses[N]._deathstreak` | *(no modelado)* | espejo interno; ignorar o guardar |

### 1.3 Contenido completo del fixture (las 15 clases, todos los campos)

Extraído del fixture real con una réplica del parser (coincide 1:1 con los asserts de `tests/parser.test.js:236-293`). Formato: `attach1+attach2`.

| # | inUse | name | prim | attach | camo | sec | attach | camo | perks[0] | grenade | perk1 | perk2 | perk3 | perks[4] | _deathstreak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | true | THE NOOB2 | ump45 | silencer+none | none | beretta393 | silencer+none | none | frag_grenade_mp | concussion_grenade | specialty_scavenger | specialty_coldblooded | specialty_heartbreaker | specialty_combathigh | specialty_null |
| 1 | true | UMP Tryhard | ump45 | fmj+none | none | deserteaglegold | silencer+none | none | frag_grenade_mp | concussion_grenade | specialty_scavenger | specialty_bulletdamage | specialty_heartbreaker | specialty_combathigh | specialty_null |
| 2 | true | UMP Rush | ump45 | fmj+none | none | coltanaconda | tactical+none | none | semtex_mp | flash_grenade | specialty_marathon | specialty_lightweight | specialty_heartbreaker | specialty_combathigh | specialty_null |
| 3 | true | ^2FAL Ninja | fal | silencer+none | none | onemanarmy | none+none | none | frag_grenade_mp | flash_grenade | specialty_onemanarmy | specialty_coldblooded | specialty_heartbreaker | specialty_grenadepulldeath | specialty_null |
| 4 | true | ^1Cancer Riot | riotshield | none+none | none | coltanaconda | tactical+none | none | throwingknife_mp | concussion_grenade | specialty_marathon | specialty_coldblooded | specialty_heartbreaker | specialty_grenadepulldeath | specialty_null |
| 5 | true | ^1Cancer Loud | famas | acog+none | desert | spas12 | grip+none | none | semtex_mp | concussion_grenade | specialty_fastreload | specialty_bulletdamage | specialty_bulletaccuracy | specialty_finalstand | specialty_null |
| 6 | true | ^1Cancer Ninja | famas | silencer+none | none | onemanarmy | none+none | none | claymore_mp | smoke_grenade | specialty_onemanarmy | specialty_coldblooded | specialty_heartbreaker | specialty_combathigh | specialty_null |
| 7 | true | ^1Cancer Noob | peacekeeper | none+none | none | pp2000 | silencer+none | none | frag_grenade_mp | concussion_grenade | specialty_scavenger | specialty_bulletdamage | specialty_heartbreaker | specialty_grenadepulldeath | specialty_null |
| 8 | true | Sniper Tryhard | barrett | thermal+none | none | glock | akimbo+none | none | frag_grenade_mp | smoke_grenade | specialty_fastreload | specialty_bulletdamage | specialty_bulletaccuracy | specialty_grenadepulldeath | specialty_null |
| 9 | true | AK Tryhard | ak47classic | fmj+none | none | deserteaglegold | fmj+none | gold | frag_grenade_mp | flash_grenade | specialty_scavenger | specialty_bulletdamage | specialty_heartbreaker | specialty_grenadepulldeath | specialty_null |
| 10 | true | Cancer HC Snipe | m21 | silencer+none | none | beretta393 | silencer+none | none | semtex_mp | concussion_grenade | specialty_fastreload | specialty_coldblooded | specialty_heartbreaker | specialty_grenadepulldeath | specialty_null |
| 11 | true | M4 Anti Air | m4 | silencer+none | none | stinger | none+none | none | frag_grenade_mp | concussion_grenade | specialty_fastreload | specialty_coldblooded | specialty_heartbreaker | specialty_grenadepulldeath | specialty_null |
| 12 | true | ACR Ninja | masada | silencer+none | none | beretta393 | silencer+none | none | claymore_mp | concussion_grenade | specialty_scavenger | specialty_bulletdamage | specialty_heartbreaker | specialty_combathigh | specialty_null |
| 13 | true | ^4Scar-H Ninja | scar | silencer+none | none | spas12 | silencer+none | none | claymore_mp | flash_grenade | specialty_scavenger | specialty_coldblooded | specialty_heartbreaker | specialty_combathigh | specialty_null |
| 14 | true | Cancer | aug | fmj+none | none | javelin | none+none | none | semtex_mp | flash_grenade | specialty_scavenger | specialty_bulletdamage | specialty_bulletaccuracy | specialty_grenadepulldeath | specialty_null |

Casos límite presentes en el fixture (útiles como golden cases): camo primario `desert` (#5), camo secundario `gold` (#9), akimbo (#8), tactical knife (#2, #4), arma secundaria `onemanarmy` (One Man Army como arma del setup, #3 y #6), riot shield primario (#4), armas custom IW4x `peacekeeper`/`ak47classic` (#7, #9), lanzadores `stinger`/`javelin` (#11, #14).

---

## 2. Algoritmo del parser (para portar a TypeScript)

Fuente: `js/parser.js`. Dos modos, seleccionados así:

```
parseConsoleLog(rawText):
  lines = rawText.split(/\r?\n/)
  si NINGUNA línea (trim) === 'customClasses':                       # parser.js:38-40
      si alguna línea contiene 'setPlayerData customClasses':        # parser.js:41-44
          return parseCfgLines(lines)                                 # formato CFG histórico
  # si no → máquina de estados del árbol (formato dumpPlayerData)
```
Prioridad: **árbol > CFG** si ambos aparecen (test `tests/parser.test.js:229-234`).

### 2.1 Máquina de estados (árbol)

Estado: `inCustomClasses`, `currentClassIdx`, `expectedClassIndent`, `currentSection` (`''` | `'weaponSetups'` | `'perks'` | `'attachment'`), `currentWeaponIdx`, `currentAttachIdx`, `classMap{}` (`js/parser.js:48-56`).

Pseudocódigo con las regex exactas:

```
para cada línea:
  line = line.replace(/^\[\s*\d+\s*\]/, '')          # quita timestamp          (parser.js:62)
  trimmed = line.trim(); si vacío → siguiente

  si trimmed === 'customClasses' → inCustomClasses = true; continue    (parser.js:66-70)
  si !inCustomClasses → siguiente

  m = trimmed.match(/^\[(\d+)\]\s*=?\s*(.*)$/)       # corchete, con valor inline opcional  (parser.js:76)
  si m:
    idx = int(m[1]); inlineVal = m[2].trim().replace(/^"|"$/g, '')   # solo comillas extremas
    lineIndent = line.search(/\S/)                     # indentación SIN trim  (parser.js:86)

    si trimmed NO contiene '=':
      si expectedClassIndent == -1 y currentSection == '':
          expectedClassIndent = lineIndent             # el primer [N] "desnudo" FIJA la indentación de clase raíz
      si lineIndent == expectedClassIndent:
          → NUEVA CLASE RAÍZ: currentClassIdx = idx; section=''; weaponIdx=attachIdx=-1
          classMap[idx] ??= getDefaultClass(idx)                              (parser.js:88-101)
      si no, si section ∈ {weaponSetups, attachment}:
          → NUEVO SLOT DE ARMA: section='weaponSetups'; currentWeaponIdx=idx          (parser.js:104-109)
      continue

    si section == 'attachment' y inlineVal:
      weaponIdx 0 → primaryAttach1/2 ; weaponIdx 1 → secondaryAttach1/2 según attachIdx 0/1  (parser.js:110-124)
    si section == 'perks' y inlineVal:
      idx 0→equipment, 1→perk1, 2→perk2, 3→perk3, 4→deathstreak                         (parser.js:125-136)
    continue

  si currentClassIdx >= 0:
    kv = trimmed.match(/^(\w+)\s*=\s*(.+)$/)                               (parser.js:146)
    si kv:
      key, val = kv[1], kv[2].trim().replace(/^"|"$/g, '')
      si section == '':
          key 'name' → name ; key 'specialGrenade' → specialGrenade        (parser.js:152-155)
      si no, si key == 'specialGrenade':
          specialGrenade = val; section = ''
          # "specialGrenade is always the last root-level field in a MW2 class dump,
          #  so resetting currentSection to '' here is safe — it appears after weaponSetups"  (parser.js:156-161)
      si no, si section ∈ {weaponSetups, attachment} y weaponIdx >= 0:
          si section == 'attachment': section = 'weaponSetups'   # ver 'weapon'/'camo' ⇒ salimos del bloque attachment
          weaponIdx 0 → primaryWeapon/primaryCamo ; 1 → secondaryWeapon/secondaryCamo        (parser.js:163-172)
      continue

    hm = trimmed.match(/^(\w+)\s*$/)             # cabecera de sección: palabra sola sin '='   (parser.js:176)
    si hm y hm[1] ∈ {weaponSetups, perks, attachment}:
        section = hm[1]  (weaponSetups/attachment resetean índices)                          (parser.js:178-185)

al final:
  result = [ classMap[i] ?? getDefaultClass(i) para i en 0..14 ]     # SIEMPRE 15 clases      (parser.js:195-199)
  return { classes: result, count: keys(classMap).length, errors: [] }   # `errors` existe pero NUNCA se llena
```

Detalles sutiles que hay que replicar (bugs/peculiaridades conocidos):

1. **La indentación solo se usa para detectar clases raíz**, y de forma RELATIVA: la indentación del primer `[N]` desnudo bajo `customClasses` define `expectedClassIndent`. Cualquier `[N]` desnudo a esa misma indentación = nueva clase. Un `[N]` desnudo dentro de weaponSetups está siempre más indentado en dumps reales, así que no colisiona.
2. `[N] = valor` con valor inline SOLO se consume en secciones `attachment` y `perks`. En la raíz no hay arrays con valor inline.
3. El valor inline se limpia de comillas solo en los extremos (`^"` y `"$`) — no usa trim de comillas internas.
4. Las cabeceras de sección solo reconocen EXACTAMENTE `weaponSetups`, `perks`, `attachment`. `inUse`, `_deathstreak`, `camo` como palabra sola se ignoran sin romper el estado.
5. `weapon`/`camo` después de un bloque `attachment` reordenan el estado a `weaponSetups` (depende del orden alfabético del dump, ver §1.1).
6. La asignación de `specialGrenade` en cualquier sección reinicia `section=''` — seguro por el orden alfabético documentado arriba.
7. Si el dump no trae ninguna línea `customClasses` pero sí líneas `setPlayerData customClasses ...`, usa el modo CFG (§2.2). Entrada vacía/basura → `count=0` con 15 defaults (`tests/parser.test.js:210-224`).

### 2.2 Modo CFG (`parseCfgLines`, `js/parser.js:209-284`)

Para líneas tipo `setPlayerData customClasses <idx> <field> [subidx] <value>` — split por espacios:

- `parts[2]` = índice de clase (0-14, fuera de rango se descarta), `parts[3]` = campo.
- `name`: regex `name\s+"?(.*?)"?$` sobre la línea completa (soporta nombres con espacios entrecomillados).
- `weaponSetups`: `parts[4]`=slot (0/1), `parts[5]`=prop (`weapon`|`camo`|`attachment`); si attachment: `parts[6]`=índice attach, `parts[7]`=valor.
- `perks`: `parts[4]`=índice 0-4 → mismo mapeo equipment/perk1-3/deathstreak.
- `specialGrenade`: `parts[4]`=valor.

Este formato es exactamente el que genera el editor en `js/app.js:83-100` (`generateCommandsForClass`) y el exporter GSC en `js/core/exporter.js:26-49` (ver §5).

---

## 3. Correspondencia blob ↔ dump

El repo de back1ply **no toca el blob binario para nada** (solo dump de texto y comandos). La evidencia dura del mapeo viene del fuente oficial `iw4x/iw4x-client`:

### 3.1 Evidencia verificada (fuente IW4x, `src/Components/Modules/StructuredData.cpp`)

| Afirmación | Evidencia |
|---|---|
| Versión base del stat de IW4x = **155** | `StructuredData.cpp:6` — `constexpr auto BASE_PLAYERSTATS_VERSION = 155;` |
| Tamaño de cada clase = **64 bytes** | `StructuredData.cpp:105` — `const int customClassSize = 64;` |
| **Offset 3643 = inicio de customClasses** | `StructuredData.cpp:122` — comentario literal: `// 3643 is the offset of the customClasses structure` |
| Vanilla MW2 tenía **10 clases**; IW4x las sube a 15 | `StructuredData.cpp:125` — `// -10 because 10 is the default amount of custom classes.`; `StructuredData.cpp:218` — `Utils::Hook::Set<BYTE>(0x60A2FE, NUM_CUSTOM_CLASSES);` con comentario `// 15 or more custom classes` |
| Si un mod define >N clases, todo lo que hay DESPUÉS de 3643 se desplaza `(count - original) * 64` | `StructuredData.cpp:100-133` (`PatchCustomClassLimit`): propiedades con `offset >= 3643` se incrementan y `data->size += (count-original)*64`. El bloque customClasses siempre EMPIEZA en 3643; crece hacia adelante |
| Migración de versión ≤158 → **159**: los datos desde 3643 se mueven **+320 bytes** (= 5×64) | `StructuredData.cpp:183` — `std::memmove(&buffer->data[3963], &buffer->data[3643], oldDef->size - 3643);` con comentario `// this should move the data 320 bytes infront` |
| La migración hacia arriba desde v159 está rota a propósito | `StructuredData.cpp:186-188` — `// 159 cannot be translated upwards ... // might be the funky class bump...?` |
| Los enums del playerdata (13 categorías) se parchean por versión con JSONs `mp/playerdata.def/{version}.json` | `StructuredData.cpp:11-24` (`EnumTranslation`: features, weapons, attachements, challenges, camos, perks, killstreaks, accolades, cardicons, cardtitles, cardnameplates, teams, gametypes) y bloque zonebuilder (`StructuredData.cpp:~280-340`) |

**Conclusión práctica:** nuestro parser que lee 15 clases × 64 bytes desde el offset 3643 coincide exactamente con el layout que IW4x construye (base v155, 15 clases). El dump de texto es el MISMO árbol DDL impreso a consola (en orden alfabético de propiedades del schema), con los enums resueltos a sus nombres string.

### 3.2 Inferencias (etiquetadas como tales — no verificadas empíricamente contra un blob real)

1. **En el blob los campos de enum van como ÍNDICES enteros, no strings.** El dump imprime nombres porque `dumpPlayerData` resuelve índice→nombre con las tablas de enum del DDL activo (que un mod puede parchear: `PatchPlayerDataEnum`). Armamos la cuenta: si name ocupa 32 bytes ASCII (0x00–0x1F), quedan 32 bytes para `perks[5]` + `specialGrenade` + 2×`weaponSetups{weapon, attachment[2], camo}` + `inUse` + `_deathstreak` — con enums de 1 byte son 5+1+8+1+1 = 16 bytes + padding/alignment hasta 64 (encaja); con enums de 4 bytes serían 64 exactos para enums solos (no cabe con el nombre). Hipótesis más probable: **enums de 1 byte con padding**, pero hay que confirmarlo empíricamente.
2. **El orden alfabético del dump probablemente refleja el orden de propiedades del struct DDL**, y por tanto el orden de los campos en el binario (los DDL de IW4x almacenan propiedades ordenadas). Si eso se confirma, el orden binario dentro de la clase sería: `_deathstreak, inUse, name, perks[5], specialGrenade, weaponSetups[2]` — NOTA: contradice la hipótesis "name primero"; el experimento de §3.3 decidirá.
3. **El blob se puede leer igual lado servidor**: `Stats.cpp:SendStats` muestra que el CLIENTE envía su buffer de stats completo (8192 bytes, en 7 paquetes de ≤1240) al servidor (`src/Components/Modules/Stats.cpp:24-52`). Es decir, el servidor recibe el mismo layout binario que hay en `iw4x.stat`.
4. **GSC no puede llegar a la región de clases por bytes**: el método GSC `GetStat`/`SetStat` de IW4x limita el índice a **0..3499** (`Stats.cpp`: "GetStat: invalid index %i" si `index < 0 || index > 3499`), y 3643 > 3499. La región de clases es inaccesible vía GetStat/SetStat tal cual está el fuente.

### 3.3 Experimento recomendado para cerrar el mapeo (si algún día queremos leer clases solo del blob)

Correlación controlada: con UNA cuenta, escribir clases que difieran en exactamente un campo (p.ej. solo `perk1` cambia entre clase A y B), dumpear (`/dumpPlayerData`) y extraer `iw4x.stat`; hacer diff byte a byte del rango 3643..3643+960. Repetir variando: camo, attachment, weapon (cambios de índice de enum grandes revelan el ancho del campo: 1 vs 4 bytes), inUse, grenade. Con ~6 iteraciones se derivan los sub-offsets exactos de los 64 bytes. Mientras tanto, el dump de texto (§2) da el 100% de los datos sin riesgo.

---

## 4. Checks de validación (cómo saber que un parse es correcto)

Del suite golden `tests/parser.test.js`:

- **Conteo**: `classes.length === 15` SIEMPRE (faltantes = defaults); `count` = clases realmente halladas (`:242-245`).
- **Fixture real** (`:236-293`): clase 0 → `name='THE NOOB2'`, `primaryWeapon='ump45'`, `secondaryWeapon='beretta393'`, `specialGrenade='concussion_grenade'`, `primaryAttach1='silencer'`, `primaryAttach2='none'`, `equipment='frag_grenade_mp'`, `perk1='specialty_scavenger'`, `perk2='specialty_coldblooded'`, `perk3='specialty_heartbreaker'`, `deathstreak='specialty_combathigh'`. Clase 5 → `primaryCamo='desert'` + `primaryWeapon='famas'` (`:269-272`). Clase 9 → `secondaryCamo='gold'` + `secondaryWeapon='deserteaglegold'` (`:276-279`).
- **Invariantes sobre el fixture real**: las 15 clases tienen `primaryWeapon` y `secondaryWeapon` ≠ `'none'` (`:282-293`) — en dumps reales de cuentas jugadas, un arma en `none` delata un parse roto.
- **Timestamps**: presentes o ausentes, el resultado es idéntico (`:96-107`).
- **Entrada vacía/basura**: `count=0`, 15 defaults (`:210-224`). Detalle: el default de TEST pone armas en `'none'` (`tests/helpers.js:5-23`), mientras el default de PRODUCCIÓN (`js/data.js:265-282`) usa valores reales del juego (`m4`, `usp`, `frag_grenade_mp`, `concussion_grenade`, `specialty_marathon`, `specialty_bulletdamage`, `specialty_heartbreaker`, `specialty_combathigh`, nombre `Custom Class ${i+1}`). **En nuestro port conviene distinguir "clase ausente" (`inUse=false`) de "clase con datos" y no inventar defaults de armas.**
- **Validación por enums** (`js/data.js:242-259`): el editor arma sets planos (`ALL_WEAPON_IDS`, `ALL_CAMO_IDS`, …) para validar import. Listas completas:

  - **Primarias** (`data.js:7-62`): `m4, m16, scar, famas, fal, masada, tar21, ak47, f2000` (assault) · `mp5k, ump45, vector, p90, uzi` (smg) · `rpd, mg4, sa80, m240, aug` (lmg) · `cheytac, barrett, wa2000, m21` (sniper) · `riotshield` · **custom IW4x**: `peacekeeper, ak47classic`.
  - **Secundarias** (`data.js:65-110`): `usp, beretta393, coltanaconda, deserteagle, deserteaglegold` · `pp2000, glock, beretta93r, tmp` · `spas12, aa12, striker, ranger, m1014` · `at4, rpg, thumper, javelin, stinger` · especial: `onemanarmy`.
  - **Attachments primarios** (`data.js:112-126`): `none, silencer, fmj, grip, rof, reflex, acog, eotech, thermal, xmags, gl, shotgun, heartbeat`.
  - **Attachments secundarios** (`data.js:128-140`): `none, silencer, fmj, xmags, akimbo, tactical, grip, rof, reflex, eotech, acog`.
  - **Camos** (`data.js:142-154`): `none, desert, arctic, woodland, digital, urban, bluetiger, redtiger, fall, gold`.
  - **Equipment = perks[0]** (`data.js:156-165`): `frag_grenade_mp, semtex_mp, throwingknife_mp, claymore_mp, c4_mp, oic_tactinsert_mp, oic_flashbanggrenade_mp`.
  - **specialGrenade — SIN `_mp`** (`data.js:167-172`): `concussion_grenade, flash_grenade, smoke_grenade`.
  - **Perk slot 1** (`data.js:174-186`): `specialty_marathon|fastreload|scavenger|bling|onemanarmy` (+ `_pro` cada uno).
  - **Perk slot 2** (`data.js:188-200`): `specialty_bulletdamage|lightweight|hardline|coldblooded|explosivedamage` (+ `_pro`).
  - **Perk slot 3** (`data.js:202-216`): `specialty_extendedmelee|bulletaccuracy|scrambler|heartbreaker|detectexplosive|pistoldeath` (+ `_pro`).
  - **Deathstreak** (`data.js:218-225`): `specialty_null, specialty_combathigh, specialty_grenadepulldeath, specialty_finalstand, specialty_yourturn`.

  ⚠️ Los tests sintéticos usan IDs `_mp` inventados para perks (`marathon_mp`, `:20-27`) que NO existen en dumps reales — no los usemos como enum de referencia; las listas de arriba están verificadas contra dumps reales (`data.js:1-4`: "All internal IDs verified from actual getPlayerData").
- **inUse**: presente por clase en el dump (`= true`); cruza perfecto con nuestro `inUse` leído del blob para validar el mapeo blob↔dump.

---

## 5. Extras que el editor sabe (y conviene que sepamos nosotros)

1. **Generación inversa (write-path)**: `js/core/exporter.js:11-55` genera GSC `initClasses()` con `self setPlayerData("customClasses", i, "name", ...)`; escribe en este orden por clase: `name`, `inUse=true` (L26-27), weaponSetups 0 (weapon, attachment 0, attachment 1, camo) (L30-33), weaponSetups 1 (L36-39), `perks 0..4` (L42-46), `specialGrenade` (L49). `js/app.js:83-100` genera los mismos campos como comandos de consola separados por `;`. **No hay ningún otro índice de campo** — la tabla del §1.2 ES el esquema completo de customClasses que el juego acepta.
2. **Códigos de color** (`js/data.js:227-240`): `^0` negro, `^1` rojo, `^2` verde, `^3` amarillo, `^4` azul, `^5` cyan, `^6` rosa, `^7` blanco, `^8` team/teal, `^9` gris, `^:` rainbow. Los nombres de clase los traen en crudo — para mostrarlos hay que parsearlos; para guardarlos, no tocar.
3. **Comandos unlock** (`js/app.js`, `generateUnlockAll`): `unlockstats`, `setPlayerData prestige 10`, `setPlayerData experience 2516000` (el 2516000 también aparece como XP máxima en `iw4x-client/src/Components/Modules/Stats.cpp:11-14`).
4. **Round-trip garantizado**: generar comandos CFG → `parseCfgLines` → mismos datos (design doc `docs/plans/2026-03-08-reset-import-tests-design.md`, sección `tests/app.test.js` coverage). Útil para testear nuestro port: parse(dump) → emitir CFG → parse(CFG) → igual.
5. **Otras secciones del playerdata además de customClasses** (lo que `dumpPlayerData` puede mostrar y el editor ignora): por el schema DDL del stat (`StructuredData.cpp:11-24`) hay 13 categorías de enum — features, weapons, attachements, challenges, camos, perks, killstreaks, accolades, **cardicons, cardtitles, cardnameplates** (títulos de tarjeta — sí, los titles viven aquí), teams, gametypes — más `prestige`, `experience`, `challengeState`/`challengeProgress`, `iconUnlocked` (ver `iw4x-client/src/Components/Modules/QuickPatch.cpp:UnlockStats`). El fixture de back1ply empieza directamente en `customClasses`, así que no sabemos si el comando dumpea el árbol completo desde la raíz (muy probable) o se invoca por nodo. **Pregunta abierta**: capturar un `console_mp.log` completo sin recortar para ver qué más hay besides customClasses.
6. **Variantes de versión**: base v155; versiones 156+ se generan con JSONs de parche por mod (`{fs_game}/mp/playerdata.def/{156,157,...}.json`) que pueden **añadir entradas a los enums** (armas/camos custom → índices > vanilla) y cambiar el número de clases (key `"other"."classes"`, `StructuredData.cpp:PatchAdditionalData`). La migración ≤158→159 desplaza el bloque de clases +320 bytes (§3.1). **Implicación para nuestro parser de blob**: los índices de enum del blob NO son estables entre mods/-versiones; los nombres del dump SÍ son lo que el cliente ve.

---

## 6. Recomendación de implementación para iw4x-ranking

### Contexto técnico

- `/dumpPlayerData` es un **comando de consola del CLIENTE** (imprime el árbol DDL en memoria a `console_mp.log`; back1ply/README lo documenta así). El servidor no puede ejecutarlo "por" el cliente.
- Leer clases del blob cifrado lado servidor **no es viable por GSC hoy**: `GetStat` está acotado a índices 0..3499 y la región de clases empieza en 3643 (`Stats.cpp` + `StructuredData.cpp:122`) — acceso byte a byte cerrado; y los enums del blob son índices dependientes de la versión/mod (§5.6), no nombres.
- El flujo del editor (que funciona y está probado): usuario corre `/dumpPlayerData` → sube/pega `console_mp.log` → parser de texto. ~150 líneas de lógica, formato estable, validado con fixture real.

### Recomendación (por orden de prioridad)

1. **Portar `parseConsoleLog` a TypeScript tal cual** (ambos modos: árbol + CFG), siguiendo §2 al pie de la letra (regex exactas, estado, defaults, preferencia árbol>CFG). Es la vía de menor riesgo y cubre el 100% de los datos (perks, grenade, weaponSetups completos).
2. **Endpoint de ingesta**: aceptar upload o paste del `console_mp.log` en la API (mismo DX que el editor: drag&drop/paste). Si el ranking ya tiene flujo de auth del jugador, pedirle el dump es un paso único y barato; se puede automatizar lado cliente con un bind en el cfg (p.ej. tecla que ejecute `/dumpPlayerData`) + instrucción de dónde está el log.
3. **Validación en ingest** (§4): exigir `count ≥ 1`; flaggear clases con `inUse=false` como vacías (NO rellenar con defaults de armas); validar valores contra los enums reales de §4 aceptando desconocidos con warning (mods pueden añadir armas); preservar `^N` en el name almacenado; sanity-check: `primaryWeapon != none` cuando `inUse=true`.
4. **Tests golden**: incluir el fixture real (o su clase 0/5/9) como test embebido con los asserts de `tests/parser.test.js:236-293`, más el caso "timestamp" y el caso "árbol+CFG mixto prefiere árbol".
5. **Mantener el parser de blob solo para `name`+`inUse`** (offset 3643 + 64·N), que es lo único seguro sin las tablas de enum. Cruzar `inUse` blob↔dump cuando ambos existan para detectar desalineación de offsets.
6. **NO implementar dump GSC server-side ahora.** Evaluarlo solo si: (a) aparece un `getPlayerData` legible de customClasses en GSC de IW4x (el comentario de `data.js:3` menciona getPlayerData pero solo como fuente de verificación de IDs, no como API server), o (b) decidimos compilar un componente C++ custom de IW4x que serialice el buffer de stats recibido (SendStats ya entrega los 8192 bytes al server, `Stats.cpp:24-52`) — costo alto, beneficio dudoso frente al dump de texto.
7. **Futuro opcional** (solo si queremos clases sin pedir dump): correr el experimento de correlación de §3.3 para derivar los sub-offsets exactos de los 64 bytes por clase y validar contra dumps reales de varias cuentas. Hasta entonces, cualquier lectura de perks/camos desde el blob sería adivinanza.

### Riesgos documentados

- Mods con >15 clases o enums parcheados → los índices del blob cambian (el offset de INICIO 3643 no) y pueden aparecer IDs de arma fuera de nuestras listas (§3.1, §5.6).
- Versiones de stat ≠ 155 con layouts desplazados (el +320 de v159) → si algún jugador trae un `iw4x.stat` de otra versión, el bloque de clases puede no estar en 3643; el dump de texto es inmune a esto.
- El campo `errors` del parser original nunca se llena: nuestro port puede poblarlo de verdad (mejora gratuita).

---

### Apéndice A — Formato de las líneas del dump (resumen para el port)

- Timestamp: `^\[\s*\d+\s*\]` al inicio de línea (opcional, con espacios internos).
- Separador KV: `\t= ` (tab antes del `=`); regex robusta: `^(\w+)\s*=\s*(.+)$`.
- Array indexado: línea `[\d+]` sola (nuevo objeto) o `[\d+]\t= valor` (valor inline).
- Indentación por espacios; la clase raíz va a una indentación fija relativa (6 espacios en el fixture real bajo `customClasses`).
- Strings entre comillas solo en `name`.

### Apéndice B — Referencias rápidas

- Editor live: https://back1ply.github.io/mw2-class-editor/ · Repo: https://github.com/back1ply/mw2-class-editor (MIT).
- Fuente IW4x: https://github.com/iw4x/iw4x-client (rama `main`) — `src/Components/Modules/StructuredData.cpp`, `src/Components/Modules/Stats.cpp`, `src/Components/Modules/QuickPatch.cpp`.
