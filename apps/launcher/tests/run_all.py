"""Runner de la suite del launcher: primero units, luego smoke.

Uso:
    py apps\\launcher\\tests\\run_all.py

Orden y motivo:
  1. test_units.py  — funciones puras, SIN red y SIN GUI. Falla aquí:
     parar sin tocar la API (es lo más rápido de diagnosticar).
  2. test_smoke.py  — E2E/GUI en vivo contra la API real (:3000) y
     CustomTkinter. Requiere la API corriendo.

Al final imprime un resumen por archivo (checks OK / fallidos, tiempo)
y sale con código != 0 si algún check falla o si una suite se cuelga.
NO es pytest: lanza los scripts secuencialmente en subprocesos.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

TESTS_DIR = Path(__file__).resolve().parent
LAUNCHER_DIR = TESTS_DIR.parent

# (nombre visible, archivo, necesita API)
SUITES = [
    ("units (puras, sin red)", "test_units.py", False),
    ("smoke (E2E/GUI, API real)", "test_smoke.py", True),
]


def run_suite(label: str, script: str) -> Tuple[int, int, int, float]:
    """Corre un script de tests y cuenta sus checks. Devuelve (ok, fallos, exit, segs)."""
    script_path = TESTS_DIR / script
    print(f"\n{'=' * 52}")
    print(f"=== SUITE: {label} → {script} ===")
    print("=" * 52)

    t0 = time.monotonic()
    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        cwd=str(LAUNCHER_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    ok = 0
    fails = 0
    summary: Optional[str] = None
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        stripped = line.lstrip()
        if stripped.startswith("[OK   ") or stripped.startswith("[OK") and "]" in stripped[:8]:
            ok += 1
        elif stripped.startswith("[FALLO"):
            fails += 1
        elif stripped.startswith("Pasos:") and "Fallos:" in stripped:
            summary = stripped.strip()
    code = proc.wait()
    elapsed = time.monotonic() - t0
    # El propio script ya imprime su resumen; lo dejamos como autoridad
    # si el conteo por líneas no cuadrara (líneas envueltas, etc.).
    if summary is not None:
        try:
            pasos_str, fallos_str = summary.split("Fallos:")
            pasos = int(pasos_str.split("Pasos:")[1].strip())
            fails = int(fallos_str.strip())
            ok = pasos - fails
        except (ValueError, IndexError):
            pass
    return ok, fails, code, elapsed


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("Suite del launcher IW4x Ranking — run_all (units → smoke)")
    print(f"Directorio: {LAUNCHER_DIR}")

    rows: List[Tuple[str, int, int, int, float]] = []
    crashed = False
    for label, script, needs_api in SUITES:
        ok, fails, code, elapsed = run_suite(label, script)
        rows.append((script, ok, fails, code, elapsed))
        if code != 0 or (fails > 0 and ok == 0):
            crashed = True
            print(f"\n>>> {script} terminó con exit={code}: no se continúa ordenado, "
                  "pero se corren las suites restantes para el diagnóstico completo.")

    print("\n================= RESUMEN GLOBAL =================")
    print(f"{'Archivo':<16}{'OK':>7}{'Fallos':>8}{'Proceso':>10}{'Tiempo':>12}")
    total_ok = 0
    total_fails = 0
    for script, ok, fails, code, elapsed in rows:
        total_ok += ok
        total_fails += fails
        state = "OK" if (code == 0 and fails == 0) else f"exit={code}"
        print(f"{script:<16}{ok:>7}{fails:>8}{state:>10}{elapsed:>10.1f}s")
    print("-" * 53)
    print(f"{'TOTAL':<16}{total_ok:>7}{total_fails:>8}")
    print("=" * 53)

    return 0 if (total_fails == 0 and not crashed) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("\nInterrumpido por el usuario.")
        sys.exit(130)
    except Exception as exc:
        print(f"Error del runner: {exc}")
        sys.exit(3)
