# DESIGN.md — Ranking web comunidad IW4x (MW2 2009)

> **Especificación de diseño para implementación en React + Tailwind.**
> Audiencia: jugadores hispanohablantes de IW4x. Tono: competitivo, serio pero accesible.
> Modo de superficie: **Operate** (el visitante consulta datos y hace tareas: buscar, ordenar, vincular). Todo lo expresivo se subordina a la legibilidad de los datos.

---

## 0. Dirección visual: "HUD de MW2" (verde HUD sobre casi negro)

**Decisión de acento: VERDE HUD (`#8FD429`). Rechazado el ámbar/naranja.**

Justificación:

- El verde es EL recuerdo visual del HUD de CoD4/MW2: nombres aliados, waypoints, marcadores de objetivo. Es la identidad de esta audiencia, no una elección de catálogo.
- El ámbar/naranja es territorio de Faceit y de tracker.gg para CS. Elegirlo nos haría parecer un clon. Además colisionaría con el token `warning` (ámbar), rompiendo la semántica de estados.
- El verde significa "positivo/GO" universalmente: el acento de marca **duplica como color de éxito** (K/D alto, "en línea", confirmaciones). Un solo verde, cero ambigüedad.
- Sobre negro casi puro, el verde HUD tiene contraste 11.8:1 — funciona como texto, relleno y foco sin variantes débiles.

**Estrategia de color: Restrained.** Neutrales oliva + un acento. El color se gana con datos: medallas, K/D, estados. Nunca es decorativo.

**La elevación se construye con pasos de superficie + hairlines, no con sombras** (las sombras apenas leen sobre `#0B0C09`). Las sombras existen solo para dropdowns/modales (flotantes reales).

**Firma visual**: esquinas casi rectas (radio 2–4px), hairlines de 1px, etiquetas en mayúsculas con tracking, números tabulares alineados a la derecha, textura de franjas diagonales al 3% SOLO en el hero del perfil (motivo del menú de MW2). Cero gradientes decorativos, cero glass, cero glow.

---

## 1. Tokens de diseño

### 1.1 Paleta

Rampa neutral **teñida de oliva** (hue ≈ 80°), nunca gris puro — un dark UI gris genérico es el slop que evitamos.

