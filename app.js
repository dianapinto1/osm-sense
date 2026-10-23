/* OSM Sense v2 – chat móvil sobre datos de OpenStreetMap. Lee web/data/*.json generados por los scripts. */
(async function () {
  // URL del Cloudflare Worker que guarda la llave de Groq (worker/). Vacía = aún sin IA.
  const WORKER_URL = "https://osm-sense.diana-92pinto.workers.dev";
  const MAX_ELEMENTOS = 60, MAX_HISTORIAL = 8;

  const COLORES = {
    salud: "#ff58ae", educacion: "#0086fc", parques: "#00c978", transporte: "#9f4fff",
    alimentacion: "#ffbb26", servicios: "#64c6ff", comercio: "#343433", otros: "#7e7e7d"
  };
  const VIA = "#7e7e7d", VACIO = "#ff3e00", RESALTE = "#121212";
  // Solo rellenan la caja de texto: nada de respuestas preprogramadas.
  const IDEAS = [
    "Explícame esta zona", "¿Qué hay cerca de aquí?", "¿Hay servicios de salud o colegios cerca?",
    "¿Puedo moverme por aquí en silla de ruedas?", "¿Qué no sabe el mapa de aquí?", "Quiero contarte algo de mi barrio"
  ];

  // Modo demo (?demo=1): el chat reproduce data/demo_conversacion.json en lugar de llamar a la IA.
  const MODO_DEMO = new URLSearchParams(location.search).get("demo") === "1";

  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const estado = {
    modoSencillo: false, leerVoz: false, capas: {}, porId: {}, pois: [], resaltados: null,
    historial: [], ubicacion: null, origenUbicacion: "demo", ocupado: false
  };

  // El guion se carga al abrir la página para que siga disponible si luego se cae la conexión.
  const [geo, resumen, guion] = await Promise.all([
    fetch("data/zona.geojson").then(r => r.json()),
    fetch("data/resumen.json").then(r => r.json()),
    fetch("data/demo_conversacion.json").then(r => r.json()).catch(() => ({ turnos: [] }))
  ]);
  const NOMBRES = resumen.nombres_categoria;
  $("nombre-zona").textContent = `${resumen.zona} · ${resumen.ciudad}`;

  function distanciaM(a, b) {
    const r = 6371000, rad = x => x * Math.PI / 180;
    const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
  }

  // ---------- Mapa ----------
  const mapa = L.map("mapa", { zoomControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>'
  }).addTo(mapa);
  const [s, o, n, e] = resumen.bbox;
  const limites = L.latLngBounds([[s, o], [n, e]]);
  mapa.fitBounds(limites);

  const popup = p => `<strong>${esc(p.nombre || "(sin nombre en OSM)")}</strong><br>${esc(p.tipo)}` +
    `<br><a href="https://www.openstreetmap.org/${esc(p.id)}" target="_blank" rel="noopener">Ver en OSM (${esc(p.id)})</a>`;

  const vias = L.layerGroup().addTo(mapa);
  const viasSinDato = L.layerGroup();
  const sinDato = new Set(resumen.vacios.ids_vias_sin_dato_silla_ruedas);

  geo.features.forEach(f => {
    const p = f.properties;
    if (p.categoria === "via_peatonal") {
      const ll = f.geometry.coordinates.map(c => [c[1], c[0]]);
      L.polyline(ll, { color: VIA, weight: 3, opacity: .7 }).bindPopup(popup(p)).addTo(vias);
      if (sinDato.has(p.id)) L.polyline(ll, { color: VACIO, weight: 5, dashArray: "6 6" })
        .bindPopup(popup(p) + "<br><em>Sin dato de accesibilidad</em>").addTo(viasSinDato);
      estado.porId[p.id] = { latlng: ll[Math.floor(ll.length / 2)], p };
      return;
    }
    const latlng = [p.centro[0], p.centro[1]];
    const capa = estado.capas[p.categoria] || (estado.capas[p.categoria] = L.layerGroup().addTo(mapa));
    const m = L.circleMarker(latlng, {
      radius: 7, color: "#ffffff", weight: 2, fillColor: COLORES[p.categoria] || COLORES.otros, fillOpacity: .95
    }).bindPopup(popup(p)).bindTooltip(esc(p.nombre || p.tipo));
    m.addTo(capa);
    estado.porId[p.id] = { latlng, p, marcador: m };
    estado.pois.push({ latlng, p });
  });

  // Franja del mapa: en el celular ocupa ~35 % y se amplía al tocarla.
  const franja = $("franja-mapa"), btnExp = $("btn-expandir");
  const esMovil = () => matchMedia("(max-width: 899px)").matches;
  function expandir(on) {
    franja.classList.toggle("expandida", on);
    btnExp.setAttribute("aria-expanded", String(on));
    btnExp.textContent = on ? "Reducir mapa" : "Ampliar mapa";
    setTimeout(() => mapa.invalidateSize(), 280);   // respaldo si no hay animación
  }
  franja.addEventListener("transitionend", ev => { if (ev.propertyName === "height") mapa.invalidateSize(); });
  btnExp.addEventListener("click", () => expandir(!franja.classList.contains("expandida")));
  mapa.on("click", () => { if (esMovil() && !franja.classList.contains("expandida")) expandir(true); });

  // ---------- Ubicación ----------
  const marcaYo = L.circleMarker(resumen.punto_central, {
    radius: 9, color: "#ffffff", weight: 3, fillColor: RESALTE, fillOpacity: 1
  }).addTo(mapa);
  function fijarUbicacion(latlng, origen) {
    estado.ubicacion = latlng; estado.origenUbicacion = origen;
    marcaYo.setLatLng(latlng).bindTooltip(origen === "gps" ? "Estás aquí" : "Punto de referencia (modo demo)");
  }
  fijarUbicacion(resumen.punto_central, "demo");

  const btnDonde = $("btn-donde");
  function usarDemo(motivo) {
    fijarUbicacion(resumen.punto_central, "demo");
    mapa.flyTo(resumen.punto_central, 17);
    agregarSistema(`${motivo} Uso el punto de referencia de la zona piloto (modo demo).`);
  }
  btnDonde.addEventListener("click", () => {
    if (!navigator.geolocation) return usarDemo("Este navegador no permite conocer tu ubicación.");
    btnDonde.disabled = true; btnDonde.textContent = "📍 Buscando…";
    const fin = () => { btnDonde.disabled = false; btnDonde.textContent = "📍 ¿Dónde estoy?"; };
    navigator.geolocation.getCurrentPosition(pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (limites.pad(0.2).contains(ll)) {
        fijarUbicacion(ll, "gps"); mapa.flyTo(ll, 18);
        agregarSistema("Listo: responderé según tu ubicación.");
      } else usarDemo("Estás fuera de la zona piloto.");
      fin();
    }, () => { usarDemo("No pude conocer tu ubicación."); fin(); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });

  // Lo que se le entrega a la IA: los lugares más cercanos a la ubicación actual y los vacíos.
  function construirContexto() {
    const elementos = estado.pois.map(({ latlng, p }) => ({
      id: p.id, categoria: p.categoria, tipo: p.tipo, nombre: p.nombre || null,
      distancia_m: Math.round(distanciaM(estado.ubicacion, latlng)),
      accesible_silla_ruedas: p.tags.wheelchair || null
    })).sort((a, b) => a.distancia_m - b.distancia_m).slice(0, MAX_ELEMENTOS);
    const { ids_vias_sin_dato_silla_ruedas, ...vacios } = resumen.vacios;
    return {
      zona: resumen.zona, ciudad: resumen.ciudad,
      ubicacion: { lat: estado.ubicacion[0], lon: estado.ubicacion[1], origen: estado.origenUbicacion },
      conteo_por_categoria: resumen.conteo_por_categoria, nombres_categoria: NOMBRES,
      elementos, vacios
    };
  }

  // POST { historial, contexto } al Worker → JSON con respuesta, ids_citados, datos_faltantes, etc.
  // sinIA = la IA no está disponible (sin red, límite 429, caída): se puede usar el guion de respaldo.
  const falla = (mensaje, sinIA) => Object.assign(new Error(mensaje), { sinIA });
  async function pedirRespuesta() {
    if (!WORKER_URL) throw falla("Todavía no hay conexión con la IA: falta configurar el Worker.", true);
    const control = new AbortController(), reloj = setTimeout(() => control.abort(), 30000);
    let res;
    try {
      res = await fetch(WORKER_URL, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: control.signal,
        body: JSON.stringify({ historial: estado.historial.slice(-MAX_HISTORIAL), contexto: construirContexto() })
      });
    } catch (err) {
      throw falla("No pude conectarme con la IA. Revisa tu conexión a internet e intenta de nuevo.", true);
    } finally { clearTimeout(reloj); }
    const datos = await res.json().catch(() => ({}));
    if (res.status === 429) throw falla("Hay muchas preguntas en este momento y la IA gratuita llegó a su límite. Espera un minuto e intenta de nuevo.", true);
    if (!res.ok || !datos.respuesta) throw falla(datos.error || "La IA no respondió bien. Intenta de nuevo.", res.status >= 500);
    return datos;
  }

  // Guion del modo demo: busca el turno cuya pregunta coincide con lo escrito. En ?demo=1, si no
  // coincide, sigue el orden del guion; como respaldo en vivo solo responde si la pregunta coincide.
  const normalizar = t => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const usados = new Set();
  function turnoDelGuion(texto, enOrden) {
    const libres = (guion.turnos || []).filter(t => !usados.has(t));
    const n = normalizar(texto);
    const turno = libres.find(t => { const p = normalizar(t.pregunta); return p === n || p.includes(n) || n.includes(p); }) ||
      (enOrden ? libres[0] : null);
    if (turno) usados.add(turno);
    return turno;
  }

  // ---------- Chat ----------
  const lista = $("mensajes"), entrada = $("entrada"), form = $("form-chat"), btnEnviar = $("btn-enviar");
  const bajar = () => { lista.scrollTop = lista.scrollHeight; };
  function burbuja(clase) {
    const b = document.createElement("article");
    b.className = `msg ${clase}`; lista.appendChild(b); return b;
  }
  function agregarSistema(texto) { burbuja("sistema").textContent = texto; bajar(); }
  function agregarPersona(texto) {
    const b = burbuja("persona");
    b.innerHTML = '<span class="solo-lectores">Tú: </span>';
    const p = document.createElement("p"); p.textContent = texto; b.appendChild(p); bajar();
  }

  const textoDe = r => estado.modoSencillo && r.respuesta_simple ? r.respuesta_simple : r.respuesta;
  const mensajesOsm = [];
  function agregarOsm(r, { extra = "", leer: leerAhora = estado.leerVoz } = {}) {
    const b = burbuja("osm");
    b.innerHTML = '<span class="solo-lectores">OSM Sense: </span>';
    const p = document.createElement("p"); p.className = "msg-texto"; p.textContent = textoDe(r); b.appendChild(p);
    if (extra) b.insertAdjacentHTML("beforeend", extra);

    // Solo se muestran los IDs que existen en los datos; los demás se descartan.
    const validos = (r.ids_citados || []).filter(id => {
      if (estado.porId[id]) return true;
      console.warn("ID citado que no existe en los datos (descartado):", id); return false;
    });
    if (validos.length) {
      b.insertAdjacentHTML("beforeend", '<h3>Lugares mencionados</h3><ul class="citados"></ul>');
      const ul = b.querySelector(".citados");
      validos.forEach(id => {
        const d = estado.porId[id], li = document.createElement("li"), btn = document.createElement("button");
        const metros = Math.round(distanciaM(estado.ubicacion, d.latlng));
        btn.type = "button";
        btn.textContent = `📍 ${d.p.nombre ? `${d.p.nombre} · ${d.p.tipo}` : `${d.p.tipo} sin nombre`} · ${metros} m`;
        btn.addEventListener("click", () => irA(id)); li.appendChild(btn); ul.appendChild(li);
      });
    }
    if (r.datos_faltantes && r.datos_faltantes.length) {
      const div = document.createElement("div"); div.className = "no-sabe";
      div.innerHTML = '<h3>Lo que el mapa no sabe</h3><ul class="faltantes"></ul>';
      r.datos_faltantes.forEach(t => { const li = document.createElement("li"); li.textContent = t; div.lastChild.appendChild(li); });
      b.appendChild(div);
    }
    if (r.pregunta_de_vuelta) {
      const q = document.createElement("p"); q.className = "pregunta-vuelta";
      q.textContent = `¿Tú sabes? ${r.pregunta_de_vuelta}`; b.appendChild(q);
    }
    const acc = document.createElement("div"); acc.className = "msg-acciones";
    const btnLeer = document.createElement("button");
    btnLeer.type = "button"; btnLeer.className = "pill"; btnLeer.textContent = "🔊 Escuchar";
    btnLeer.addEventListener("click", () => leer(textoDe(r)));
    acc.appendChild(btnLeer);
    if (r.pregunta_de_vuelta) {
      const btnContar = document.createElement("button");
      btnContar.type = "button"; btnContar.className = "pill"; btnContar.textContent = "🗣️ Sí, te cuento";
      btnContar.addEventListener("click", () => { entrada.placeholder = "Cuéntame lo que sabes…"; entrada.focus(); });
      acc.appendChild(btnContar);
    }
    b.appendChild(acc);

    mensajesOsm.push({ r, p });
    resaltar(validos);
    bajar();
    if (leerAhora) leer(textoDe(r));
  }

  function resaltar(ids) {
    if (estado.resaltados) mapa.removeLayer(estado.resaltados);
    estado.resaltados = L.layerGroup().addTo(mapa);
    const puntos = ids.map(id => estado.porId[id].latlng);
    puntos.forEach(ll => L.circleMarker(ll, { radius: 15, color: RESALTE, weight: 3, fill: false }).addTo(estado.resaltados));
    if (puntos.length) mapa.fitBounds(L.latLngBounds(puntos).pad(0.3), { maxZoom: 18 });
  }
  function irA(id) {
    const d = estado.porId[id];
    mapa.flyTo(d.latlng, 18);
    if (d.marcador) d.marcador.openPopup(); else mapa.openPopup(popup(d.p), d.latlng);
  }

  // Bienvenida armada con los datos reales de la zona (no es respuesta de la IA).
  const v = resumen.vacios;
  const pctSin = (100 - v.pct_vias_con_dato_silla_ruedas).toFixed(0);
  agregarOsm({
    respuesta: "Hola. Soy OSM Sense: te explico esta zona con datos de OpenStreetMap, el mapa libre que hace la comunidad. " +
      "Pregúntame lo que quieras, por voz o por escrito. Y si sabes algo que el mapa no sabe, cuéntamelo.",
    respuesta_simple: "Hola. Te explico este lugar con el mapa libre OpenStreetMap. Pregúntame o cuéntame lo que sabes."
  }, {
    leer: false,
    extra: `<p class="nota" style="margin-top:12px"><span class="cifra-bienvenida">${pctSin} %</span>` +
      `de las ${v.vias_peatonales_total} vías peatonales de esta zona no dice si se puede recorrer en silla de ruedas.</p>`
  });

  async function enviar(texto) {
    if (!texto || estado.ocupado) return;
    detenerVoz();
    agregarPersona(texto);
    estado.historial.push({ role: "user", content: texto });
    const espera = burbuja("osm espera");
    espera.innerHTML = '<i></i><i></i><i></i><span class="solo-lectores">OSM Sense está pensando…</span>';
    bajar();
    estado.ocupado = true; btnEnviar.disabled = true;
    let r = null, error = null;
    try {
      if (!MODO_DEMO) r = await pedirRespuesta();
    } catch (err) { error = err; }
    if (!r && (MODO_DEMO || error.sinIA)) {
      const turno = turnoDelGuion(texto, MODO_DEMO);
      if (turno) {
        await new Promise(ok => setTimeout(ok, 1200));   // misma sensación que la respuesta en vivo
        r = turno.respuesta;
        if (!MODO_DEMO) agregarSistema("No hay conexión con la IA en este momento: te muestro una respuesta preparada (modo demo).");
      } else if (MODO_DEMO) error = new Error("Ya no hay más respuestas preparadas en el modo demo.");
    }
    espera.remove();
    if (r) {
      agregarOsm(r);
      (r.hallazgos || []).forEach(agregarBorrador);
      estado.historial.push({ role: "assistant", content: [r.respuesta, r.pregunta_de_vuelta].filter(Boolean).join(" ") });
    } else agregarSistema(error.message);
    estado.ocupado = false; btnEnviar.disabled = false;
  }
  if (MODO_DEMO) agregarSistema("Modo demo: las respuestas están preparadas con datos reales de OpenStreetMap de esta zona.");

  const autoAlto = () => { entrada.style.height = "auto"; entrada.style.height = Math.min(entrada.scrollHeight, 140) + "px"; };
  entrada.addEventListener("input", autoAlto);
  entrada.addEventListener("keydown", ev => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    const texto = entrada.value.trim();
    if (!texto || estado.ocupado) return;
    entrada.value = ""; entrada.placeholder = "Pregúntale al mapa…"; autoAlto(); entrada.focus();
    enviar(texto);
  });

  // ---------- "Cuéntame tu barrio": borradores de nota (OSM Sense nunca publica nada) ----------
  const FIRMA = "Reportado por un/a vecino/a mediante OSM Sense (prototipo). Requiere verificación de la comunidad.";
  const TIPOS_HALLAZGO = { nuevo: "Lugar que falta en el mapa", correccion: "Corrección", accesibilidad: "Accesibilidad" };
  const DATO_PERSONAL = /\+?\d[\d\s.-]{6,}\d|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  const contador = $("contador-hallazgos");
  let totalHallazgos = 0;
  const anunciar = t => { const s = $("anuncio"); s.textContent = ""; setTimeout(() => { s.textContent = t; }, 50); };

  function agregarBorrador(h) {
    const n = ++totalHallazgos;
    contador.hidden = false; contador.querySelector("strong").textContent = n;
    const b = burbuja("borrador");
    b.innerHTML = `<h3>📝 Borrador de nota ${n} · ${esc(TIPOS_HALLAZGO[h.tipo] || "Hallazgo")}</h3>
      <label class="etiqueta-campo" for="nota-${n}">Texto de la nota (puedes editarlo)</label>
      <textarea id="nota-${n}" rows="5"></textarea>
      <p class="alerta" hidden>⚠️ Parece que el texto tiene un teléfono o un correo. Quítalo antes de publicar: las notas de OSM son públicas.</p>
      <p class="ubicacion-nota"></p>
      <div class="borrador-acciones">
        <button type="button" class="pill" data-accion="ubicar">📍 Cambiar ubicación</button>
        <button type="button" class="pill" data-accion="copiar">📋 Copiar texto</button>
        <a class="boton-principal" data-accion="abrir" target="_blank" rel="noopener">Abrir nota en OSM</a>
      </div>
      <p class="nota">OSM Sense no publica nada. Al abrir la nota, pega el texto y decide tú si la publicas.</p>`;
    const area = b.querySelector("textarea"), alerta = b.querySelector(".alerta");
    const enlace = b.querySelector("[data-accion=abrir]"), btnCopiar = b.querySelector("[data-accion=copiar]");
    const btnUbicar = b.querySelector("[data-accion=ubicar]");
    area.value = [h.descripcion, h.etiqueta_osm_sugerida ? `Etiqueta sugerida: ${h.etiqueta_osm_sugerida}` : "", FIRMA]
      .filter(Boolean).join("\n\n");
    const revisar = () => { alerta.hidden = !DATO_PERSONAL.test(area.value); };
    area.addEventListener("input", revisar); revisar();

    const nota = { n, btnUbicar, marcador: null };
    nota.fijar = (ll, donde) => {
      const lat = ll[0].toFixed(6), lon = ll[1].toFixed(6);
      b.querySelector(".ubicacion-nota").textContent = `Ubicación: ${donde}.`;
      enlace.href = `https://www.openstreetmap.org/note/new?lat=${lat}&lon=${lon}#map=19/${lat}/${lon}`;
      if (nota.marcador) nota.marcador.setLatLng(ll);
      else nota.marcador = L.marker(ll, {
        icon: L.divIcon({ className: "pin-nota", html: String(n), iconSize: [28, 28] }),
        keyboard: false, title: `Borrador de nota ${n}`
      }).addTo(mapa);
    };
    const rel = h.id_relacionado && estado.porId[h.id_relacionado];
    if (rel) nota.fijar(rel.latlng, `junto a ${rel.p.nombre || `${rel.p.tipo} sin nombre`}`);
    else { const c = mapa.getCenter(); nota.fijar([c.lat, c.lng], "centro del mapa; usa «Cambiar ubicación» para ajustarla"); }

    const copiar = async () => {
      try { await navigator.clipboard.writeText(area.value); }
      catch { area.select(); document.execCommand("copy"); }
    };
    btnCopiar.addEventListener("click", async () => {
      await copiar();
      btnCopiar.textContent = "✅ Copiado"; anunciar("Texto de la nota copiado.");
      setTimeout(() => { btnCopiar.textContent = "📋 Copiar texto"; }, 2000);
    });
    enlace.addEventListener("click", ev => {
      if (DATO_PERSONAL.test(area.value) &&
          !confirm("El texto parece tener un teléfono o un correo, y las notas de OSM son públicas. ¿Abrir de todos modos?")) {
        ev.preventDefault(); return;
      }
      copiar(); anunciar("Texto copiado. En OpenStreetMap, pégalo y decide si publicas la nota.");
    });
    btnUbicar.addEventListener("click", () => {
      estado.eligiendo = nota;
      if (esMovil()) expandir(true);
      agregarSistema(`Toca el mapa en el lugar exacto de la nota ${n}.`);
    });
    bajar();
  }
  mapa.on("click", ev => {
    const nota = estado.eligiendo;
    if (!nota) return;
    estado.eligiendo = null;
    nota.fijar([ev.latlng.lat, ev.latlng.lng], "punto que elegiste en el mapa");
    anunciar(`Ubicación de la nota ${nota.n} actualizada.`);
    if (esMovil()) expandir(false);   // vuelve a mostrar la tarjeta de la nota
    nota.btnUbicar.focus();
  });

  const cajaIdeas = $("ideas");
  (MODO_DEMO ? (guion.turnos || []).map(t => t.pregunta) : IDEAS).forEach(t => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pill"; b.textContent = t;
    b.addEventListener("click", () => { entrada.value = t; autoAlto(); entrada.focus(); });
    cajaIdeas.appendChild(b);
  });

  // ---------- Voz: lectura (speechSynthesis) y dictado (SpeechRecognition) ----------
  function vozEs() {
    const voces = speechSynthesis.getVoices();
    return voces.find(x => x.lang === "es-CO") || voces.find(x => x.lang === "es-MX") ||
      voces.find(x => x.lang && x.lang.startsWith("es"));
  }
  function detenerVoz() { if ("speechSynthesis" in window) speechSynthesis.cancel(); }
  function leer(texto) {
    if (!("speechSynthesis" in window)) return agregarSistema("Este navegador no permite lectura en voz alta.");
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = "es-CO"; const vz = vozEs(); if (vz) u.voice = vz; u.rate = .95;
    speechSynthesis.speak(u);
  }

  const btnMic = $("btn-mic");
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Reconocimiento) btnMic.hidden = true;   // queda el dictado del teclado del celular
  else {
    const rec = new Reconocimiento();
    rec.lang = "es-CO"; rec.interimResults = true; rec.continuous = false;
    let base = "", escuchando = false;
    const marcar = on => {
      escuchando = on;
      btnMic.setAttribute("aria-pressed", String(on));
      btnMic.setAttribute("aria-label", on ? "Dejar de escuchar" : "Hablar");
    };
    rec.onresult = ev => {
      const dicho = Array.from(ev.results).map(x => x[0].transcript).join("");
      entrada.value = `${base} ${dicho}`.trim(); autoAlto();
    };
    rec.onend = () => { marcar(false); entrada.focus(); };
    rec.onerror = ev => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed")
        agregarSistema("No tengo permiso para usar el micrófono. Puedes escribir o usar el dictado del teclado.");
    };
    btnMic.addEventListener("click", () => {
      if (escuchando) return rec.stop();
      detenerVoz(); base = entrada.value.trim();
      try { rec.start(); marcar(true); } catch (err) { console.warn(err); }
    });
  }

  // ---------- Ajustes: accesibilidad, capas y vacíos ----------
  const hoja = $("ajustes");
  $("btn-ajustes").addEventListener("click", () => hoja.showModal());
  $("btn-cerrar-ajustes").addEventListener("click", () => hoja.close());
  hoja.addEventListener("click", ev => { if (ev.target === hoja) hoja.close(); });

  const alternar = (id, fn) => $(id).addEventListener("click", ev => {
    const on = ev.currentTarget.getAttribute("aria-pressed") !== "true";
    ev.currentTarget.setAttribute("aria-pressed", String(on)); fn(on);
  });
  alternar("btn-contraste", on => document.body.classList.toggle("contraste", on));
  alternar("btn-letra", on => { document.body.classList.toggle("letra-grande", on); setTimeout(() => mapa.invalidateSize(), 50); });
  alternar("btn-pedagogico", on => {
    estado.modoSencillo = on;
    mensajesOsm.forEach(({ r, p }) => { p.textContent = textoDe(r); });
  });
  alternar("btn-voz", on => { estado.leerVoz = on; if (!on) detenerVoz(); });

  const ulCapas = $("capas");
  Object.entries(resumen.conteo_por_categoria).sort((a, b) => b[1] - a[1]).forEach(([cat, num]) => {
    const li = document.createElement("li");
    li.innerHTML = `<label><input type="checkbox" checked data-cat="${esc(cat)}">
      <span class="muestra" style="background:${COLORES[cat] || COLORES.otros}"></span>
      ${esc(NOMBRES[cat] || cat)} <span class="cuenta">${num}</span></label>`;
    ulCapas.appendChild(li);
  });
  const liVias = document.createElement("li");
  liVias.innerHTML = `<label><input type="checkbox" checked data-cat="__vias">
    <span class="muestra" style="background:${VIA};border-radius:2px"></span>
    Vías peatonales <span class="cuenta">${v.vias_peatonales_total}</span></label>`;
  ulCapas.appendChild(liVias);
  ulCapas.addEventListener("change", ev => {
    const cat = ev.target.dataset.cat;
    const capa = cat === "__vias" ? vias : estado.capas[cat];
    if (capa) ev.target.checked ? capa.addTo(mapa) : mapa.removeLayer(capa);
  });

  $("vacios-datos").innerHTML = `
    <p><span class="cifra">${pctSin} %</span><br>
    de las vías peatonales (${v.vias_peatonales_total - v.vias_con_dato_silla_ruedas} de ${v.vias_peatonales_total})
    no dice si se puede recorrer en silla de ruedas.</p>
    <p>${v.lugares_sin_nombre} de ${v.lugares_total} lugares no tienen nombre en OSM y
    solo ${v.lugares_con_dato_silla_ruedas} indican si son accesibles.</p>`;
  $("chk-vacios").addEventListener("change", ev =>
    ev.target.checked ? viasSinDato.addTo(mapa) : mapa.removeLayer(viasSinDato));
  const btnNota = $("btn-nota");
  const actualizarNota = () => {
    const c = mapa.getCenter(), z = Math.max(mapa.getZoom(), 17);
    btnNota.href = `https://www.openstreetmap.org/note/new?lat=${c.lat.toFixed(6)}&lon=${c.lng.toFixed(6)}` +
      `#map=${z}/${c.lat.toFixed(6)}/${c.lng.toFixed(6)}`;
  };
  mapa.on("moveend", actualizarNota); actualizarNota();
})();
