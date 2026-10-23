"""
Paso 2 - Clasifica los datos de OSM en categorías comprensibles y detecta vacíos.

Uso:  python scripts/paso2_clasificar.py
Entrada: datos_crudos/overpass.json
Salidas: web/data/zona.geojson   (lo que dibuja el visor)
         web/data/resumen.json   (lo que se le entrega a la IA y al panel de vacíos)
"""
import json
import math
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = json.loads((RAIZ / "config.json").read_text(encoding="utf-8"))
CAT = json.loads((RAIZ / "scripts" / "categorias.json").read_text(encoding="utf-8"))

ETIQUETAS_UTILES = ["name", "wheelchair", "surface", "opening_hours", "tactile_paving",
                    "lit", "kerb", "incline", "width", "access", "operator"]


def distancia_m(a, b):
    """Distancia aproximada (haversine) entre dos puntos [lat, lon]."""
    r = 6371000
    la1, lo1, la2, lo2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def clasificar(tags):
    for regla in CAT["reglas"]:
        v = tags.get(regla["clave"])
        if v is not None and ("*" in regla["valores"] or v in regla["valores"]):
            clave_tipo = f'{regla["clave"]}={v}'
            tipo = CAT["tipos_es"].get(clave_tipo, v.replace("_", " "))
            return regla["categoria"], tipo, clave_tipo
    return "otros", "otro", ""


def a_feature(el):
    tags = el.get("tags", {})
    oid = f'{el["type"]}/{el["id"]}'
    if "lat" in el:
        geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
        centro = [el["lat"], el["lon"]]
    elif "center" in el:
        c = el["center"]
        geom = {"type": "Point", "coordinates": [c["lon"], c["lat"]]}
        centro = [c["lat"], c["lon"]]
    elif "geometry" in el:
        coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
        geom = {"type": "LineString", "coordinates": coords}
        mid = el["geometry"][len(el["geometry"]) // 2]
        centro = [mid["lat"], mid["lon"]]
    else:
        return None
    categoria, tipo, clave_tipo = clasificar(tags)
    props = {
        "id": oid,
        "categoria": categoria,
        "tipo": tipo,
        "etiqueta_osm": clave_tipo,
        "nombre": tags.get("name", ""),
        "centro": [round(centro[0], 6), round(centro[1], 6)],
        "tags": {k: tags[k] for k in ETIQUETAS_UTILES if k in tags},
    }
    return {"type": "Feature", "geometry": geom, "properties": props}


def largo_linea_m(coords):
    return sum(distancia_m([a[1], a[0]], [b[1], b[0]]) for a, b in zip(coords, coords[1:]))


def main():
    crudo = json.loads((RAIZ / "datos_crudos" / "overpass.json").read_text(encoding="utf-8"))
    vistos, features = set(), []
    for el in crudo.get("elements", []):
        f = a_feature(el)
        if f and f["properties"]["id"] not in vistos:
            vistos.add(f["properties"]["id"])
            features.append(f)

    centro = CONFIG["zona"]["punto_central"]
    pois = [f for f in features if f["properties"]["categoria"] != "via_peatonal"]
    vias = [f for f in features if f["properties"]["categoria"] == "via_peatonal"]

    elementos = []
    for f in pois:
        p = f["properties"]
        elementos.append({
            "id": p["id"], "categoria": p["categoria"], "tipo": p["tipo"],
            "nombre": p["nombre"] or None,
            "distancia_m": round(distancia_m(centro, p["centro"])),
            "accesible_silla_ruedas": p["tags"].get("wheelchair"),
        })
    elementos.sort(key=lambda x: x["distancia_m"])

    conteo = {}
    for e in elementos:
        conteo[e["categoria"]] = conteo.get(e["categoria"], 0) + 1

    total_vias = len(vias)
    con_wheel = sum(1 for v in vias if "wheelchair" in v["properties"]["tags"])
    con_surface = sum(1 for v in vias if "surface" in v["properties"]["tags"])
    con_lit = sum(1 for v in vias if "lit" in v["properties"]["tags"])
    largo_total = sum(largo_linea_m(v["geometry"]["coordinates"]) for v in vias)
    pct = lambda a, b: round(100 * a / b, 1) if b else 0.0

    vacios = {
        "vias_peatonales_total": total_vias,
        "vias_peatonales_km": round(largo_total / 1000, 2),
        "vias_con_dato_silla_ruedas": con_wheel,
        "pct_vias_con_dato_silla_ruedas": pct(con_wheel, total_vias),
        "vias_con_dato_superficie": con_surface,
        "pct_vias_con_dato_superficie": pct(con_surface, total_vias),
        "vias_con_dato_iluminacion": con_lit,
        "pct_vias_con_dato_iluminacion": pct(con_lit, total_vias),
        "lugares_total": len(elementos),
        "lugares_sin_nombre": sum(1 for e in elementos if not e["nombre"]),
        "lugares_con_dato_silla_ruedas": sum(1 for e in elementos if e["accesible_silla_ruedas"]),
        "ids_vias_sin_dato_silla_ruedas": [v["properties"]["id"] for v in vias
                                           if "wheelchair" not in v["properties"]["tags"]],
    }

    resumen = {
        "zona": CONFIG["zona"]["nombre"],
        "ciudad": CONFIG["zona"]["ciudad"],
        "punto_central": centro,
        "bbox": CONFIG["zona"]["bbox_sur_oeste_norte_este"],
        "conteo_por_categoria": conteo,
        "nombres_categoria": CAT["nombres_categoria"],
        "elementos": elementos,
        "vacios": vacios,
    }

    salida = RAIZ / "web" / "data"
    salida.mkdir(parents=True, exist_ok=True)
    (salida / "zona.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")
    (salida / "resumen.json").write_text(json.dumps(resumen, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"Lugares: {len(elementos)}  |  Vías peatonales: {total_vias} ({vacios['vias_peatonales_km']} km)")
    print("Por categoría:", conteo)
    print(f"Vías peatonales con dato de silla de ruedas: {con_wheel} de {total_vias} "
          f"({vacios['pct_vias_con_dato_silla_ruedas']} %)")
    print(f"Lugares sin nombre: {vacios['lugares_sin_nombre']} de {len(elementos)}")


if __name__ == "__main__":
    main()