| Token | Hex | Uso | Contraste verificado |
|---|---|---|---|
| `bg` | `#0B0C09` | Fondo de página | — |
| `surface` | `#14160F` | Paneles, tabla, cards, navbar | — |
| `surface-2` | `#1D2015` | Hover de fila, thead, inputs, dropdowns | — |
| `border` | `#2B2F1E` | Hairlines (bordes 1px por defecto) | — |
| `border-strong` | `#3A402A` | Bordes interactivos (inputs en foco sin acento, hover de botón ghost) | — |
| `text-primary` | `#EDEFE3` | Texto principal | 15.5:1 sobre surface |
| `text-secondary` | `#A9B298` | Texto secundario, labels, captions, placeholders (con `placeholder` en `#7F8A6E`) | 8.9:1 sobre bg |
| `accent` | `#8FD429` | Verde HUD: CTAs, links, activo, éxito/K-D alto, en línea | 11.8:1 sobre bg |
| `accent-hover` | `#A9E84D` | Hover de primary, ring de foco | 13.2:1 sobre bg |
| `accent-active` | `#79BC1F` | pressed del primary | — |
| `on-accent` | `#0E1405` | Texto SIEMPRE sobre relleno accent | 10.9:1 sobre accent |
| `accent-subtle` | `rgba(143,212,41,0.12)` | Fondo sutil (badge verde, fila #1, tab activo) | — |
| `accent-border` | `rgba(143,212,41,0.32)` | Borde de elementos con fondo accent-subtle | — |
| `success` | `#8FD429` | **Alias de accent.** No existe un segundo verde. | idem accent |
| `warning` | `#D9A62E` | K/D medio-bajo (0,80–0,99), avisos no bloqueantes | 8.8:1 sobre bg |
| `danger` | `#E5484D` | K/D bajo (<0,80), errores, bordes de error | 6.4:1 como texto sobre bg |
| `danger-hover` | `#F2665C` | Texto de error inline, hover de enlaces/badges danger | — |
| `danger-fill` | `#D63C42` | Relleno del botón danger (texto blanco `#FFFFFF` encima: 4.6:1 ✓ AA) | — |
| `danger-fill-hover` | `#C33236` | Hover/pressed del botón danger (el rojo se oscurece, nunca sube) | — |
| `medal-gold` | `#E5B84B` | Medalla #1 (solo celda de rank) | — |
| `medal-silver` | `#C4CCC2` | Medalla #2 | — |
| `medal-bronze` | `#C99055` | Medalla #3 | — |

Los colores de medalla son la ÚNICA excepción a "un acento": oro/plata/bronce son lenguaje universal de ranking. Se usan exclusivamente en la celda `#` del top 3. Prohibidos en cualquier otro lugar.

**Estados de K/D (umbral oficial, usar en badges de tabla, perfil y perfil-historial):**

| Rango | Color | Ejemplo |
|---|---|---|
| ≥ 1,20 | `success` (verde) | `2,39` |
| 1,00 – 1,19 | `text-primary` (sin color — neutro) | `1,08` |
| 0,80 – 0,99 | `warning` (ámbar) | `0,91` |
| < 0,80 | `danger` (rojo) | `0,67` |

### 1.2 Radios (sistema afilado, táctico)

| Token | Valor | Uso |
|---|---|---|
| `rounded-none` | `0px` | Celdas de tabla, chips de estado, textura del hero |
| `rounded-sm` | `2px` | Botones, badges, inputs pequeños, tabs |
| `rounded-md` | `4px` | Inputs, paneles, toolbar |
| `rounded-lg` | `6px` | Modales, dropdowns, toasts |
| `rounded-full` | `9999px` | SOLO puntos de estado (● 6–8px). Prohibido en botones/badges. |

### 1.3 Espaciado (escala Tailwind nativa de 4px — no inventar valores)

`0.5(2) · 1(4) · 2(8) · 3(12) · 4(16) · 5(20) · 6(24) · 8(32) · 10(40) · 12(48) · 16(64)`

Reglas de ritmo: más espacio por encima de un heading que por debajo (`mt-8` sobre título de sección, `mb-4` debajo). Filas de tabla densas: `py-2.5 px-3`. Entre secciones de página: `mt-8` mínimo. Container: `max-w-7xl mx-auto px-4 md:px-6`.

### 1.4 Sombras (offset real + blur; cero halos de 0-offset)

| Token | Valor | Uso |
|---|---|---|
| `shadow-panel` | `0 1px 2px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.4)` | dropdowns, popovers, toasts |
| `shadow-modal` | `0 10px 36px rgba(0,0,0,0.6)` | modales |

Todo lo demás (tablas, cards, hero) NO lleva sombra: `border border-border` (1px hairline) + paso de superficie.

### 1.5 Z-index, motion, otros

- Z-index: `dropdown 40 · modal 50 · toast 60`.
- Duraciones: `150ms` (hover, color), `200ms` (dropdown, panel), `300ms` máximo (skeleton shimmer). Easing: `ease-out` siempre.
- `html { color-scheme: dark; }` obligatorio (scrollbars y controles nativos oscuros).
- `<meta name="theme-color" content="#0B0C09">`.

### 1.6 Tailwind (mapeo canónico)

Tailwind v4 (`@theme`):

```css
@theme {
  --color-bg: #0B0C09;
  --color-surface: #14160F;
  --color-surface-2: #1D2015;
  --color-border: #2B2F1E;
  --color-border-strong: #3A402A;
  --color-text: #EDEFE3;
  --color-text-2: #A9B298;
  --color-accent: #8FD429;
  --color-accent-hover: #A9E84D;
  --color-accent-active: #79BC1F;
  --color-on-accent: #0E1405;
  --color-warning: #D9A62E;
  --color-danger: #E5484D;
  --color-danger-hover: #F2665C;
  --color-danger-fill: #D63C42;
  --color-danger-fill-hover: #C33236;
  --color-medal-gold: #E5B84B;
  --color-medal-silver: #C4CCC2;
  --color-medal-bronze: #C99055;
  --font-display: "Rajdhani", sans-serif;
  --font-body: "IBM Plex Sans", sans-serif;
}
```

(En v3, equivalente en `tailwind.config.js` → `theme.extend.colors/fontFamily`.)

---

## 2. Tipografía

**Display: Rajdhani** (Indian Type Foundry) — semi-condensada, terminales planos, carácter HUD/militar. Es la voz de la marca: títulos, labels, nav.
**Body/UI: IBM Plex Sans** — la voz de datos e interfaz. Elegida por tres razones verificadas: (1) **sus dígitos son tabulares por defecto** (los 10 dígitos miden 600/1000 UPM exactos en la build de Google Fonts — verificado binariamente; las tablas densas alinean sin depender de features que el subsetting pueda perder), (2) no es una fuente sobreusada (el detector de slop marcó a Inter), y (3) su ADN industrial IBM (máquinas de escribir, terminales, mainframes) encaja con el mundo técnico-militar sin disfraz. Rajdhani NO se usa en párrafos ni celdas de datos: su altura de x castiga en tamaños pequeños de lectura.

**Import exacto:**

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### 2.1 Escala

| Estilo | Font | Tamaño/line-height | Weight | Tracking | Uso |
|---|---|---|---|---|---|
| `display-xl` | Rajdhani | 32px/1.1 (28px móvil) | 700 | 0.02em | Título de página (SIEMPRE MAYÚSCULAS) |
| `display-l` | Rajdhani | 24px/1.15 | 700 | 0.02em | Títulos de sección, nombre en auth |
| `display-m` | Rajdhani | 18px/1.2 | 600 | 0.04em | Subtítulos, nombre de jugador en fila-card móvil |
| `label` | Rajdhani | 12px/1.2 | 600 | 0.08em | Labels de form, headers de columna, labels de stat (MAYÚSCULAS) |
| `body` | IBM Plex Sans | 14px/1.5 | 400 | 0 | UI base |
| `body-lg` | IBM Plex Sans | 16px/1.6 | 400 | 0 | Párrafos (instrucciones de vinculación, legal) |
| `body-strong` | IBM Plex Sans | 14px/1.5 | 600 | 0 | Nombre de jugador en tabla |
| `number-l` | IBM Plex Sans | 28px/1 (32px hero perfil) | 600 | 0 | Stats grandes (dígitos tabulares nativos) |
| `number-m` | IBM Plex Sans | 14px/1.2 | 500 | 0 | Celdas numéricas de tabla (dígitos tabulares nativos) |
| `caption` | IBM Plex Sans | 12px/1.4 | 400 | 0 | Metadatos ("Actualizado hace 4 min") |
| `mono` | ui-monospace stack | 13px/1.4 | 400 | 0 | SOLO GUIDs e IPs (dato técnico, no adorno) |

**Medida de párrafos:** todo bloque de prosa (`body-lg`) con `max-width: 68ch` — aplica a instrucciones de vinculación, descripciones de estados vacíos y copy legal.

`mono` = `ui-monospace, "Cascadia Mono", "Segoe UI Mono", Menlo, monospace`. Sin Google Fonts extra.

### 2.2 Números tabulares — REGLA DURA

IBM Plex Sans trae dígitos tabulares **por defecto** (verificado: los 10 dígitos comparten advance width en la build de Google Fonts). Aun así, fijar como salvaguarda global:

```css
.tabular, td[data-numeric], .stat-value { font-variant-numeric: tabular-nums; }
```

Prohibido cargar otra fuente body que no tenga dígitos de ancho uniforme (medir antes de cambiar: todos los dígitos `0-9` deben compartir la misma advance width, o exponer `tnum` en su GSUB).

Columnas numéricas de tabla: **alineadas a la derecha** (`text-right`), header de la columna también. K/D siempre con coma decimal española (`2,39`). Miles con punto (`12.430`). Usar `Intl.NumberFormat("es-ES")` y `Intl.RelativeTimeFormat("es")` — prohibido `toLocaleString()` sin locale.

---

## 3. Layout por página (wireframes)

### 3.1 Navbar (todas las páginas)

56px de alto (`h-14`), `sticky top-0`, fondo `surface` + `border-b border-border` (1px). Sin blur, sin transparencia.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▪ RANKING IW4X   LEADERBOARD  PERFIL  VINCULAR CUENTA      [ ENTRAR ]        │
└──────────────────────────────────────────────────────────────────────────────┘
  ↑ logo: marca SVG 20px + wordmark Rajdhani 700 16px, tracking 0.08em
    (wordmark = "{Nombre comunidad}" — placeholder hasta confirmar marca)
```

- Links: Rajdhani 600 14px MAYÚSCULAS tracking 0.04em, `text-secondary`; activo: `text-text` + subrayado de 2px `accent` pegado al borde inferior del navbar (no inline). Hover: `text-text` (150ms).
- Estado logged-in (derecha): avatar cuadrado 28px `rounded-sm` con iniciales + nombre IBM Plex Sans 500 14px + chevron. Dropdown (`shadow-panel`, `rounded-lg`): "Mi perfil", "Vincular cuenta", "Cerrar sesión".
- Sin login: botón **primary** "ENTRAR" (h-9).
- Mobile (<768): logo + hamburger (lucide `Menu`, 44px táctil). Abre panel debajo del navbar: links apilados h-12 + botón ENTRAR/Vincular, `surface`, hairline inferior por item.

### 3.2 Leaderboard (home — LA página)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ▪ RANKING IW4X   LEADERBOARD · PERFIL · VINCULAR        [ ENTRAR ]            │
├───────────────────────────────────────────────────────────────────────────────┤
│  RANKING DE LA COMUNIDAD                                    1.284 JUGADORES   │  display-xl / label
│  ACTUALIZADO HACE 4 MIN                                     caption 12px      │
│  ═════════════════════════════════════════════════════════════════════════════ │  hairline
│                                                                               │
│  [⌕ BUSCAR JUGADOR…            ]   [ TODOS ][ K/D ][ TIEMPO JUGADO ]          │  toolbar h-12
│   input 320px, icono 16px izq            segmented control                    │
│ ┌───────────────────────────────────────────────────────────────────────────┐ │
│ │ #    JUGADOR ▲         KILLS   MUERTES    K/D    SKILL   TIEMPO  ÚLT. CONEXIÓN │ header 40px surface
│ ├──────┬──────────────────┬────────┬─────────┬───────┬────────┬────────┬──────────┤ hairline
│ │ ① 1 │ Ghost_67          │ 12.430 │  5.210  │ 2,39  │ 1.824  │ 142 h  │ ● 2 h    │ fila 44px
│ │ ② 2 │ Viper_Hispano     │  9.812 │  4.635  │ 2,12  │ 1.691  │ 128 h  │  5 h     │
│ │ ③ 3 │ Aldo_Ruiz         │  8.204 │  4.517  │ 1,82  │ 1.540  │ 110 h  │  1 d     │
│ │   4 │ Nacht_Jäger       │  7.933 │  5.002  │ 1,59  │ 1.412  │  96 h  │  3 d     │
│ │   … │ …                 │   …    │   …     │  …    │   …    │   …    │  …       │
│ ├──────┴──────────────────┴────────┴─────────┴───────┴────────┴────────┴──────────┤
│ │ Mostrando 1–50 de 1.284                    [◀]  1  [2]  3  …  26  [▶]        │ footer 48px
│ └───────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Estructura:** el ranking es UN panel (`surface`, hairline), no cards. Título + meta arriba, hairline, toolbar, tabla.

**Toolbar:** búsqueda (`Input` con lucide `Search`, placeholder "Buscar jugador…", ancho 320px, filtra con debounce 300ms) + tabs de orden preset como segmented control (`rounded-sm`, activo: `accent-subtle` + `accent-border` + texto `accent`). Búsqueda activa deshabilita presets. Contador "1.284 JUGADORES" en `aria-live="polite"`.

**Columnas y anchos relativos (lg+):** `#` 56px · Jugador `minmax(180px, 1.6fr)` · Kills `0.7fr` · Muertes `0.8fr` · K/D `0.6fr` · Skill `0.6fr` · Tiempo jugado `0.9fr` · Últ. conexión `1.1fr`. Numéricas right-aligned.

**Headers ordenables:** `<th><button>` con lucide `ArrowUpDown` (sin orden) / `ArrowUp` / `ArrowDown` 14px; orden activo: texto `accent` + `aria-sort` en el `th`. Toggles asc/desc.

**Top 3:** celda `#` muestra lucide `Medal` 16px (`medal-gold/silver/bronze`) + número en el color de medalla (IBM Plex Sans 600 tabular). Fila #1: fondo `accent-subtle`. PROHIBIDO: bordes izquierdos gruesos de color, coronas, emojis.

**Jugador:** nombre IBM Plex Sans 600 `text-text` como link a `/player/:id` (ese link es el objetivo accesible; el click en la fila completa es mejora, no sustituto). Debajo en `caption` el GUID truncado en mono solo si el jugador está verificado.

**Últ. conexión:** estado "en línea" = punto `accent` 6px + "2 min" en `text-text`; offline = `text-secondary`. Formato relativo (ver §9).

**Paginación:** prev/next con lucide `ChevronLeft/Right` (32px, deshabilitado en extremos) + páginas numeradas; actual: `accent-subtle` + `accent-border` + texto `accent`. Izquierda: "Mostrando 1–50 de 1.284" en `caption`.

**Densidad:** filas de 44px, `py-2.5 px-3`, ceros sin miles invisibles, sin zebra (el hover y las hairlines dan la lectura de fila).

### 3.3 Perfil de jugador (`/player/:id`)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ← VOLVER AL RANKING                                              (nav 56px)│ breadcrumb link
│                                                                            │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │▒▒ franjas diagonales 3% ▒▒                                            │ │ hero panel surface
│ │ [AV]  GHOST_67                     #4 GLOBAL      ● EN LÍNEA          │ │ avatar 64px square
│ │ 64px  GUID: AB12CD34EF78 (mono)    Miembro desde mar 2026             │ │ nombre display-xl 32
│ ├──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────┤ │
│ │  KILLS   │ MUERTES  │   K/D    │  SKILL   │  TIEMPO  │  ÚLT. CONEXIÓN  │ │ stat strip (hairlines
│ │  12.430  │  5.210   │ 2,39  ▲  │  1.824   │  142 h   │  hace 2 min     │ │  verticales, NO cards)
│ └──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────┘ │
│                                                                            │
│  HISTORIAL DE PARTIDAS                                                     │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ FECHA          SERVIDOR            KILLS  MUERTES   K/D     DURACIÓN  │ │
│ │ 05 nov 20:14   [RUSH] Terminal       32       18     1,78     22 min   │ │
│ │ 04 nov 18:02   [TDM] Rust            27       21     1,29     18 min   │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Hero:** panel `surface` + hairline. Avatar cuadrado 64px `rounded-sm` `surface-2` con iniciales (Rajdhani 700 24px `text-secondary`; sin imágenes externas). Nombre en `display-xl` mayúsculas. Chips a la derecha: rank global (badge `accent-subtle`: "#4 GLOBAL") + estado conexión. Textura: `repeating-linear-gradient(45°, transparent 0 8px, rgba(143,212,41,0.03) 8px 9px)` — la ÚNICA textura permitida.
- **Stat strip:** 6 celdas separadas por hairlines verticales (`divide-x divide-border`), NO cards clónicas. Label arriba (`label` 12px `text-secondary`), número debajo (`number-l` 28–32px tabular). K/D lleva su color de umbral (§1.1). Móvil: grid 3 columnas × 2 filas con hairlines.
- **Historial:** tabla igual a la del leaderboard (mismos tokens), columnas: Fecha (izq), Servidor (izq, nombre con tag de modo en `[RUSH]`), Kills, Muertes, K/D (badge de color), Duración (der). Máx 4 columnas numéricas visibles en tablet (ocultar Duración y Fecha completa → fecha relativa).
- `StatCard` (componente boxed con hairline) queda definido en §4 para usos futuros (estado de servers); el hero del perfil NO lo usa.

### 3.4 Login / Registro (`/login`, `/register`)

```
│                    (fondo bg, sin navbar distinto, navbar normal arriba)     │
│                                                                              │
│                  ┌──────────────────────────────────────┐                    │
│                  │           ▪ RANKING IW4X             │  logo centrado     │
│                  │         ENTRA AL RANKING             │  display-l 24px    │
│                  │                                      │                    │
│                  │  [ INICIAR SESIÓN ║ CREAR CUENTA ]    │  toggle segmentado │
│                  │                                      │  full-width h-10   │
│                  │  EMAIL O USUARIO                     │  label 12px upper  │
│                  │  [______________________________]    │  input h-10        │
│                  │  CONTRASEÑA                          │                    │
│                  │  [__________________________] [👁]   │  eye = lucide      │
│                  │  ⚠ Esa contraseña no es correcta.    │  error inline      │
│                  │                                      │  danger-hover 13px │
│                  │  [            ENTRAR            ]    │  primary h-10 full │
│                  │  ────────────────────────────────    │  hairline          │
│                  │  ¿Juegas en nuestros servers?        │  body 13px         │
│                  │  VINCULA TU CUENTA DE JUEGO →        │  link accent       │
│                  └──────────────────────────────────────┘                    │
│                  panel: max-w-[400px], surface, hairline,                    │
│                  rounded-md, p-6, my-20, shadow-modal NO (no flota)          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Un solo componente `AuthCard` con dos modos (toggle arriba, segmented control full-width). Campos apilados `space-y-4`, labels SIEMPRE visibles (no floating labels). Errores inline bajo el campo, con lucide `AlertCircle` 14px.
- Registro añade: confirmar contraseña + checkbox "Acepto las normas de la comunidad" (obligatorio para enviar).
- Éxito de login → redirect a leaderboard (o a la página previa si venía de una). Éxito de registro → estado "Cuenta creada" + CTA "VINCULAR MI CUENTA" (el registro desemboca en el flujo de vinculación).

### 3.5 Vincular mi cuenta (`/link`)

Flujo paso a paso NUMERADO (el número SÍ aporta información aquí: es una secuencia operativa).

```
│  VINCULA TU CUENTA DE JUEGO                            display-xl            │
│  4 pasos, 2 minutos. Tu progreso del server aparece en el ranking.  body-lg   │
│                                                                              │
│  ( 1 INSTRUCCIONES )──────( 2 DETECCIÓN )──────( 3 TU GUID )──────( 4 LISTO )│
│   ↑ stepper: círculos 28px; completos: accent relleno + check;             │
│     activo: accent-border + número accent; futuros: border + text-secondary │
│                                                                              │
│ ┌ PASO 1 DE 4 ─ ÚNETE A UN SERVIDOR ───────────────────────────────────────┐ │
│ │ 1. Abre IW4x y entra a cualquier servidor de la comunidad:               │ │
│ │    ┌────────────────────────────────────┐                                │ │
│ │    │ cl.example.net:28960      [COPIAR] │ ← IP en mono, chip surface-2   │ │
│ │    └────────────────────────────────────┘                                │ │
│ │ 2. Juega al menos una ronda (30 segundos bastan).                        │ │
│ │ 3. Vuelve a esta pestaña SIN cerrar el juego.                            │ │
│ │                                                                          │ │
│ │                                        [ DETECTAR MI CUENTA → ]          │ │ primary
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌ PASO 2 DE 4 ─ BUSCANDO EN LOS SERVIDORES ────────────────────────────────┐ │
│ │  [spinner 20px accent]  Escaneando jugadores conectados…                 │ │
│ │  (estado de error: "No encontramos ninguna cuenta nueva…" + tips +       │ │
│ │   [ REINTENTAR ])                                                        │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌ PASO 3 DE 4 ─ ELIGE TU JUGADOR ──────────────────────────────────────────┐ │
│ │  Encontramos estos jugadores conectados recientemente:                   │ │
│ │  ◉ Ghost_67    GUID AB12CD34 (mono)   [RUSH] Terminal · hace 2 min      │ │
│ │  ○ GHOST_67_   GUID 99FA21BC (mono)   [TDM] Rust      · hace 1 d        │ │
│ │  (radio rows h-14, hover surface-2, seleccionada: accent-border)         │ │
│ │                       [ VOLVER ]   [ CONFIRMAR JUGADOR → ]               │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌ PASO 4 DE 4 ─ TODO LISTO ────────────────────────────────────────────────┐ │
│ │           ( ✓ check lucide 40px accent, trazado animado — ÚNICO momento  │ │
│ │             de motion de marca del sitio )                                │ │
│ │  Ghost_67 quedó vinculado a tu cuenta.                                   │ │
│ │  Ya apareces en el ranking de la comunidad.                              │ │
│ │                        [ VER MI PERFIL ]                                 │ │ primary
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Cada paso es un panel `surface` + hairline; solo el paso activo está montado (el stepper comunica el resto). Nada de wizard modal.
- Detección: al pulsar, botón → estado loading (spinner + "Escaneando…") y polling al backend (máx 30s). `aria-live` anuncia resultado.
- Candidatos: radio group accesible (`role="radiogroup"`), click en fila = selecciona; botón confirmar deshabilitado sin selección.

---

## 4. Componentes (especificación)

### Button
`h-10 px-4 rounded-sm label-style (Rajdhani 600 14 MAYÚSCULAS tracking 0.04em)`, iconos 16px, `disabled:opacity-40 + cursor-not-allowed`, transición 150ms.

| Variante | Reposo | Hover | Texto |
|---|---|---|---|
| `primary` | `bg-accent` | `bg-accent-hover` | `on-accent` |
| `ghost` | transparente + `border border-border-strong` + texto `text-text` | `bg-surface-2` | `text-text` |
| `danger` | `bg-danger-fill` | `bg-danger-fill-hover` | `#FFFFFF` |

Tamaños: `sm` h-8 px-3 (toolbar/paginación), `md` h-10 (default), botón full-width en auth. Loading: icono → spinner 16px + label "Cargando…"/acción actual, deshabilitado.

### Input
`h-10 rounded-sm bg-surface-2 border border-border px-3 text-body text-text`, placeholder `#7F8A6E`. Focus visible: `border-accent` + `box-shadow: 0 0 0 1px #8FD429` (línea interior de 1px; el outline global de §6 queda cubierto por este borde). Error: `border-danger` + mensaje inline (§4). Icono opcional izq 16px `text-secondary`. `caret-color: accent`. Disabled: `opacity-40 cursor-not-allowed`.

### Badge / Chip
`inline-flex items-center gap-1 h-6 px-2 rounded-none text-[12px] font-medium tabular-nums` (IBM Plex Sans). Variantes: `success` (bg `accent-subtle` + `accent-border` + texto `accent`), `warning` (bg `warning/10` + texto `warning`), `danger` (bg `danger/10` + texto `danger-hover`), `neutral` (bg `surface-2` + texto `text-secondary`). Uso principal: K/D por umbral (§1.1), rank global ("#4 GLOBAL"), estado conexión. Sin pills (`rounded-full` prohibido aquí).

### Table + Row
`<table class="w-full">` en panel con `overflow-x-auto` (md). thead: `bg-surface`, `label` 12px `text-secondary`, height 40px, hairline inferior `border`. tbody: filas 44px, `border-b border-border` (última sin borde). Hover: `bg-surface-2` 150ms; filas navegables además `cursor-pointer`. Fila #1: `bg-accent-subtle` (el hover encima la pasa a `surface-2`, no acumular). Selected (flujo vinculación): `accent-border` en top+bottom.

### Pagination
`h-8` botones ghost, gap-1, página actual según §3.2. Siempre con texto "Mostrando X–Y de Z" a la izquierda (caption). Botones con `aria-label` ("Página 2", "Página siguiente").

### Navbar
Ver §3.1. Estado logged-in: dropdown con 3 items h-9 + hairline antes de "Cerrar sesión" (ese item en `danger-hover`).

### StatCard (uso futuro: estado de servidores, dashboard admin)
Panel `surface` + hairline `rounded-md p-4`: label (12px Rajdhani upper `text-secondary`) + valor (`number-l` tabular `text-text`) + delta opcional (caption con flecha lucide y color success/danger). Prohibido usarlo en fila de >4 idénticos para el perfil (ahí va el stat strip con hairlines).

### Spinner / Skeleton
- Spinner: lucide `LoaderCircle` 16–20px `text-accent`, `animate-spin`.
- Skeletons: bloques `rounded-sm bg-surface-2` con shimmer: `background-image: linear-gradient(90deg, transparent, rgba(237,239,227,0.05), transparent)`, `background-size: 200% 100%`, animación 1.4s infinite. Tabla cargando: thead real + 6 filas skeleton con anchos variables por celda (85%, 70%, 90%… NO todas iguales). Perfil: hero skeleton + stat strip skeleton. Respeta `prefers-reduced-motion` (ver §7).

### Estados vacíos y de error
Patrón único, centrado en el panel: icono lucide 32px `text-secondary` → título (`display-m` MAYÚSCULAS) → descripción (body `text-secondary`, max-w-sm) → CTA opcional. Iconos por caso: `SearchX` (sin resultados), `Inbox` (sin datos), `UserX` (perfil inexistente), `WifiOff` (error de red), `ShieldAlert` (error de permiso/vinculación). Copys exactos en §9.

---

## 5. Responsive

Breakpoints Tailwind estándar: `sm 640 · md 768 · lg 1024 · xl 1280`.

**Decisión de tabla (DECIDIDO): jerarquía en dos pasos, sin scroll horizontal en móvil.**
- `lg+`: tabla completa (8 columnas).
- `md–lg`: sigue siendo tabla; se ocultan `Skill` y `Últ. conexión` (`hidden lg:table-cell`).
- `<md`: las filas se transforman en **fila-cards dentro de la misma lista** (NO cards flotantes en grid): cada fila es un bloque con hairline inferior, así se preserva el ritmo de lista del leaderboard:

```
┌────────────────────────────────────┐
│ ① 1  Ghost_67             K/D 2,39 │  rank+medalla izq · nombre display-m
│       12.430 K · 5.210 M · 142 h   │  caption 12px · K/D number-m coloreado der.
├────────────────────────────────────┤  ← hairline (lista dividida, no cards)
│ ② 2  Viper_Hispano        K/D 2,12 │
│       9.812 K · 4.635 M · 128 h    │
└────────────────────────────────────┘
```

Implementación: dos renderizados (`<table class="hidden md:table">` + lista `<ul class="md:hidden">`) desde los mismos datos; no CSS hacks sobre `<tr>`.

**Toolbar móvil:** búsqueda full-width; tabs de orden debajo, scrollables horizontalmente si no caben (`overflow-x-auto`, sin wrap).

**Perfil móvil:** stat strip → grid 3×2 con hairlines; hero: avatar 48px + nombre 24px; chips de rank/estado debajo del nombre.

**Auth móvil:** panel `max-w-[400px]` a `w-full px-4`, `my-12`.

**Navbar móvil:** ver §3.1 (hamburger + panel). Botones de página (primary) mantienen h-10 y ancho completo donde tenga sentido (auth, paso de vinculación).

---

## 6. Accesibilidad (mínimo AA, objetivo AAA en texto principal)

- **Contraste:** todos los pares de §1.1 verificados ≥4.5:1 para texto pequeño. El par crítico (botón danger) usa `#D63C42` + blanco (4.6:1) — no usar `#E5484D` como relleno con texto encima.
- **Focus SIEMPRE visible:** `:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 2px; }` global. Prohibido eliminarlo en cualquier componente. En inputs: además `border-accent`.
- **Tabla:** `<caption class="sr-only">` ("Ranking de jugadores de la comunidad, ordenado por…"), `scope="col"` en headers, `aria-sort` en la columna ordenada, headers ordenables como `<button>` con `aria-label` ("Ordenar por kills, ascendente").
- **Row clickable:** el `<a>` del nombre es el objetivo de teclado; el click de fila es enhancement con `onClick`, jamás `tabindex=0` en el `tr`.
- **Live regions:** `aria-live="polite"` en: contador de resultados de búsqueda, estado del botón Detectar (§3.5), mensajes de error de form (`role="alert"`).
- **Skip link:** "Saltar al contenido" (visible al enfocar, `accent` bg).
- **Teclado:** todo interactivo tabulable en orden DOM; tabs/stepper con flechas; radios nativos estilizados en paso 3; `Esc` cierra dropdown/menú móvil.
- **Targets táctiles:** mínimo 40×40px (paginación h-8 dentro de hit-area de 40, hamburger 44px).
- **`prefers-reduced-motion: reduce`:** apagar shimmer (bloque estático con `opacity: 0.6`), transiciones → 0ms, check del paso 4 aparece sin animación de trazo.
- **Iconos:** todos con `aria-hidden="true"` cuando el texto adyacente los explica; con `aria-label` cuando son el único contenido (hamburger).

---

## 7. Microinteracciones (150–200ms, una sola pieza de marca)

| Interacción | Comportamiento |
|---|---|
| Hover de fila | `bg-surface-2`, 150ms ease-out. Sin scale, sin shadow. |
| Botones | color/fondo 150ms. primary hover sube luminosidad (`accent-hover`); active `accent-active`. danger hover oscurece. |
| Orden de columna | icono cambia ArrowUpDown→ArrowUp/Down, 150ms; texto del header a `accent`. |
| Dropdown / menú móvil | fade + translateY(-2px→0), 200ms ease-out, `shadow-panel`. |
| Skeleton shimmer | 1.4s infinite (§4). |
| Copy de IP (vinculación) | icono `Copy` → `Check` 1.5s + caption "Copiada". |
| **Momento de marca (ÚNICO):** | check del paso 4 de vinculación: lucide `Check` 40px con stroke-dashoffset animado 400ms ease-out. Todo lo demás es funcional y corto. |

Prohibido: entradas escalonadas de secciones, parallax, glow, pulse permanente (el punto "en línea" es estático), animación al hover de números.

---

## 8. Detalles de "built, not assembled" (chrome del navegador temeado)

```css
::selection { background: #8FD429; color: #0E1405; }
html { color-scheme: dark; scrollbar-color: #3A402A #0B0C09; }
::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-thumb { background: #2B2F1E; border: 2px solid #0B0C09; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #3A402A; }
* { caret-color: #8FD429; }
a { text-underline-offset: 3px; }
```

Links inline (en párrafos): `text-accent underline decoration-accent/40 hover:decoration-accent`.

---

## 9. Copys (español, exactos — copiar literal)

**Vacíos:**
- Leaderboard sin datos: **"Todavía no hay partidas registradas en los servidores de la comunidad."** / "Entra a un servidor y tu nombre aparecerá aquí automáticamente." / CTA ghost: "VER SERVIDORES"
- Búsqueda sin resultados: **"Ningún jugador coincide con «{query}»."** / "Revisa la ortografía o prueba con menos caracteres."
- Historial vacío (perfil): **"Sin partidas recientes."** / "Cuando {jugador} entre a un servidor, verás su actividad aquí."
- Perfil inexistente: **"Este jugador no existe."** / "Puede que nunca haya jugado en nuestros servidores." / CTA ghost: "VOLVER AL RANKING"

**Errores:**
- Carga fallida: **"No pudimos cargar el ranking."** / "Comprueba tu conexión e inténtalo de nuevo." / CTA primary: "REINTENTAR"
- Detección sin coincidencias: **"No encontramos ninguna cuenta nueva en los servidores."** / "Comprueba que estás dentro de una partida y vuelve a intentarlo en unos segundos." / CTA: "REINTENTAR"
- Form genérico: "Revisa los campos marcados." — por campo: "Escribe tu email o usuario." / "La contraseña debe tener al menos 8 caracteres." / "Las contraseñas no coinciden." / "Esa contraseña no es correcta." / "Ese usuario ya está registrado."

**CTAs:** `ENTRAR` · `CREAR CUENTA` · `VINCULAR MI CUENTA` · `DETECTAR MI CUENTA` · `CONFIRMAR JUGADOR` · `CONFIRMAR VINCULACIÓN` · `VER MI PERFIL` · `REINTENTAR` · `COPIAR` · `VOLVER` · `CERRAR SESIÓN` · placeholder búsqueda: "Buscar jugador…"

**Éxito de vinculación (toast + paso 4):** "Ghost_67 quedó vinculado a tu cuenta." / "Ya apareces en el ranking de la comunidad." — Toast: "Cuenta vinculada. Bienvenido al ranking, {nombre}."

**Formato de datos (`es-ES`):** miles `12.430` · decimales `2,39` · tiempo ≥1h → `142 h`, <1h → `37 min` · última conexión: `hace 2 min / hace 5 h / hace 3 días / el 12 mar` · en línea: `En línea` con punto `accent`.

---

## 10. Reglas inquebrantables para frontend-dev

1. **Los hex de §1.1 son la única fuente de color.** Prohibido introducir tonos nuevos. Los grises puros (`#808080`, `#FFF`, `#000`) no existen en este sistema.
2. **`tabular-nums` + alineación derecha en TODA columna numérica.** K/D con coma. `Intl` con locale `es-ES` siempre.
3. **Prohibido:** gradientes decorativos (excepciones: shimmer de skeleton y franjas del hero con los valores exactos de este doc) · gradient text · glassmorphism/backdrop-blur · glow · emojis como iconos (iconos: `lucide-react`, stroke 1.75, 16–20px) · pills (`rounded-full`) fuera del punto de estado · `border-left` de color >1px en cards/filas/callouts · kickers/eyebrows sobre headings (el heading habla solo) · cards idénticas en fila (el perfil usa stat strip con hairlines) · sombras con offset 0 · fuentes display en párrafos o celdas de datos.
4. **Foco visible nunca removido** (§6). Skip link incluido.
5. **Rajdhani solo para display/labels/nav/botones; IBM Plex Sans para todo lo que se lee o se cuenta.** Mono solo para GUID/IP.
6. **Un acento.** El verde HUD es éxito, marca y foco a la vez. El rojo solo comunica peligro/error; el ámbar solo aviso; las medallas solo en la celda `#` del top 3.
7. **Densidad > decoración:** filas de 44px, hairlines de 1px, radios ≤6px. Si un elemento necesita "llamar la atención", gánalo con jerarquía (tamaño/peso/color de dato), no con caja nueva.
8. Dark first, `color-scheme: dark`, `theme-color` meta. No hay tema claro — no implementarlo.

---

## 11. Supuestos etiquetados (confirmar con el orquestador si cambia algo)

- **Supuesto A:** sin datos de períodos (semanal/mensual) → las tabs de orden son presets estáticos (Todos/K-D/Tiempo). Si llega telemetría temporal, el segmented control pasa a "Global | Semanal" sin cambiar nada más.
- **Supuesto B:** GUID visible solo en perfil y flujo de vinculación (privacidad razonable); en leaderboard va truncado solo si el jugador está vinculado/verificado.
- **Supuesto C:** la marca (nombre de la comunidad) es placeholder "RANKING IW4X" en el wordmark; el logo es un cuadrado SVG 20px con borde `accent` hasta tener asset real.
- **Supuesto D:** el historial de partidas del perfil asume columnas fecha/servidor/kills/muertes/KD/duración; ajustar a lo que exponga la API sin romper la estructura.
- **Supuesto E:** "skill score" es opcional en datos; si no existe para un jugador, la celda muestra "—" en `text-secondary` (nunca 0).
