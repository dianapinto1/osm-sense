"""
Paso 3 - Genera (una sola vez, antes de la charla) las respuestas en lenguaje natural.

Uso:  python scripts/paso3_generar_respuestas.py
Entradas: web/data/resumen.json, scripts/preguntas.json, .env (llave y modelo)
Salida:   web/data/respuestas.json

Reglas de IA responsable que aplica este script:
- El modelo solo recibe datos de OSM de la zona; se le prohíbe agregar información.
- Debe citar los IDs de OSM que usa. El script VERIFICA que cada ID citado exista
  en los datos; los que no existan se descartan y se marcan como "ids_invalidos".
- Debe declarar qué datos faltan para responder bien.
- Temperatura baja para respuestas estables.
"""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = json.loads((RAIZ / "config.json").read_text(encoding="utf-8"))


def cargar_env():
    ruta = RAIZ / ".env"
    if not ruta.exists():
        sys.exit("Falta el archivo .env. Copia .env.example como .env y pon tu llave.")
    for linea in ruta.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if linea and not linea.startswith("#") and "=" in linea:
            k, v = linea.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


INSTRUCCIONES = """Eres OSM Sense, un asistente que explica el territorio a personas no expertas
(niñas y niños, adultos mayores, personas con baja visión) usando EXCLUSIVAMENTE los datos
de OpenStreetMap que se te entregan en formato JSON.

Reglas obligatorias:
1. No inventes lugares, nombres, horarios, distancias ni características. Si algo no está en los datos, no existe para ti.
2. Cada lugar que menciones debe estar en los datos; incluye su "id" en "ids_citados".
3. Usa las distancias del campo "distancia_m" (medidas desde el punto central). No calcules otras.
4. Si los datos son insuficientes o incompletos, dilo con claridad (por ejemplo: "OpenStreetMap no tiene información sobre accesibilidad de estos andenes").
5. Lenguaje claro, frases cortas, tono amable, español neutro. Nada de etiquetas técnicas como amenity=school.
6. "respuesta": máximo 120 palabras. "respuesta_simple": la misma idea en máximo 50 palabras, con palabras muy sencillas, como para un niño de 8 años.
7. Al final de "respuesta" recuerda brevemente que la información viene de OpenStreetMap y puede estar incompleta.

Responde SOLO con un objeto JSON con esta forma exacta:
{"respuesta": "...", "respuesta_simple": "...", "ids_citados": ["node/123", "way/456"], "datos_faltantes": ["..."]}"""


def contexto_para(pregunta, resumen):
    radio = CONFIG["radio_cercania_m"]
    cats = set(pregunta.get("categorias") or [])
    elementos = [e for e in resumen["elementos"]
                 if e["distancia_m"] <= radio and (not cats or e["categoria"] in cats)]
    elementos = elementos[: CONFIG["max_elementos_por_pregunta"]]
    vacios = {k: v for k, v in resumen["vacios"].items() if not k.startswith("ids_")}
    return {
        "zona": resumen["zona"], "ciudad": resumen["ciudad"],
        "radio_considerado_m": radio,
        "conteo_por_categoria_en_toda_la_zona": resumen["conteo_por_categoria"],
        "lugares": elementos,
        "estado_de_los_datos": vacios,
    }


def preguntar(texto, contexto):
    url = os.environ["LLM_BASE_URL"].rstrip("/") + "/chat/completions"
    cuerpo = {
        "model": os.environ["LLM_MODEL"],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": INSTRUCCIONES},
            {"role": "user", "content": f"Pregunta: {texto}\n\nDatos de OpenStreetMap:\n"
                                        + json.dumps(contexto, ensure_ascii=False)},
        ],
    }
    for intento in range(3):
        r = requests.post(url, json=cuerpo, timeout=120,
                          headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}"})
        if r.status_code == 429:  # límite de la capa gratuita: esperar y reintentar
            time.sleep(20 * (intento + 1))
            continue
        r.raise_for_status()
        contenido = r.json()["choices"][0]["message"]["content"]
        return json.loads(contenido)
    sys.exit("Se alcanzó el límite de solicitudes. Espera unos minutos y vuelve a correr el script.")


def main():
    cargar_env()
    resumen = json.loads((RAIZ / "web" / "data" / "resumen.json").read_text(encoding="utf-8"))
    preguntas = json.loads((RAIZ / "scripts" / "preguntas.json").read_text(encoding="utf-8"))
    ids_validos = {e["id"] for e in resumen["elementos"]} | set(resumen["vacios"]["ids_vias_sin_dato_silla_ruedas"])

    resultados = []
    for p in preguntas:
        print(f"-> {p['texto']}")
        r = preguntar(p["texto"], contexto_para(p, resumen))
        citados = [i for i in r.get("ids_citados", []) if isinstance(i, str)]
        validos = [i for i in citados if i in ids_validos]
        invalidos = [i for i in citados if i not in ids_validos]
        if invalidos:
            print(f"   ATENCIÓN: la IA citó IDs que no existen en los datos: {invalidos} (revisa esta respuesta)")
        resultados.append({
            "id": p["id"], "pregunta": p["texto"],
            "respuesta": r.get("respuesta", ""), "respuesta_simple": r.get("respuesta_simple", ""),
            "ids_citados": validos, "ids_invalidos": invalidos,
            "datos_faltantes": r.get("datos_faltantes", []),
        })
        time.sleep(2)

    salida = {
        "modelo": os.environ["LLM_MODEL"],
        "generado": datetime.now().isoformat(timespec="minutes"),
        "aviso": "Respuestas generadas por IA a partir de datos de OpenStreetMap y revisadas por el equipo.",
        "respuestas": resultados,
    }
    (RAIZ / "web" / "data" / "respuestas.json").write_text(
        json.dumps(salida, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Listo: web/data/respuestas.json. LÉELAS antes de la charla y corrige lo que haga falta.")


if __name__ == "__main__":
    main()
