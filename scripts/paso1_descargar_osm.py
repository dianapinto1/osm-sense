"""
Paso 1 - Descarga los datos de OSM de la zona piloto (Overpass API) y los guarda.

Uso:  python scripts/paso1_descargar_osm.py
Salida: datos_crudos/overpass.json

Alternativa sin script: haz la consulta en overpass-turbo.eu y usa
"Exportar -> datos sin procesar (raw OSM data / JSON)"; guarda el archivo como
datos_crudos/overpass.json.
"""
import json
import sys
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = json.loads((RAIZ / "config.json").read_text(encoding="utf-8"))


def construir_consulta(bbox):
    s, o, n, e = bbox
    b = f"({s},{o},{n},{e})"
    # Puntos de interés: con su centro. Vías peatonales: con su geometría.
    return f"""
[out:json][timeout:180];
(
  nwr["amenity"]{b};
  nwr["healthcare"]{b};
  nwr["shop"]{b};
  nwr["leisure"~"^(park|playground|pitch|sports_centre|garden)$"]{b};
  nwr["highway"="bus_stop"]{b};
  nwr["public_transport"~"^(platform|station)$"]{b};
);
out center tags;
way["highway"~"^(footway|pedestrian|path|steps)$"]{b};
out geom tags;
"""


SERVIDORES_FALLBACK = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def main():
    consulta = construir_consulta(CONFIG["zona"]["bbox_sur_oeste_norte_este"])

    # Lista de servidores: el configurado primero, luego los fallbacks sin repetir
    servidores = [CONFIG["overpass_url"]] + [s for s in SERVIDORES_FALLBACK if s != CONFIG["overpass_url"]]

    r = None
    for url in servidores:
        print(f"Consultando {url} ... (puede tardar hasta 1-2 minutos)")
        try:
            r = requests.post(
                url,
                data={"data": consulta},
                headers={"User-Agent": "OSM-Sense-prototipo/0.1 (SotM Latam 2026)"},
                timeout=240,
            )
            r.raise_for_status()
            print(f"Respuesta OK desde {url}")
            break
        except requests.RequestException as err:
            print(f"Error con {url}: {err}")
            r = None

    if r is None:
        print("Ningún servidor de Overpass respondió correctamente.")
        print("Comprueba tu conexión a internet e inténtalo de nuevo en unos minutos.")
        sys.exit(1)

    datos = r.json()
    destino = RAIZ / "datos_crudos" / "overpass.json"
    destino.parent.mkdir(exist_ok=True)
    destino.write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
    print(f"Listo: {len(datos.get('elements', []))} elementos guardados en {destino}")


if __name__ == "__main__":
    main()
