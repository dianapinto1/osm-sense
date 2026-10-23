4"""
OSM Sense – punto de entrada principal
=======================================
Ejecuta:  python main.py

Menú interactivo que guía por los 4 pasos del proyecto:
  1. Descargar datos de OSM (requiere internet)
  2. Clasificar y detectar vacíos
  3. Generar respuestas con IA (requiere .env con LLM_API_KEY)
  4. Abrir el visor web en http://localhost:8080
  0. Ejecutar todos los pasos (1 → 2 → 3 → 4)
"""
import json
import os
import subprocess
import sys
import webbrowser
from pathlib import Path
from threading import Timer

RAIZ = Path(__file__).resolve().parent

# ── colores ANSI (se desactivan automáticamente en Windows sin soporte) ──────
def _supports_color():
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

if _supports_color():
    BOLD  = "\033[1m"
    GREEN = "\033[32m"
    CYAN  = "\033[36m"
    YELLOW= "\033[33m"
    RED   = "\033[31m"
    RESET = "\033[0m"
else:
    BOLD = GREEN = CYAN = YELLOW = RED = RESET = ""


def titulo(texto):
    ancho = 60
    print(f"\n{BOLD}{CYAN}{'─' * ancho}{RESET}")
    print(f"{BOLD}{CYAN}  {texto}{RESET}")
    print(f"{BOLD}{CYAN}{'─' * ancho}{RESET}\n")


def ok(msg):    print(f"{GREEN}✔  {msg}{RESET}")
def info(msg):  print(f"{CYAN}ℹ  {msg}{RESET}")
def warn(msg):  print(f"{YELLOW}⚠  {msg}{RESET}")
def error(msg): print(f"{RED}✘  {msg}{RESET}")


def verificar_env():
    """Verifica requisitos mínimos antes de cada paso."""
    python_ok = sys.version_info >= (3, 10)
    if not python_ok:
        error(f"Se requiere Python 3.10+. Tienes {sys.version}")
        sys.exit(1)

    try:
        import requests  # noqa: F401
    except ImportError:
        warn("El paquete 'requests' no está instalado. Instalando…")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
        ok("requests instalado.")


def ejecutar_script(nombre_script):
    """Corre un script de la carpeta scripts/ en el mismo intérprete."""
    ruta = RAIZ / "scripts" / nombre_script
    resultado = subprocess.run(
        [sys.executable, str(ruta)],
        cwd=str(RAIZ),
    )
    return resultado.returncode == 0


def verificar_datos_crudos():
    destino = RAIZ / "datos_crudos" / "overpass.json"
    if not destino.exists():
        error(f"No existe {destino}.")
        info("Ejecuta primero el Paso 1 para descargar los datos de OSM.")
        return False
    return True


def verificar_resumen():
    destino = RAIZ / "web" / "data" / "resumen.json"
    if not destino.exists():
        error(f"No existe {destino}.")
        info("Ejecuta primero el Paso 2 para clasificar los datos.")
        return False
    return True


def verificar_env_file():
    env = RAIZ / ".env"
    if not env.exists():
        error("No existe el archivo .env")
        info("Copia .env.example como .env y agrega tu llave de API:")
        print(f"   {RAIZ / '.env.example'}")
        return False
    # Verificar que no tenga el placeholder
    contenido = env.read_text(encoding="utf-8")
    if "pega_aqui_tu_llave" in contenido:
        error("El .env todavía tiene el valor de ejemplo 'pega_aqui_tu_llave'.")
        info("Edita .env y reemplaza el valor de LLM_API_KEY con tu llave real.")
        return False
    return True


# ── Pasos ────────────────────────────────────────────────────────────────────

def paso1():
    titulo("Paso 1 – Descargar datos de OpenStreetMap")
    config = json.loads((RAIZ / "config.json").read_text(encoding="utf-8"))
    zona = config["zona"]["nombre"]
    info(f"Zona configurada: {zona}")
    info("Consultando Overpass API… puede tardar 1-2 minutos.")
    exito = ejecutar_script("paso1_descargar_osm.py")
    if exito:
        ok("Datos descargados en datos_crudos/overpass.json")
    else:
        error("El paso 1 terminó con errores. Revisa el mensaje anterior.")
    return exito


def paso2():
    titulo("Paso 2 – Clasificar y detectar vacíos")
    if not verificar_datos_crudos():
        return False
    exito = ejecutar_script("paso2_clasificar.py")
    if exito:
        ok("Archivos generados: web/data/zona.geojson  y  web/data/resumen.json")
    else:
        error("El paso 2 terminó con errores.")
    return exito


def paso3():
    titulo("Paso 3 – Generar respuestas con IA")
    if not verificar_resumen():
        return False
    if not verificar_env_file():
        return False
    info("Enviando preguntas a la IA (puede tardar varios segundos por pregunta)…")
    exito = ejecutar_script("paso3_generar_respuestas.py")
    if exito:
        ok("Respuestas guardadas en web/data/respuestas.json")
        warn("LEE y revisa ese archivo antes de usarlo en una presentación.")
    else:
        error("El paso 3 terminó con errores.")
    return exito


def paso4():
    titulo("Paso 4 – Abrir el visor web")
    web_dir = RAIZ / "web"
    if not (web_dir / "index.html").exists():
        error(f"No existe {web_dir / 'index.html'}")
        return False

    puerto = 8080
    url = f"http://localhost:{puerto}"
    info(f"Iniciando servidor en {url}")
    info("Presiona Ctrl+C para detenerlo.\n")

    # Abre el navegador automáticamente tras 1.5 s
    Timer(1.5, lambda: webbrowser.open(url)).start()

    try:
        subprocess.run(
            [sys.executable, "-m", "http.server", str(puerto)],
            cwd=str(web_dir),
        )
    except KeyboardInterrupt:
        print(f"\n{YELLOW}Servidor detenido.{RESET}")
    return True


# ── Menú principal ────────────────────────────────────────────────────────────

def menu():
    verificar_env()

    opciones = {
        "1": ("Descargar datos de OSM (Overpass API)",   paso1),
        "2": ("Clasificar datos y detectar vacíos",       paso2),
        "3": ("Generar respuestas con IA (requiere .env)",paso3),
        "4": ("Abrir visor web en http://localhost:8080", paso4),
    }

    while True:
        titulo("OSM Sense – menú principal")
        for k, (desc, _) in opciones.items():
            print(f"  {BOLD}{k}{RESET}  {desc}")
        print(f"\n  {BOLD}0{RESET}  Ejecutar todo (pasos 1 → 2 → 3 → 4)")
        print(f"  {BOLD}q{RESET}  Salir\n")

        eleccion = input("¿Qué deseas hacer? ").strip().lower()

        if eleccion == "q":
            print("¡Hasta luego!")
            break
        elif eleccion == "0":
            for k in ["1", "2", "3", "4"]:
                if not opciones[k][1]():
                    error("Se detuvo el proceso por un error. Corrige el problema y vuelve a intentarlo.")
                    break
        elif eleccion in opciones:
            opciones[eleccion][1]()
        else:
            warn("Opción no válida. Escribe 1, 2, 3, 4, 0 o q.")

        if eleccion != "4":          # paso 4 es bloqueante (servidor)
            input(f"\n{CYAN}Presiona Enter para volver al menú…{RESET}")


if __name__ == "__main__":
    menu()
