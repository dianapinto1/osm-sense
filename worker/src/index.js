/* OSM Sense – Worker: guarda la llave de Groq, agrega las instrucciones del sistema y
   devuelve la respuesta de la IA en JSON. El navegador nunca ve la llave ni las instrucciones. */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_MENSAJE = 2000, MAX_CONTEXTO = 40000, MAX_HISTORIAL = 8;

const INSTRUCCIONES = `Eres OSM Sense, un asistente que explica un barrio usando SOLO los datos de OpenStreetMap (OSM) que llegan en el mensaje "DATOS DE OSM DE LA ZONA". Hablas con vecinos y vecinas, entre ellos personas mayores o con discapacidad.

Reglas:
1. Usa SOLO los datos entregados. No inventes lugares, nombres, horarios, distancias, rampas ni nada que no esté en los datos. Si algo no está, dilo.
2. Todo lugar que menciones debe estar en la lista de lugares; pon su id exacto (por ejemplo "node/123") en "ids_citados". Usa la distancia tal cual, en metros. Si un lugar no tiene nombre, descríbelo por su tipo (por ejemplo "una droguería sin nombre en el mapa").
3. Si faltan datos para responder (por ejemplo, un lugar dice "silla: sin dato" o los vacíos muestran pocas vías con dato de accesibilidad), dilo en "datos_faltantes" con frases claras para la persona (por ejemplo "No sabemos si las droguerías tienen rampa"), nunca con nombres de campos, y, cuando tenga sentido, haz UNA sola "pregunta_de_vuelta" corta para que la persona cuente lo que sabe. Si no hace falta, "pregunta_de_vuelta" es null.
4. Cuando la persona cuente algo que sabe del barrio (información propia, no una pregunta), agradécele y crea UN hallazgo por cada dato distinto que ella aportó, sin inventar detalles: lugares que no están en el mapa (tipo "nuevo"), datos del mapa que están mal (tipo "correccion") y condiciones de accesibilidad (tipo "accesibilidad"). Escribe "descripcion" en lenguaje claro, sin etiquetas técnicas. Los vacíos del mapa que la persona NO reportó no son hallazgos. Explícale que puede revisar los hallazgos y decidir si los publica como nota en OSM. Si la persona solo pregunta, "hallazgos" es [].
5. Privacidad: en "hallazgos" y en "respuesta" NUNCA incluyas nombres de personas, teléfonos, correos ni direcciones de vivienda. Reemplázalos por una descripción genérica (por ejemplo "la tienda de doña Rosa" se convierte en "una tienda de barrio"). No escribas "doña", "don", "señora", "señor" ni ningún nombre de persona, ni siquiera para identificar un negocio.
6. "etiqueta_osm_sugerida" solo si estás seguro de la etiqueta OSM (por ejemplo "kerb=lowered" o "wheelchair=no"); si no, null. "id_relacionado" solo si el hallazgo trata de un elemento de los datos; si no, null.
7. Lenguaje claro: frases cortas, tono amable, español neutro. En "respuesta" y "respuesta_simple" NUNCA escribas ids (nada de "node/123") ni etiquetas técnicas (nada de "amenity=..."): los ids van solo en "ids_citados". "respuesta" tiene máximo 120 palabras; "respuesta_simple" dice la misma idea en máximo 50 palabras, muy sencilla.
8. Recuerda, de forma breve y variada, que la información viene de OSM y puede estar incompleta.
9. Si la ubicación dice "modo demo", la ubicación es un punto de referencia de la zona, no la posición real de la persona.
10. Si te preguntan algo que no está en los datos o queda fuera de la zona, dilo con amabilidad y ofrece lo que sí sabes.
11. Tú no editas ni publicas nada en OSM; nunca digas que lo hiciste.

Responde SIEMPRE con un único objeto JSON, sin texto adicional, con esta forma exacta:
{"respuesta": "...", "respuesta_simple": "...", "ids_citados": ["node/123"], "datos_faltantes": ["..."], "pregunta_de_vuelta": "..." o null, "hallazgos": [{"tipo": "nuevo | correccion | accesibilidad", "descripcion": "...", "id_relacionado": "way/456" o null, "etiqueta_osm_sugerida": "kerb=lowered" o null}]}`;

