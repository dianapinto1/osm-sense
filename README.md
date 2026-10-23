# OSM Sense – prototipo

Visor experimental que traduce datos de OpenStreetMap a lenguaje natural, con voz,
alto contraste y modo sencillo. Ponencia en State of the Map Latam 2026.

> Zona piloto: El Tintal, Calandaima y Tintal Norte (Kennedy, Bogotá), con datos reales
> de OpenStreetMap. Para otra zona, cambia `config.json` y corre los pasos 1 y 2.

## Requisitos
- Python 3.10 o superior
- `pip install requests`
- Una llave gratuita de Groq (https://console.groq.com/keys) u otro proveedor (ver `.env.example`)

## Pasos

1. **Configura la zona.** En `config.json` cambia el nombre, el recuadro
   `[sur, oeste, norte, este]` y el `punto_central` (desde donde se miden distancias).
   Truco: en overpass-turbo.eu, al ejecutar una consulta con `{{bbox}}`, la pestaña de
   la consulta muestra las coordenadas del recuadro visible.
2. **Descarga los datos de OSM:** `python scripts/paso1_descargar_osm.py`
3. **Clasifica y calcula vacíos:** `python scripts/paso2_clasificar.py`
   (imprime las cifras para la charla, p. ej. el % de vías peatonales sin dato de accesibilidad).
4. **Configura la IA:** copia `.env.example` como `.env` y pega tu llave.
5. **Ajusta las preguntas** en `scripts/preguntas.json` (opcional).
6. **Genera las respuestas:** `python scripts/paso3_generar_respuestas.py`
   El script descarta y avisa si la IA cita lugares que no existen en los datos.
   **Lee y corrige `web/data/respuestas.json` antes de la charla.**
7. **Abre el visor:**
   ```
   cd web
   python -m http.server 8080
   ```
   y entra a http://localhost:8080 (no funciona abriendo el .html con doble clic).

## Qué hace el visor
- Mapa por categorías (salud, educación, parques, transporte, comida, servicios, comercio).
- Preguntas con respuesta en lenguaje natural; resalta en el mapa los lugares citados.
- "Lo que el mapa no sabe": datos faltantes declarados por la IA.
- Panel de vacíos: % de vías peatonales sin dato de accesibilidad, con capa en el mapa.
- Botón para abrir una nota pública en OpenStreetMap.
- Alto contraste, letra grande, modo sencillo y lectura en voz alta (del navegador, sin API).

## Sin internet
Datos, respuestas y librería del mapa están locales. **Solo el fondo del mapa (teselas)
necesita internet.** Para la charla lleva el video de respaldo.

## IA en vivo (Cloudflare Worker)
El chat pregunta a un Worker (`worker/`) que guarda la llave de Groq como secreto y agrega
las instrucciones del sistema. Desplegar: `cd worker`, `npx wrangler@4 deploy`; la llave se
carga una sola vez con `npx wrangler@4 secret put GROQ_API_KEY` (nunca en el código).

## Modo demo sin internet
Con `?demo=1` en la URL el chat reproduce `web/data/demo_conversacion.json`. Si la IA no
responde (sin red o límite de la capa gratuita), las preguntas del guion usan ese respaldo.

## Publicar en GitHub Pages
La rama `gh-pages` contiene solo la carpeta `web`. Después de cada `git push` a `main`:
```
git subtree push --prefix web origin gh-pages
```
En Settings → Pages: "Deploy from a branch", rama `gh-pages`, carpeta `/ (root)`.
Sitio: https://dianapinto1.github.io/osm-sense/

## Licencias
Datos © colaboradores de OpenStreetMap, ODbL. Leaflet: BSD-2. Código: elige una licencia abierta (p. ej. MIT).
