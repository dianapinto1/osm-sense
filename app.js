/* OSM Sense v2 – chat móvil sobre datos de OpenStreetMap. Lee web/data/*.json generados por los scripts. */
(async function () {
  // URL del Cloudflare Worker que guarda la llave de Groq (worker/). Vacía = aún sin IA.
  const WORKER_URL = "https://osm-sense.diana-92pinto.workers.dev";
  const MAX_ELEMENTOS = 60, POR_CATEGORIA = 3, MAX_HISTORIAL = 8;

  const COLORES = {
    salud: "#ff58ae", educacion: "#0086fc", parques: "#00c978", transporte: "#9f4fff",
    alimentacion: "#ffbb26", servicios: "#64c6ff", comercio: "#343433", otros: "#7e7e7d"
  };
  const VIA = "#7e7e7d", VACIO = "#ff3e00", RESALTE = "#121212";
  // Solo rellenan la caja de texto: nada de respuestas preprogramadas.
  const IDEAS = [
    "Explícame esta zona", "¿Qué hay cerca de aquí?", "¿Dónde está el centro de salud más cercano?",
    "¿Puedo moverme por aquí en silla de ruedas?", "¿Qué no sabe el mapa de aquí?", "Quiero contarte algo de mi barrio"
  ];

  // Modo demo (?demo=1): el chat reproduce data/demo_conversacion.json en lugar de llamar a la IA.
  const MODO_DEMO = new URLSearchParams(location.search).get("demo") === "1";

  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const estado = {
    modoSencillo: false, leerVoz: false, capas: {}, porId: {}, pois: [], resaltados: null,
    historial: [], ubicacion: null, origenUbicacion: "demo", ocupado: false, eligiendo: null
  };

  // El guion se carga al abrir la página para que siga disponible si luego se cae la conexión.
  // cache "no-cache": el navegador siempre confirma si hay datos nuevos (evita mezclar versiones).
  const datos = url => fetch(url, { cache: "no-cache" }).then(r => r.json());
  const [geo, resumen, guion] = await Promise.all([
    datos("data/zona.geojson"),
    datos("data/resumen.json"),
    datos("data/demo_conversacion.json").catch(() => ({ turnos: [] }))
  ]);
  const NOMBRES = resumen.nombres_categoria;
  const v = resumen.vacios;
  $("nombre-zona").textContent = `${resumen.zona} · ${resumen.ciudad}`;

  function distanciaM(a, b) {
    const r = 6371000, rad = x => x * Math.PI / 180;
    const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
  }
  const nombreDe = p => p.nombre || `${p.tipo} sin nombre`;

  // ---------- Mapa ----------
  // preferCanvas: cientos de puntos y vías se dibujan rápido también en celulares.
  const mapa = L.map("mapa", { zoomControl: false, preferCanvas: true });
  // Zoom abajo a la derecha: arriba quedan las herramientas del mapa.
  L.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);
  // Las fichas de los lugares se acomodan para no quedar debajo de la barra de herramientas.
  L.Popup.prototype.options.autoPanPaddingTopLeft = L.point(12, 68);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>'
  }).addTo(mapa);
  const [s, o, n, e] = resumen.bbox;
  const limites = L.latLngBounds([[s, o], [n, e]]);
  mapa.setView(resumen.punto_central, 16);

  // Datos que le faltan a un lugar o a una vía peatonal; son los que la persona puede completar.
  const esVia = p => p.categoria === "via_peatonal";
  const faltan = p => esVia(p)
    ? [!p.tags.wheelchair && "silla de ruedas", !p.tags.surface && "tipo de camino", !p.tags.lit && "iluminación"].filter(Boolean)
    : [!p.nombre && "nombre", !p.tags.wheelchair && "silla de ruedas"].filter(Boolean);
  const popup = p => {
    const f = faltan(p);
    return `<strong>${esc(p.nombre || (esVia(p) ? "Vía peatonal" : "(sin nombre en el mapa)"))}</strong><br>${esc(p.tipo)}` +
      (f.length ? `<p class="ficha-falta">Al mapa le falta: ${esc(f.join(", "))}.</p>` +
        `<button type="button" class="pill ficha-completar" data-completar="${esc(p.id)}">✏️ Completar lo que veo</button>` : "") +
      `<br><a href="https://www.openstreetmap.org/${esc(p.id)}" target="_blank" rel="noopener">Ver en OSM (${esc(p.id)})</a>`;
  };

  const vias = L.layerGroup().addTo(mapa);
  const viasSinDato = L.layerGroup();
  const sinDato = new Set(v.ids_vias_sin_dato_silla_ruedas);

  geo.features.forEach(f => {
    const p = f.properties;
    if (p.categoria === "via_peatonal") {
      const ll = f.geometry.coordinates.map(c => [c[1], c[0]]);
      // bubblingMouseEvents: false → tocar una vía abre su ficha sin ampliar el mapa a la vez.
      L.polyline(ll, { color: VIA, weight: 3, opacity: .7, bubblingMouseEvents: false }).bindPopup(popup(p)).addTo(vias);
      if (sinDato.has(p.id)) L.polyline(ll, { color: VACIO, weight: 5, dashArray: "6 6", bubblingMouseEvents: false })
        .bindPopup(popup(p)).addTo(viasSinDato);
      estado.porId[p.id] = { latlng: ll[Math.floor(ll.length / 2)], p };
      return;
    }
    const latlng = [p.centro[0], p.centro[1]];
    const capa = estado.capas[p.categoria] || (estado.capas[p.categoria] = L.layerGroup().addTo(mapa));
    const m = L.circleMarker(latlng, {
      radius: 7, color: "#ffffff", weight: 2, fillColor: COLORES[p.categoria] || COLORES.otros, fillOpacity: .95,
      bubblingMouseEvents: false
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
    btnExp.textContent = on ? "⤡" : "⤢";
    btnExp.setAttribute("aria-label", on ? "Reducir mapa" : "Ampliar mapa"); btnExp.title = btnExp.getAttribute("aria-label");
    setTimeout(() => mapa.invalidateSize(), 280);   // respaldo si no hay animación
  }
  franja.addEventListener("transitionend", ev => { if (ev.propertyName === "height") mapa.invalidateSize(); });
  btnExp.addEventListener("click", () => expandir(!franja.classList.contains("expandida")));
  mapa.on("click", () => { if (esMovil() && !estado.eligiendo && !franja.classList.contains("expandida")) expandir(true); });

  // ---------- Celular: teclado y foco ----------
  // En pantallas táctiles no se enfoca la caja de texto por cuenta propia: eso abre el teclado
  // y tapa la respuesta. Solo se enfoca cuando la persona lo pide (tocarla o "Sí, te cuento").
  const esTactil = () => matchMedia("(pointer: coarse)").matches;
  const enfocarEntrada = () => { if (!esTactil()) $("entrada").focus({ preventScroll: true }); };
  // Alto visible real: con el teclado abierto es menor. La página nunca queda desplazada.
  const vv = window.visualViewport;
  function ajustarAlto() {
    document.body.style.setProperty("--alto", `${Math.round(vv ? vv.height : innerHeight)}px`);
    if (scrollY || document.documentElement.scrollTop) scrollTo(0, 0);
  }
  if (vv) { vv.addEventListener("resize", ajustarAlto); vv.addEventListener("scroll", ajustarAlto); }
  addEventListener("resize", ajustarAlto); ajustarAlto();
  const escribiendo = el => el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text"));
  function modoTeclado() {
    const on = esMovil() && esTactil() && escribiendo(document.activeElement);
    if (on === document.body.classList.contains("teclado")) return;
    document.body.classList.toggle("teclado", on);
    ajustarAlto();
    requestAnimationFrame(() => {
      mapa.invalidateSize();
      const el = document.activeElement;
      if (on && el && el.id !== "entrada") el.scrollIntoView({ block: "center" }); else bajar();
    });
  }
  // El teclado aparece y se va con una animación y no todos los celulares avisan el cambio de
  // tamaño a tiempo: se vuelve a medir varias veces durante el primer segundo.
  const remedir = () => [100, 300, 600, 1000].forEach(ms => setTimeout(() => { ajustarAlto(); mapa.invalidateSize(); }, ms));
  // focusout llega antes de que el foco pase al siguiente elemento: se espera un instante.
  document.addEventListener("focusin", () => { modoTeclado(); remedir(); });
  document.addEventListener("focusout", () => { setTimeout(modoTeclado, 120); remedir(); });

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
    const etiqueta = btnDonde.querySelector("span");
    btnDonde.disabled = true; etiqueta.textContent = "Buscando…";
    const fin = () => { btnDonde.disabled = false; etiqueta.textContent = "¿Dónde estoy?"; };
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

  // Lo que se le entrega a la IA: los lugares más cercanos y, además, los más cercanos de cada
  // categoría (así sabe dónde queda la salud más cercana aunque esté lejos).
  function construirContexto() {
    const todos = estado.pois.map(({ latlng, p }) => ({
      id: p.id, categoria: p.categoria, tipo: p.tipo, nombre: p.nombre || null,
      distancia_m: Math.round(distanciaM(estado.ubicacion, latlng)),
      accesible_silla_ruedas: p.tags.wheelchair || null
    })).sort((a, b) => a.distancia_m - b.distancia_m);
    const elegidos = new Set(todos.slice(0, MAX_ELEMENTOS));
    const porCat = {};
    todos.forEach(x => { if ((porCat[x.categoria] = (porCat[x.categoria] || 0) + 1) <= POR_CATEGORIA) elegidos.add(x); });
    const { ids_vias_sin_dato_silla_ruedas, ...vacios } = v;
    return {
      zona: resumen.zona, ciudad: resumen.ciudad,
      ubicacion: { lat: estado.ubicacion[0], lon: estado.ubicacion[1], origen: estado.origenUbicacion },
      conteo_por_categoria: resumen.conteo_por_categoria, nombres_categoria: NOMBRES,
      elementos: todos.filter(x => elegidos.has(x)), vacios
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
  const bajar = () => { lista.scrollTop = lista.scrollHeight; revisarAbajo(); };
  // Una respuesta nueva se muestra desde su primera línea (con el final de la pregunta encima),
  // no desde el final: así se lee de arriba hacia abajo sin tener que buscar el comienzo.
  function mostrarDesdeElInicio(el) {
    lista.scrollTop = Math.max(0, el.offsetTop - 56);
    revisarAbajo();
  }
  // Botón "Ver lo más nuevo": visible cuando hay mensajes por debajo de lo que se está leyendo.
  const btnAbajo = $("btn-abajo");
  function revisarAbajo() {
    btnAbajo.hidden = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 80;
  }
  lista.addEventListener("scroll", revisarAbajo, { passive: true });
  btnAbajo.addEventListener("click", bajar);
  function burbuja(clase, remitente) {
    const b = document.createElement("article");
    b.className = `msg ${clase}`;
    if (remitente) b.innerHTML = `<p class="remitente">${remitente}</p>`;
    lista.appendChild(b); return b;
  }
  // Los avisos también se leen en voz alta cuando está activo "Leer en voz alta".
  function agregarSistema(texto) { burbuja("sistema").textContent = texto; bajar(); if (estado.leerVoz) leer(texto); }
  function agregarPersona(texto) {
    const b = burbuja("persona", "Tú");
    const p = document.createElement("p"); p.textContent = texto; b.appendChild(p); bajar();
  }
  function seccion(b, clase, titulo) {
    const div = document.createElement("div");
    div.className = `msg-seccion ${clase}`;
    div.innerHTML = `<h3>${titulo}</h3>`;
    b.appendChild(div); return div;
  }

  const textoDe = r => estado.modoSencillo && r.respuesta_simple ? r.respuesta_simple : r.respuesta;
  // Lo que se lee en voz alta: la respuesta y, después, lo que el mapa no sabe y la pregunta de vuelta.
  const textoParaLeer = r => [
    textoDe(r),
    r.destacado ? `El ${r.destacado.cifra} ${r.destacado.texto}.` : "",
    r.datos_faltantes && r.datos_faltantes.length ? `Lo que el mapa no sabe: ${r.datos_faltantes.join(". ")}.` : "",
    r.pregunta_de_vuelta ? `¿Tú sabes? ${r.pregunta_de_vuelta}` : "",
    r.hallazgos && r.hallazgos.length ? `Preparé ${r.hallazgos.length === 1 ? "un borrador de nota" : `${r.hallazgos.length} borradores de nota`} para OpenStreetMap. Revísalos antes de publicar.` : ""
  ].filter(Boolean).join(" ");

  const mensajesOsm = [];
  function agregarOsm(r, { leer: leerAhora = estado.leerVoz, accionExtra = null } = {}) {
    const b = burbuja("osm", "OSM Sense");
    const p = document.createElement("p"); p.className = "msg-texto"; p.textContent = textoDe(r); b.appendChild(p);
    if (r.destacado) {
      const dest = document.createElement("p"); dest.className = "destacado";
      dest.innerHTML = `<span class="cifra">${esc(r.destacado.cifra)}</span><span>${esc(r.destacado.texto)}</span>`;
      b.appendChild(dest);
    }

    // Solo se muestran los IDs que existen en los datos; los demás se descartan.
    const validos = (r.ids_citados || []).filter(id => {
      if (estado.porId[id]) return true;
      console.warn("ID citado que no existe en los datos (descartado):", id); return false;
    });
    if (validos.length) {
      const sec = seccion(b, "lugares", "📍 Lugares que menciono <span class=\"nota\">(toca uno para verlo en el mapa)</span>");
      const ul = document.createElement("ul"); ul.className = "citados"; sec.appendChild(ul);
      validos.forEach(id => {
        const d = estado.porId[id], li = document.createElement("li"), btn = document.createElement("button");
        const metros = Math.round(distanciaM(estado.ubicacion, d.latlng));
        btn.type = "button";
        btn.innerHTML = `<strong>${esc(d.p.nombre || d.p.tipo)}</strong><span>${esc(d.p.nombre ? d.p.tipo : "sin nombre en el mapa")} · a ${metros} m</span>`;
        btn.addEventListener("click", () => irA(id)); li.appendChild(btn); ul.appendChild(li);
        if (faltan(d.p).length) {
          const comp = document.createElement("button");
          comp.type = "button"; comp.className = "completar-chip"; comp.textContent = "✏️";
          comp.setAttribute("aria-label", `Completar datos de ${nombreDe(d.p)}`); comp.title = "Completar lo que veo";
          comp.addEventListener("click", () => abrirCompletar(id)); li.appendChild(comp);
        }
      });
    }
    if (r.datos_faltantes && r.datos_faltantes.length) {
      const sec = seccion(b, "no-sabe", "❓ Lo que el mapa no sabe");
      const ul = document.createElement("ul"); ul.className = "faltantes"; sec.appendChild(ul);
      r.datos_faltantes.forEach(t => { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
    }
    if (r.pregunta_de_vuelta) {
      const sec = seccion(b, "pregunta-vuelta", "🤔 ¿Tú sabes?");
      const q = document.createElement("p"); q.textContent = r.pregunta_de_vuelta; sec.appendChild(q);
      const btnContar = document.createElement("button");
      btnContar.type = "button"; btnContar.className = "pill"; btnContar.textContent = "🗣️ Sí, te cuento";
      btnContar.addEventListener("click", () => { entrada.placeholder = "Cuéntame lo que sabes…"; entrada.focus(); });
      sec.appendChild(btnContar);
    }
    const acc = document.createElement("div"); acc.className = "msg-acciones";
    const btnLeer = document.createElement("button");
    btnLeer.type = "button"; btnLeer.className = "pill"; btnLeer.textContent = "🔊 Escuchar";
    btnLeer.addEventListener("click", () => leer(textoParaLeer(r)));
    acc.appendChild(btnLeer);
    if (accionExtra) acc.appendChild(accionExtra);
    b.appendChild(acc);

    mensajesOsm.push({ r, p });
    resaltar(validos);
    mostrarDesdeElInicio(b);
    if (leerAhora) leer(textoParaLeer(r));
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
    // Sin mapa: se dice dónde queda el lugar en vez de mostrarlo.
    if (document.body.classList.contains("sin-mapa")) {
      const t = `${nombreDe(d.p)}. Queda ${dondeQueda(d)}.` + (faltan(d.p).length ? ` Al mapa le falta: ${faltan(d.p).join(", ")}.` : "");
      anunciar(t); leer(t); return;
    }
    mapa.flyTo(d.latlng, 18);
    if (d.marcador) d.marcador.openPopup(); else mapa.openPopup(popup(d.p), d.latlng);
  }

  // ---------- Lo que le falta al mapa (cifras calculadas por scripts/paso2) ----------
  // Porcentaje "sin dato" con un decimal solo si hace falta (99,7 % no es lo mismo que 100 %).
  const sinDatoPct = pctCon => (100 - pctCon).toLocaleString("es-CO", { maximumFractionDigits: 1 });
  const cifras = [
    [sinDatoPct(v.pct_vias_con_dato_silla_ruedas), `de las ${v.vias_peatonales_total} vías peatonales no dice si se puede recorrer en silla de ruedas`],
    v.pct_vias_con_dato_iluminacion !== undefined &&
      [sinDatoPct(v.pct_vias_con_dato_iluminacion), "de las vías peatonales no dice si tiene iluminación"],
    [sinDatoPct(v.pct_vias_con_dato_superficie), "de las vías peatonales no dice de qué material es el andén o camino"],
    [Math.round(100 * v.lugares_sin_nombre / v.lugares_total), `de los ${v.lugares_total} lugares no tiene nombre en el mapa`]
  ].filter(Boolean);

  const viasSinDatoVisibles = on => {
    $("chk-vacios").checked = on;
    if (on) { viasSinDato.addTo(mapa); mapa.fitBounds(limites); } else mapa.removeLayer(viasSinDato);
  };

  // Bienvenida armada con los datos reales de la zona (no es respuesta de la IA).
  // Es corta a propósito: una cifra destacada y un botón; el detalle está en "Lo que falta".
  const btnVerFalta = document.createElement("button");
  btnVerFalta.type = "button"; btnVerFalta.className = "pill"; btnVerFalta.textContent = "🧩 Ver lo que falta";
  btnVerFalta.addEventListener("click", () => { viasSinDatoVisibles(true); $("hoja-mapa").showModal(); });
  agregarOsm({
    respuesta: "Hola. Te explico este barrio con OpenStreetMap, el mapa libre que hace la comunidad. " +
      "Pregúntame, o cuéntame lo que el mapa no sabe.",
    respuesta_simple: "Hola. Te explico este barrio con el mapa libre OpenStreetMap. Pregúntame o cuéntame lo que sabes.",
    destacado: { cifra: `${cifras[0][0]} %`, texto: cifras[0][1] }
  }, { leer: false, accionExtra: btnVerFalta });

  async function enviar(texto) {
    if (!texto || estado.ocupado) return;
    detenerVoz();
    plegarIdeas();
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
      (r.hallazgos || []).forEach(h => agregarBorrador(h));
      estado.historial.push({ role: "assistant", content: [r.respuesta, r.pregunta_de_vuelta].filter(Boolean).join(" ") });
    } else agregarSistema(error.message);
    estado.ocupado = false; btnEnviar.disabled = false;
  }
  if (MODO_DEMO) agregarSistema("Modo demo: las respuestas están preparadas con datos reales de OpenStreetMap de esta zona.");
  lista.scrollTop = 0;   // al abrir, la bienvenida se lee desde el principio
  revisarAbajo();

  // El botón ➤ aparece solo cuando hay algo escrito (Enter también envía); el micrófono queda siempre.
  const autoAlto = () => {
    btnEnviar.hidden = !entrada.value.trim();
    entrada.style.height = "auto"; entrada.style.height = Math.min(entrada.scrollHeight, 140) + "px";
  };
  autoAlto();
  entrada.addEventListener("input", autoAlto);
  entrada.addEventListener("keydown", ev => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    const texto = entrada.value.trim();
    if (!texto || estado.ocupado) return;
    entrada.value = ""; entrada.placeholder = "Pregúntale al mapa…"; autoAlto();
    // En el celular se cierra el teclado para ver la respuesta; en computador se sigue escribiendo.
    if (esTactil()) entrada.blur(); else entrada.focus();
    cajaIdeasLista.querySelectorAll(".elegida").forEach(x => x.classList.remove("elegida"));
    enviar(texto);
  });

  // Ideas para preguntar: visibles al empezar; después de la primera pregunta se pliegan en el botón 💡
  // para dejarle más espacio a la conversación.
  const cajaIdeas = $("caja-ideas"), btnIdeas = $("btn-ideas"), cajaIdeasLista = $("ideas");
  const mostrarIdeas = on => { cajaIdeas.hidden = !on; btnIdeas.setAttribute("aria-expanded", String(on)); };
  function plegarIdeas() { if (btnIdeas.hidden) { btnIdeas.hidden = false; mostrarIdeas(false); } }
  btnIdeas.addEventListener("click", () => mostrarIdeas(cajaIdeas.hidden));
  if (matchMedia("(max-height: 520px)").matches) { btnIdeas.hidden = false; mostrarIdeas(false); }
  (MODO_DEMO ? (guion.turnos || []).map(t => t.pregunta) : IDEAS).forEach(t => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pill"; b.textContent = t;
    b.addEventListener("click", () => {
      entrada.value = t; autoAlto(); enfocarEntrada();
      cajaIdeasLista.querySelectorAll(".elegida").forEach(x => x.classList.remove("elegida")); b.classList.add("elegida");
      anunciar(`Escribí: ${t}. Toca Enviar.`);
      if (!btnIdeas.hidden) mostrarIdeas(false);
    });
    $("ideas").appendChild(b);
  });

  // ---------- "Cuéntame tu barrio": borradores de nota (OSM Sense nunca publica nada) ----------
  const FIRMA = "Reportado por un/a vecino/a mediante OSM Sense (prototipo). Requiere verificación de la comunidad.";
  const TIPOS_HALLAZGO = { nuevo: "Lugar que falta en el mapa", correccion: "Corrección", accesibilidad: "Accesibilidad" };
  const DATO_PERSONAL = /\+?\d[\d\s.-]{6,}\d|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  // Los enlaces (p. ej. openstreetmap.org/way/252078999) no cuentan: sus números no son teléfonos.
  const tieneDatoPersonal = t => DATO_PERSONAL.test(t.replace(/https?:\/\/\S+/g, ""));
  const contador = $("contador-hallazgos");
  let totalHallazgos = 0;
  function anunciar(t) { const el = $("anuncio"); el.textContent = ""; setTimeout(() => { el.textContent = t; }, 50); }

  function agregarBorrador(h, { mostrar = false } = {}) {
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
    const revisar = () => { alerta.hidden = !tieneDatoPersonal(area.value); };
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
    if (rel) nota.fijar(rel.latlng, `junto a ${nombreDe(rel.p)}`);
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
      if (tieneDatoPersonal(area.value) &&
          !confirm("El texto parece tener un teléfono o un correo, y las notas de OSM son públicas. ¿Abrir de todos modos?")) {
        ev.preventDefault(); return;
      }
      copiar(); anunciar("Texto copiado. En OpenStreetMap, pégalo y decide si publicas la nota.");
    });
    btnUbicar.addEventListener("click", () => empezarAUbicar(nota));
    if (mostrar) { mostrarDesdeElInicio(b); if (!esTactil()) area.focus({ preventScroll: true }); } else revisarAbajo();
    return b;
  }

  // Elegir en el mapa la ubicación de una nota: aviso sobre el mapa con botón Cancelar.
  const aviso = $("aviso-ubicar");
  function empezarAUbicar(nota) {
    estado.eligiendo = nota;
    $("aviso-ubicar-texto").textContent = `Toca el mapa donde va la nota ${nota.n}.`;
    aviso.hidden = false; franja.classList.add("eligiendo");
    if (esMovil()) expandir(true);
    anunciar(`Toca el mapa donde va la nota ${nota.n}.`);
    $("btn-cancelar-ubicar").focus({ preventScroll: true });
  }
  function terminarDeUbicar(latlng) {
    const nota = estado.eligiendo;
    if (!nota) return;
    estado.eligiendo = null;
    aviso.hidden = true; franja.classList.remove("eligiendo");
    if (latlng) {
      nota.fijar([latlng.lat, latlng.lng], "punto que elegiste en el mapa");
      anunciar(`Ubicación de la nota ${nota.n} actualizada.`);
    } else anunciar("Ubicación sin cambios.");
    if (esMovil()) expandir(false);   // vuelve a mostrar la tarjeta de la nota
    setTimeout(() => nota.btnUbicar.scrollIntoView({ block: "center" }), 300);
    nota.btnUbicar.focus({ preventScroll: true });
  }
  mapa.on("click", ev => terminarDeUbicar(ev.latlng));
  // Los puntos no pasan el toque al mapa; mientras se ubica una nota, también sirven para elegir.
  estado.pois.forEach(({ p }) => estado.porId[p.id].marcador.on("click", ev => {
    if (estado.eligiendo) { mapa.closePopup(); terminarDeUbicar(ev.latlng); }
  }));
  $("btn-cancelar-ubicar").addEventListener("click", () => terminarDeUbicar(null));

  // ---------- Completar un lugar: la persona cuenta lo que ve → borrador de nota ----------
  // Solo se pregunta lo que le falta al lugar. "No sé" queda marcado: nadie está obligado a responder.
  const PREGUNTAS = {
    "nombre": { clave: "name", texto: "Nombre", titulo: "¿Cómo se llama?" },
    "silla de ruedas": {
      clave: "wheelchair", texto: "Acceso en silla de ruedas",
      titulo: p => esVia(p) ? "¿Se puede recorrer en silla de ruedas?" : "¿Se puede entrar en silla de ruedas?",
      opciones: [["yes", "Sí"], ["limited", "Con dificultad"], ["no", "No"]]
    },
    "tipo de camino": {
      clave: "surface", texto: "Tipo de camino", titulo: "¿Cómo es el camino?",
      opciones: [["paved", "Pavimentado"], ["paving_stones", "Adoquín"], ["unpaved", "Tierra o destapado"]]
    },
    "iluminación": { clave: "lit", texto: "Iluminación", titulo: "¿Tiene luz de noche?", opciones: [["yes", "Sí"], ["no", "No"]] }
  };
  const dlgCompletar = $("completar"), formCompletar = $("form-completar"), avisoCompletar = $("completar-aviso");
  let completando = null;

  function abrirCompletar(id) {
    const d = estado.porId[id];
    if (!d) return;
    completando = id;
    mapa.closePopup();
    const metros = Math.round(distanciaM(estado.ubicacion, d.latlng));
    $("completar-lugar").textContent = `${nombreDe(d.p)} · a ${metros} m. Cuéntame solo lo que veas; ` +
      "si no sabes algo, déjalo en «No sé».";
    $("completar-preguntas").innerHTML = faltan(d.p).map((f, i) => {
      const q = PREGUNTAS[f], titulo = typeof q.titulo === "function" ? q.titulo(d.p) : q.titulo;
      if (!q.opciones) return `<section class="bloque"><h3><label for="q-${i}">${esc(titulo)}</label></h3>
        <input type="text" id="q-${i}" data-clave="${q.clave}" data-texto="${esc(q.texto)}" autocomplete="off"
          placeholder="Escribe el nombre que ves en el letrero"></section>`;
      return `<fieldset class="bloque opciones"><legend>${esc(titulo)}</legend>` +
        [...q.opciones, ["", "No sé"]].map(([valor, et]) =>
          `<label class="opcion"><input type="radio" name="q-${i}" value="${valor}" data-clave="${q.clave}"
             data-texto="${esc(q.texto)}" data-etiqueta="${esc(et)}"${valor ? "" : " checked"}><span>${esc(et)}</span></label>`).join("") +
        "</fieldset>";
    }).join("");
    $("completar-otro").value = ""; avisoCompletar.hidden = true;
    dlgCompletar.showModal();
  }

  formCompletar.addEventListener("submit", ev => {
    ev.preventDefault();
    const d = estado.porId[completando];
    const lineas = [], etiquetas = [];
    formCompletar.querySelectorAll('input[type="text"]').forEach(el => {
      const t = el.value.trim();
      if (t) { lineas.push(`${el.dataset.texto}: ${t}`); etiquetas.push(`${el.dataset.clave}=${t}`); }
    });
    formCompletar.querySelectorAll('input[type="radio"]:checked').forEach(el => {
      if (el.value) { lineas.push(`${el.dataset.texto}: ${el.dataset.etiqueta.toLowerCase()}`); etiquetas.push(`${el.dataset.clave}=${el.value}`); }
    });
    const otro = $("completar-otro").value.trim();
    if (otro) lineas.push(`Observación: ${otro}`);
    const mostrarAviso = t => { avisoCompletar.textContent = t; avisoCompletar.hidden = false; avisoCompletar.scrollIntoView({ block: "nearest" }); };
    if (!lineas.length) return mostrarAviso("Cuéntame al menos un dato. Si no sabes nada de este lugar, toca «Cerrar».");
    if (tieneDatoPersonal(lineas.join(" "))) return mostrarAviso("⚠️ Quita el teléfono o el correo: las notas de OSM son públicas.");
    dlgCompletar.close();
    if (esMovil()) expandir(false);
    const b = agregarBorrador({
      tipo: "correccion",
      descripcion: `Datos de ${nombreDe(d.p)} (https://www.openstreetmap.org/${completando}), según lo que vio un/a vecino/a:\n- ${lineas.join("\n- ")}`,
      id_relacionado: completando,
      etiqueta_osm_sugerida: etiquetas.join(", ") || null
    }, { mostrar: true });
    anunciar(`Listo. Creé el ${b.querySelector("h3").textContent.replace("📝 ", "").toLowerCase()}. Revísalo y, si quieres, publícalo en OpenStreetMap.`);
  });
  $("btn-cerrar-completar").addEventListener("click", () => dlgCompletar.close());
  dlgCompletar.addEventListener("click", ev => { if (ev.target === dlgCompletar) dlgCompletar.close(); });
  // Botón "Completar lo que veo" dentro de las fichas del mapa.
  mapa.on("popupopen", ev => {
    const btn = ev.popup.getElement().querySelector("[data-completar]");
    if (btn) btn.addEventListener("click", () => abrirCompletar(btn.dataset.completar));
  });
  $("btn-completar-cercano").addEventListener("click", () => {
    const sinNombre = estado.pois.filter(({ p }) => !p.nombre)
      .sort((a, b) => distanciaM(estado.ubicacion, a.latlng) - distanciaM(estado.ubicacion, b.latlng))[0];
    $("hoja-mapa").close();
    if (!sinNombre) return agregarSistema("Todos los lugares de esta zona tienen nombre en el mapa.");
    mapa.flyTo(sinNombre.latlng, 18);
    abrirCompletar(sinNombre.p.id);
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
    rec.onend = () => { marcar(false); enfocarEntrada(); };
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

  // ---------- Accesibilidad: pantalla de inicio con perfiles, ajuste fino y vista previa ----------
  const PREFS = "osm-sense-accesibilidad";
  const ajustes = {
    voz: { boton: "btn-voz", aplicar: on => { estado.leerVoz = on; if (!on) detenerVoz(); } },
    letra: { boton: "btn-letra", aplicar: on => {
      document.body.classList.toggle("letra-grande", on);
      // Con letra grande, también los puntos del mapa son más grandes y fáciles de tocar.
      estado.pois.forEach(({ p }) => estado.porId[p.id].marcador.setStyle({ radius: on ? 11 : 7, weight: on ? 3 : 2 }));
      setTimeout(() => mapa.invalidateSize(), 50);
    } },
    contraste: { boton: "btn-contraste", aplicar: on => document.body.classList.toggle("contraste", on) },
    sencillo: { boton: "btn-pedagogico", aplicar: on => { estado.modoSencillo = on; mensajesOsm.forEach(({ r, p }) => { p.textContent = textoDe(r); }); } },
    // Sin mapa: la lista de lugares reemplaza al mapa (lector de pantalla o muy baja visión).
    sinmapa: { boton: "btn-sinmapa", aplicar: on => {
      document.body.classList.toggle("sin-mapa", on);
      $("btn-lista-barra").hidden = !on;
      setTimeout(() => mapa.invalidateSize(), 50);
    } }
  };
  const PERFILES = { escuchar: ["voz"], ver: ["letra", "contraste"], ciego: ["voz", "letra", "contraste", "sinmapa"], sencillo: ["sencillo"] };
  const activo = k => $(ajustes[k].boton).getAttribute("aria-pressed") === "true";
  const PREVIA = {
    normal: "A 55 m está el Parque Metropolitano El Tintal. El mapa no dice si sus caminos se pueden recorrer en silla de ruedas.",
    sencillo: "Hay un parque grande muy cerca. No sabemos si sirve para silla de ruedas."
  };
  function poner(k, on) {
    $(ajustes[k].boton).setAttribute("aria-pressed", String(on));
    ajustes[k].aplicar(on);
  }
  function refrescarInicio() {
    document.querySelectorAll(".perfil").forEach(b =>
      b.setAttribute("aria-pressed", String(PERFILES[b.dataset.perfil].every(activo))));
    $("previa-texto").textContent = activo("sencillo") ? PREVIA.sencillo : PREVIA.normal;
    try { localStorage.setItem(PREFS, JSON.stringify(Object.fromEntries(Object.keys(ajustes).map(k => [k, activo(k)])))); } catch { }
  }
  Object.keys(ajustes).forEach(k => $(ajustes[k].boton).addEventListener("click", () => {
    poner(k, !activo(k));
    if (k === "voz" && activo("voz")) leer("Listo. Leeré en voz alta cada respuesta.");
    refrescarInicio();
  }));
  document.querySelectorAll(".perfil").forEach(b => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    PERFILES[b.dataset.perfil].forEach(k => poner(k, on));
    if (on && b.dataset.perfil === "escuchar") leer("Listo. Leeré en voz alta cada respuesta. También puedes hablarme con el botón del micrófono.");
    if (on && b.dataset.perfil === "ciego") leer("Listo. Leeré todo en voz alta y verás los lugares en una lista, con su distancia y dirección. " +
      "Arriba está el botón Lugares. Abajo puedes escribir o hablar con el micrófono. Toca Empezar para continuar.");
    refrescarInicio();
  }));
  $("btn-probar-voz").addEventListener("click", () => leer($("previa-texto").textContent));
  $("btn-leer-inicio").addEventListener("click", () => leer(
    "¿Cómo prefieres usar OSM Sense? Opción uno: necesito escuchar. Leo en voz alta cada respuesta. " +
    "Opción dos: tengo baja visión. Letra y puntos del mapa más grandes, en blanco y negro con mucho contraste. " +
    "Opción tres: no veo o casi no veo. Leo todo en voz alta y los lugares aparecen en una lista en vez del mapa. " +
    "Opción cuatro: prefiero textos sencillos. " +
    "Al final está el botón Empezar."));

  const inicio = $("inicio");
  $("btn-accesibilidad").addEventListener("click", () => { refrescarInicio(); inicio.showModal(); });
  $("btn-empezar").addEventListener("click", () => inicio.close());
  inicio.addEventListener("close", refrescarInicio);

  // Preferencias guardadas en este navegador; si no hay, se muestra la pantalla de inicio.
  let guardadas = null;
  try { guardadas = JSON.parse(localStorage.getItem(PREFS)); } catch { }
  if (guardadas) Object.keys(ajustes).forEach(k => { if (guardadas[k]) poner(k, true); });
  refrescarInicio();
  if (!guardadas || new URLSearchParams(location.search).has("inicio")) inicio.showModal();

  // ---------- Hoja del mapa: capas y lo que le falta al mapa ----------
  const hojaMapa = $("hoja-mapa");
  $("btn-mapa").addEventListener("click", () => hojaMapa.showModal());
  $("btn-cerrar-mapa").addEventListener("click", () => hojaMapa.close());
  [inicio, hojaMapa].forEach(d => d.addEventListener("click", ev => { if (ev.target === d) d.close(); }));

  // ---------- Lista de lugares: el mapa en texto, con distancia y dirección ----------
  const RUMBOS = ["al norte", "al noreste", "al este", "al sureste", "al sur", "al suroeste", "al oeste", "al noroeste"];
  function rumbo(a, b) {
    const rad = x => x * Math.PI / 180, dLon = rad(b[1] - a[1]);
    const y = Math.sin(dLon) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(dLon);
    const g = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return RUMBOS[Math.round(g / 45) % 8];
  }
  const dondeQueda = d => {
    const m = Math.round(distanciaM(estado.ubicacion, d.latlng));
    return m < 15 ? "aquí mismo" : `a ${m} metros ${rumbo(estado.ubicacion, d.latlng)}`;
  };
  const dlgLista = $("lista"), olLista = $("lista-lugares"), selCat = $("lista-cat");
  const PASO_LISTA = 15;
  let mostrados = PASO_LISTA;
  selCat.innerHTML = `<option value="">Todos los lugares (${estado.pois.length})</option>` +
    Object.entries(resumen.conteo_por_categoria).sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `<option value="${esc(cat)}">${esc(NOMBRES[cat] || cat)} (${n})</option>`).join("");
  function pintarLista() {
    const cat = selCat.value;
    const lugares = estado.pois.filter(({ p }) => !cat || p.categoria === cat)
      .sort((a, b) => distanciaM(estado.ubicacion, a.latlng) - distanciaM(estado.ubicacion, b.latlng));
    $("lista-intro").textContent = `Ordenados del más cercano al más lejano, desde ${estado.origenUbicacion === "gps" ? "donde estás" : "la Biblioteca El Tintal (punto de referencia)"}.`;
    olLista.innerHTML = "";
    lugares.slice(0, mostrados).forEach(({ p }) => {
      const d = estado.porId[p.id], f = faltan(p), li = document.createElement("li");
      li.innerHTML = `<h3><span class="marca-categoria" style="background:${COLORES[p.categoria] || COLORES.otros}" aria-hidden="true"></span>${esc(nombreDe(p))}</h3>
        <p class="donde">${esc(p.nombre ? p.tipo + " · " : "")}${esc(dondeQueda(d))}</p>
        ${f.length ? `<p class="ficha-falta">Al mapa le falta: ${esc(f.join(", "))}.</p>` : ""}
        <div class="acciones-lugar">
          <button type="button" class="pill" data-accion="oir">🔊 Escuchar</button>
          <button type="button" class="pill" data-accion="ver">📍 Ver en el mapa</button>
          ${f.length ? '<button type="button" class="pill" data-accion="completar">✏️ Completar</button>' : ""}
        </div>`;
      const decir = `${nombreDe(p)}. ${p.nombre ? p.tipo + ". " : ""}Queda ${dondeQueda(d)}.` + (f.length ? ` Al mapa le falta: ${f.join(", ")}.` : "");
      li.querySelector("[data-accion=oir]").addEventListener("click", () => leer(decir));
      li.querySelector("[data-accion=ver]").addEventListener("click", () => {
        dlgLista.close();
        if (document.body.classList.contains("sin-mapa")) { poner("sinmapa", false); refrescarInicio(); }
        irA(p.id);
      });
      const c = li.querySelector("[data-accion=completar]");
      if (c) c.addEventListener("click", () => { dlgLista.close(); abrirCompletar(p.id); });
      olLista.appendChild(li);
    });
    $("btn-lista-mas").hidden = lugares.length <= mostrados;
    return lugares.length;
  }
  function abrirLista() {
    mostrados = PASO_LISTA; pintarLista(); dlgLista.showModal();
    if (estado.leerVoz) leer(`Lista de lugares. ${$("lista-intro").textContent} El más cercano: ${olLista.querySelector("h3").textContent}.`);
  }
  $("btn-lista").addEventListener("click", abrirLista);
  $("btn-lista-barra").addEventListener("click", abrirLista);
  $("btn-cerrar-lista").addEventListener("click", () => dlgLista.close());
  dlgLista.addEventListener("click", ev => { if (ev.target === dlgLista) dlgLista.close(); });
  selCat.addEventListener("change", () => { mostrados = PASO_LISTA; const n = pintarLista(); anunciar(`${n} lugares.`); });
  $("btn-lista-mas").addEventListener("click", () => {
    const antes = mostrados; mostrados += PASO_LISTA; pintarLista();
    const nuevo = olLista.children[antes]; if (nuevo) nuevo.querySelector("button").focus();
  });

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

  $("vacios-datos").innerHTML = cifras.map(([n, t]) =>
    `<p class="cifra-fila"><span class="cifra">${n} %</span><span>${esc(t)}</span></p>`).join("") +
    `<p class="nota">${v.vias_peatonales_km} km de vías peatonales revisados. Solo ${v.lugares_con_dato_silla_ruedas} de ${v.lugares_total} lugares dicen si son accesibles.</p>`;
  $("chk-vacios").addEventListener("change", ev => viasSinDatoVisibles(ev.target.checked));
  const btnNota = $("btn-nota");
  const actualizarNota = () => {
    const c = mapa.getCenter(), z = Math.max(mapa.getZoom(), 17);
    btnNota.href = `https://www.openstreetmap.org/note/new?lat=${c.lat.toFixed(6)}&lon=${c.lng.toFixed(6)}` +
      `#map=${z}/${c.lat.toFixed(6)}/${c.lng.toFixed(6)}`;
  };
  mapa.on("moveend", actualizarNota); actualizarNota();
})();