export default {
  async fetch(request, env) {
    const origen = request.headers.get("Origin") || "";
    const permitidos = (env.ORIGENES || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = permitidos.includes(origen) ? {
      "Access-Control-Allow-Origin": origen,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    } : {};
    const responder = (cuerpo, estado = 200) => new Response(JSON.stringify(cuerpo), {
      status: estado, headers: { "Content-Type": "application/json; charset=utf-8", ...cors }
    });

    if (!cors["Access-Control-Allow-Origin"]) return responder({ error: "Origen no permitido." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return responder({ error: "Usa POST." }, 405);

    let datos;
    try { datos = await request.json(); } catch { return responder({ error: "El cuerpo no es JSON válido." }, 400); }

    const historial = Array.isArray(datos.historial) ? datos.historial.slice(-MAX_HISTORIAL) : [];
    const valido = m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
    if (!historial.length || !historial.every(valido)) return responder({ error: "Historial inválido." }, 400);
    if (historial.some(m => m.content.length > MAX_MENSAJE))
      return responder({ error: "El mensaje es muy largo (máximo 2.000 caracteres)." }, 413);
    const contexto = JSON.stringify(datos.contexto ?? {});
    if (new TextEncoder().encode(contexto).length > MAX_CONTEXTO)
      return responder({ error: "Los datos de la zona son demasiado grandes." }, 413);
    if (!env.GROQ_API_KEY) return responder({ error: "Falta configurar la llave de la IA en el Worker." }, 500);

    const groq = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        // Los modelos gpt-oss razonan antes de responder; poco razonamiento = más rápido y sin cortar el JSON.
        ...(String(env.GROQ_MODEL).startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: INSTRUCCIONES },
          { role: "system", content: compactar(datos.contexto ?? {}) },
          ...historial.map(m => ({ role: m.role, content: m.content }))
        ]
      })
    });
    if (groq.status === 429)
      return responder({ error: "La IA gratuita llegó a su límite por ahora. Espera un minuto e intenta de nuevo." }, 429);
    if (!groq.ok) {
      console.error("Groq respondió", groq.status, (await groq.text()).slice(0, 500));
      return responder({ error: "La IA no respondió bien. Intenta de nuevo en un momento." }, 502);
    }

    let r, uso;
    try {
      const g = await groq.json();
      uso = g.usage?.total_tokens;
      r = JSON.parse(g.choices[0].message.content);
    } catch { return responder({ error: "La IA devolvió un formato inesperado. Intenta de nuevo." }, 502); }
    const res = responder(normalizar(r));
    if (uso) res.headers.set("X-Tokens-Usados", String(uso));   // para medir el consumo por pregunta
    return res;
  }
};

// Una línea por lugar en vez de JSON: ~3 veces menos tokens. La capa gratuita de Groq permite
// 8.000 tokens por minuto, así que esto define cuántas preguntas caben por minuto.
function compactar(c) {
  const limpio = v => String(v ?? "").replace(/[|\n\r]/g, " ").trim();
  const u = c.ubicacion || {};
  const lugares = (Array.isArray(c.elementos) ? c.elementos : []).map(e =>
    [e.id, e.categoria, e.tipo, e.nombre || "sin nombre", e.distancia_m, e.accesible_silla_ruedas || "sin dato"].map(limpio).join(" | "));
  return [
    "DATOS DE OSM DE LA ZONA",
    `Zona: ${limpio(c.zona)} (${limpio(c.ciudad)})`,
    `Ubicación: ${u.lat}, ${u.lon}${u.origen === "demo" ? " (modo demo: punto de referencia, no la posición real)" : " (GPS de la persona)"}`,
    `Vacíos de información: ${JSON.stringify(c.vacios || {})}`,
    "Lugares más cercanos (id | categoría | tipo | nombre | distancia en metros | silla de ruedas):",
    ...lugares
  ].join("\n");
}

// Red de seguridad por código: el modelo no siempre obedece las instrucciones de privacidad y formato.
const PARENTESIS_CON_ID = /\s*\([^()]*\b(?:node|way|relation)\/\d+[^()]*\)/g;
const ID_OSM = /\s*\(?\b(?:node|way|relation)\/\d+\)?/g;
const PERSONA = /\b(?:[Dd]oña|[Dd]on|[Ss]eñora|[Ss]eñor|[Ss]ra\.?|[Ss]r\.?)\s+\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)?/gu;
const TELEFONO = /\+?\d[\d\s.-]{6,}\d/g;
const CORREO = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const limpiarTexto = t => t.replace(PARENTESIS_CON_ID, "").replace(ID_OSM, "").replace(PERSONA, "una persona del barrio")
  .replace(CORREO, "[correo quitado]").replace(TELEFONO, "[teléfono quitado]")
  .replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();

// Garantiza el formato que espera el navegador aunque el modelo omita o deforme campos.
function normalizar(r) {
  const texto = v => typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? limpiarTexto(v) || null : null;
  const id = v => typeof v === "string" && /^(node|way|relation)\/\d+$/.test(v.trim()) ? v.trim() : null;
  const lista = v => Array.isArray(v) ? v : [];
  return {
    respuesta: texto(r.respuesta) || "No pude formular una respuesta. ¿Puedes preguntarlo de otra forma?",
    respuesta_simple: texto(r.respuesta_simple),
    ids_citados: lista(r.ids_citados).map(id).filter(Boolean),
    datos_faltantes: lista(r.datos_faltantes).map(texto).filter(Boolean),
    pregunta_de_vuelta: texto(r.pregunta_de_vuelta),
    hallazgos: lista(r.hallazgos).filter(h => h && texto(h.descripcion)).map(h => ({
      tipo: ["nuevo", "correccion", "accesibilidad"].includes(h.tipo) ? h.tipo : "nuevo",
      descripcion: texto(h.descripcion),
      id_relacionado: id(h.id_relacionado),
      etiqueta_osm_sugerida: typeof h.etiqueta_osm_sugerida === "string" && /^[\w:]+=[^\s=]+$/.test(h.etiqueta_osm_sugerida.trim())
        ? h.etiqueta_osm_sugerida.trim() : null
    }))
  };
}
