// ============================================================
// Front Security - App QAP: painel da supervisão
// Postos em turno agora, último QAP de cada um, alerta (pisca + som + notificação) quando o QAP
// atrasa, feed do dia com foto/vídeo/áudio e o link + PINs para os QRAs.
// Banco: front-security-coberturas (posts, qras, folgas, coberturas + nó procedimentos/).
// ============================================================

// Mudar junto com version.json a cada publicação
const APP_VERSION = '2026-10-31.4';
const ORDEM_SITUACAO = ['atrasado', 'pausa_longa', 'vence', 'pausa', 'ok', 'desligado', 'fora'];
const SOM_REPETE_MS = 60000;

// ===== Banco: Firebase de verdade ou o falso do teste local (?mock=1) =====

class BancoFirebase {
  constructor() {
    this.db = firebase.database();
    this.offset = 0;
    this.db.ref('.info/serverTimeOffset').on('value', s => { this.offset = s.val() || 0; });
    // celular/aba em segundo plano derruba a conexão: reconecta ao voltar
    let escondidoEm = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) escondidoEm = Date.now();
      else if (escondidoEm && Date.now() - escondidoEm > 30000) { this.db.goOffline(); this.db.goOnline(); escondidoEm = null; }
    });
  }
  onConexao(cb) { this.db.ref('.info/connected').on('value', s => cb(s.val() === true)); }
  // Escuta um caminho; se o Firebase cancelar (ex.: regras), tenta de novo. Devolve o "parar".
  listen(caminho, cb, onErro) {
    let ativo = true;
    const ref = this.db.ref(caminho);
    const handler = snap => cb(snap.val() || {});
    const ligar = () => ref.on('value', handler, err => {
      console.error(`Escuta ${caminho} cancelada:`, err);
      if (onErro) onErro(err);
      if (ativo) setTimeout(ligar, 10000);
    });
    ligar();
    return () => { ativo = false; ref.off('value', handler); };
  }
  set(caminho, v) { return this.db.ref(caminho).set(v); }
  update(caminho, v) { return this.db.ref(caminho).update(v); }
  remove(caminho) { return this.db.ref(caminho).remove(); }
  token() { return firebase.auth().currentUser.getIdToken(); }
}

class BancoMock {
  constructor() { this.offset = 0; }
  onConexao(cb) { cb(true); }
  listen(caminho, cb) {
    let ativo = true;
    const ler = async () => {
      if (!ativo) return;
      try { cb((await (await fetch(`/mock/db?path=${encodeURIComponent(caminho)}`)).json()) || {}); } catch (e) { /* servidor parado */ }
      if (ativo) setTimeout(ler, 2000);
    };
    ler();
    return () => { ativo = false; };
  }
  enviar(metodo, caminho, v) {
    return fetch(`/mock/db?path=${encodeURIComponent(caminho)}`, { method: metodo, body: JSON.stringify(v === undefined ? null : v) });
  }
  set(c, v) { return this.enviar('PUT', c, v); }
  update(c, v) { return this.enviar('PATCH', c, v); }
  remove(c) { return this.enviar('DELETE', c); }
  token() { return Promise.resolve('mock'); }
}

// ===== Som (igual ao Coberturas: só toca depois de um toque na tela) =====

class SoundManager {
  constructor() {
    this.ctx = null;
    try { this.wanted = localStorage.getItem('qapSom') !== 'off'; } catch (e) { this.wanted = true; }
  }
  unlock() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* sem áudio */ }
  }
  get ready() { return !!(this.wanted && this.ctx && this.ctx.state === 'running'); }
  setWanted(on) {
    this.wanted = on;
    try { localStorage.setItem('qapSom', on ? 'on' : 'off'); } catch (e) {}
  }
  alarm() {
    try {
      if (!this.ready) return false;
      const ctx = this.ctx;
      [0, 0.25, 0.5].forEach(offset => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime + offset);
        gain.gain.setValueAtTime(0.25, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + offset + 0.2);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.2);
      });
      return true;
    } catch (e) {
      return false;
    }
  }
}

// ===== App =====

class PainelApp {
  constructor(banco) {
    this.banco = banco;
    this.sched = new Schedule();
    this.cfgs = {};
    this.pins = {};
    this.eventosPorDia = {};
    this.escutasDia = {};
    this.carregado = { posts: false, qras: false, folgas: false, coberturas: false, config: false };
    this.sound = new SoundManager();
    this.alertasVistos = new Set();  // já notificados
    this.cientes = new Set();        // silenciados pelo "Ciente"
    this.ultimoSom = 0;
    this.midiaCache = new Map();
    this.postoAberto = null;
    this.diaFeed = 0;
    this.renderAgendado = false;
  }

  agora() { return Date.now() + (this.banco.offset || 0); }

  init() {
    this.ligarEventos();
    if (!QAP_CONFIG.apiUrl) {
      const el = document.getElementById('aviso-config');
      el.innerHTML = '<strong>⚙️ Backend ainda não configurado.</strong> Os QRAs não conseguem enviar e as fotos não abrem até preencher <code>apiUrl</code> no config.js (ver LEIAME.md).';
      el.classList.remove('hidden');
    }
    this.banco.onConexao(ok => {
      document.getElementById('connection-status').className = `conn-dot ${ok ? 'connected' : 'disconnected'}`;
      document.getElementById('connection-text').textContent = ok ? 'Online' : 'Offline';
    });
    const erro = err => {
      if (err && /permission/i.test(err.message || '')) this.toast('⚠️ Sem permissão no Firebase: publique as regras novas (LEIAME.md).', 'error');
    };
    ['posts', 'qras', 'folgas', 'coberturas'].forEach(c => this.banco.listen(c, d => { this.sched[c] = d; this.carregado[c] = true; this.agendarRender(); }, erro));
    this.banco.listen('procedimentos/config', d => { this.cfgs = d; this.carregado.config = true; this.agendarRender(); }, erro);
    this.banco.listen('procedimentos/pins', d => { this.pins = d; this.renderPins(); }, erro);
    this.escutarDias();
    setInterval(() => { this.escutarDias(); this.agendarRender(); }, 30000);
    setInterval(() => this.relogio(), 1000);
    this.checarVersao();
    setInterval(() => this.checarVersao(), 5 * 60000);
    this.atualizarBotoes();
  }

  // Eventos de hoje e de ontem (dia operacional); troca as escutas quando vira o dia
  escutarDias() {
    const hoje = diaOperacional(this.agora());
    const dias = [hoje, addDays(hoje, -1)];
    Object.keys(this.escutasDia).forEach(d => {
      if (!dias.includes(d)) { this.escutasDia[d](); delete this.escutasDia[d]; delete this.eventosPorDia[d]; }
    });
    dias.forEach(d => {
      if (this.escutasDia[d]) return;
      this.escutasDia[d] = this.banco.listen(`procedimentos/eventos/${d}`, data => {
        this.eventosPorDia[d] = data;
        this.agendarRender();
        if (this.postoAberto) this.renderFeed();
      });
    });
  }

  // setTimeout (não requestAnimationFrame): rAF para em aba de fundo e congelaria os alarmes
  agendarRender() {
    if (this.renderAgendado) return;
    this.renderAgendado = true;
    setTimeout(() => {
      this.renderAgendado = false;
      if (!Object.values(this.carregado).every(Boolean)) return;
      this.render();
    });
  }

  estados() {
    const agora = this.agora();
    return Object.values(this.sched.posts || {}).filter(p => p && p.id).map(post => {
      const est = estadoQap(this.sched, post, this.cfgs[post.id], eventosDoPosto(this.eventosPorDia, post.id), agora);
      return Object.assign(est, { post });
    });
  }

  escaladoAgora(est) {
    if (!est.turno) return '';
    const st = this.sched.slotStatus(est.post, est.turno.date, est.turno.shift);
    const nomes = st.presentes.map(q => q.name).concat(st.coberturas.map(c => `${c.qraName || '?'} (cobertura)`));
    return nomes.join(', ');
  }

  textoSituacao(e) {
    const ate = e.proximoAte ? horaCurta(e.proximoAte) : '';
    switch (e.situacao) {
      case 'atrasado': return `🚨 QAP ATRASADO ${e.atrasoMin} min (era até ${ate})`;
      case 'pausa_longa': return `🚨 3/6 passou ${e.atrasoMin} min (volta era ${ate})`;
      case 'vence': return `⏳ Vence às ${ate}`;
      case 'pausa': return `🍽️ Em 3/6 · volta até ${ate}`;
      case 'ok': return ate ? `✅ Em dia · próximo até ${ate}` : '✅ Em dia';
      case 'desligado': return '⚪ Cobrança de QAP desligada';
      default: return 'Fora de turno';
    }
  }

  render() {
    const estados = this.estados();
    this.renderPostos(estados);
    this.renderAlertas(estados);
    this.renderPins();
    if (this.postoAberto) this.renderResumoPosto(estados.find(e => e.post.id === this.postoAberto));
  }

  renderPostos(estados) {
    const busca = normalizeText(document.getElementById('busca').value);
    const mostrarFora = document.getElementById('mostrar-fora').checked;
    const agora = this.agora();
    const lista = estados
      .filter(e => mostrarFora || e.situacao !== 'fora')
      .filter(e => !busca || normalizeText(`${e.post.name} ${e.post.category} ${this.escaladoAgora(e)}`).includes(busca))
      .sort((a, b) => (ORDEM_SITUACAO.indexOf(a.situacao) - ORDEM_SITUACAO.indexOf(b.situacao)) || a.post.name.localeCompare(b.post.name, 'pt-BR'));
    const porCat = {};
    lista.forEach(e => { (porCat[e.post.category || 'Outros'] = porCat[e.post.category || 'Outros'] || []).push(e); });
    const cats = Object.keys(porCat).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const card = e => {
      const cfg = this.cfgs[e.post.id] || {};
      const u = e.ultimoQap;
      const turno = e.turno ? `${SHIFT_LABEL[e.turno.shift]} ${horaCurta(e.turno.inicio)}–${horaCurta(e.turno.fim)}` : '';
      const escala = this.escaladoAgora(e);
      return `<button class="card ${e.situacao}" data-posto="${escHtml(e.post.id)}">
        <div class="card-topo"><span class="card-nome">${escHtml(e.post.name)}</span><span class="card-turno">${escHtml(turno)}</span></div>
        <div class="card-situacao">${escHtml(this.textoSituacao(e))}</div>
        ${u ? `<div class="card-linha">Último QAP ${horaCurta(u.ts)} · ${escHtml(u.qraNome || '?')} (há ${Math.max(0, Math.round((agora - u.ts) / 60000))} min)</div>` : '<div class="card-linha fraca">Nenhum QAP hoje</div>'}
        ${escala ? `<div class="card-linha fraca">Escala: ${escHtml(escala)}</div>` : ''}
        ${e.horasFalha ? `<div class="card-linha" style="color:#ff8a7d">Falhas no turno: ${e.horasFalha} h</div>` : ''}
        ${!cfg.chave ? '<div class="card-linha fraca">🔗 Sem link ainda: toque para criar</div>' : ''}
      </button>`;
    };
    document.getElementById('postos').innerHTML = cats.length
      ? cats.map(c => `<div class="cat-titulo">${escHtml((CATEGORY_ICONS[c] || '📍') + ' ' + c)}</div><div class="grade">${porCat[c].map(card).join('')}</div>`).join('')
      : '<div class="card-linha fraca">Nenhum posto em turno agora.</div>';
  }

  // Banner, contador, som e notificação dos atrasados
  renderAlertas(estados) {
    const atrasados = estados.filter(e => e.situacao === 'atrasado' || e.situacao === 'pausa_longa');
    const badge = document.getElementById('badge-alertas');
    badge.textContent = atrasados.length ? `🚨 ${atrasados.length} atrasado(s)` : '✅ Tudo em dia';
    badge.classList.toggle('alerta', atrasados.length > 0);
    const chave = e => `${e.post.id}:${e.proximoAte}`;
    const banner = document.getElementById('aviso-alertas');
    if (atrasados.length) {
      banner.innerHTML = `<strong>🚨 QAP atrasado:</strong> ${atrasados.map(e => `${escHtml(e.post.name)} (${e.atrasoMin} min)`).join(' · ')}
        <button id="btn-ciente" class="btn btn-small" style="margin-left:8px">🔕 Ciente (parar o som)</button>`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    const novos = atrasados.filter(e => !this.alertasVistos.has(chave(e)));
    novos.forEach(e => {
      this.alertasVistos.add(chave(e));
      this.notificar(e);
    });
    const tocar = atrasados.some(e => !this.cientes.has(chave(e)));
    if (tocar && (novos.length || Date.now() - this.ultimoSom > SOM_REPETE_MS)) {
      this.sound.alarm();
      this.ultimoSom = Date.now();
    }
    this.atrasadosAgora = atrasados.map(chave);
  }

  notificar(e) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const u = e.ultimoQap;
    try {
      const n = new Notification(`🚨 QAP atrasado — ${e.post.name}`, {
        body: `${this.textoSituacao(e)}\n${u ? `Último QAP ${horaCurta(u.ts)} (${u.qraNome || '?'})` : 'Nenhum QAP no turno'}${this.escaladoAgora(e) ? `\nEscala: ${this.escaladoAgora(e)}` : ''}`,
        tag: `qap-${e.post.id}`,
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); this.abrirPosto(e.post.id); n.close(); };
    } catch (err) { /* navegador sem suporte a Notification fora de service worker */ }
  }

  // ----- Modal do posto -----

  abrirPosto(postId) {
    const post = this.sched.posts[postId];
    if (!post) return;
    this.postoAberto = postId;
    this.diaFeed = 0;
    const cfg = qapConfig(this.cfgs[postId]);
    document.getElementById('mp-titulo').textContent = `${post.name} · ${post.category || ''}`;
    document.getElementById('cfg-ativo').checked = !!cfg.ativo;
    document.getElementById('cfg-intervalo').value = cfg.intervaloMin;
    document.getElementById('cfg-tolerancia').value = cfg.toleranciaMin;
    this.renderLink();
    this.renderResumoPosto(this.estados().find(e => e.post.id === postId));
    document.querySelectorAll('#modal-posto [data-dia]').forEach(b => b.classList.toggle('active', b.dataset.dia === '0'));
    this.renderFeed();
    this.abrirModal('modal-posto');
  }

  renderResumoPosto(e) {
    if (!e) return;
    const escala = this.escaladoAgora(e);
    document.getElementById('mp-resumo').innerHTML = `<strong>${escHtml(this.textoSituacao(e))}</strong>${escala ? ` · Escala: ${escHtml(escala)}` : ''}${e.horasFalha ? ` · <span style="color:#ff8a7d">falhas no turno: ${e.horasFalha} h</span>` : ''}`;
  }

  linkPosto(postId) {
    const cfg = this.cfgs[postId] || {};
    if (!cfg.chave) return '';
    const base = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
    return `${base}qth.html?p=${encodeURIComponent(postId)}&k=${encodeURIComponent(cfg.chave)}${QAP_MOCK ? '&mock=1' : ''}`;
  }

  renderLink() {
    const link = this.linkPosto(this.postoAberto);
    document.getElementById('cfg-link').textContent = link || 'Este posto ainda não tem link.';
    document.getElementById('cfg-novo-link').textContent = link ? '♻️ Gerar link novo' : '🔗 Criar link';
    document.getElementById('cfg-copiar').disabled = !link;
    document.getElementById('cfg-whats').disabled = !link;
  }

  async salvarConfig() {
    const id = this.postoAberto;
    const intervalo = Math.round(Number(document.getElementById('cfg-intervalo').value));
    const tolerancia = Math.round(Number(document.getElementById('cfg-tolerancia').value));
    if (!(intervalo >= 15 && intervalo <= 240) || !(tolerancia >= 0 && tolerancia <= 60)) return this.toast('Intervalo entre 15 e 240 min; tolerância entre 0 e 60.', 'error');
    await this.gravar(this.banco.update(`procedimentos/config/${id}`, {
      ativo: document.getElementById('cfg-ativo').checked, intervaloMin: intervalo, toleranciaMin: tolerancia,
    }), '✅ Regras do posto salvas.');
  }

  async novoLink() {
    const id = this.postoAberto;
    const tinha = !!(this.cfgs[id] || {}).chave;
    if (tinha && !await this.confirmar('O link antigo para de funcionar na hora. Todos os QRAs do posto vão precisar do link novo.', 'Gerar link novo')) return;
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chave = Array.from(bytes, b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
    const cfg = qapConfig(this.cfgs[id]);
    const ok = await this.gravar(this.banco.update(`procedimentos/config/${id}`, {
      chave, intervaloMin: cfg.intervaloMin, toleranciaMin: cfg.toleranciaMin, ativo: !!cfg.ativo,
    }), tinha ? '♻️ Link novo criado. Mande para os QRAs.' : '🔗 Link criado.');
    if (ok) { this.cfgs[id] = Object.assign({}, this.cfgs[id], { chave }); this.renderLink(); }
  }

  copiarLink() {
    const link = this.linkPosto(this.postoAberto);
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => this.toast('📋 Link copiado.', 'success'), () => this.toast('Não deu para copiar: selecione o link e copie.', 'error'));
  }

  whatsLink() {
    const post = this.sched.posts[this.postoAberto];
    const link = this.linkPosto(this.postoAberto);
    if (!post || !link) return;
    const texto = `📸 *QAP ${post.name}*\nA partir de agora o QAP de hora em hora é por este link (foto ou vídeo tirado na hora):\n${link}\n\nEntre com seu nome e o PIN que a supervisão passou. QSL?`;
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  }

  renderFeed() {
    const id = this.postoAberto;
    if (!id) return;
    const dia = addDays(diaOperacional(this.agora()), -this.diaFeed);
    const evs = eventosDoPosto({ [dia]: this.eventosPorDia[dia] || {} }, id).reverse();
    // só redesenha quando chega envio novo deste posto (não reinicia vídeo/áudio tocando)
    const assinatura = `${id}|${dia}|${evs.map(e => e.id).join(',')}`;
    if (assinatura === this.feedAssinatura) return;
    this.feedAssinatura = assinatura;
    const el = document.getElementById('mp-feed');
    if (!evs.length) { el.innerHTML = `<div class="card-linha fraca">Nenhum envio em ${dia.split('-').reverse().join('/')}.</div>`; return; }
    el.innerHTML = evs.map(ev => {
      const t = QAP_TIPOS[ev.tipo] || { icone: '•', nome: ev.tipo };
      const atraso = ev.recebidoEm && ev.recebidoEm - ev.ts > 5 * 60000 ? ` · chegou às ${horaCurta(ev.recebidoEm)} (estava sem internet)` : '';
      const local = isFinite(ev.lat) && isFinite(ev.lng)
        ? `<a href="https://www.google.com/maps?q=${ev.lat},${ev.lng}" target="_blank" rel="noopener noreferrer">📍 mapa</a> (±${ev.prec || '?'} m)`
        : `📍 sem localização${ev.semLocal === 'negada' ? ' (bloqueada no celular)' : ''}`;
      const midias = (ev.midia || []).map(m => `<div class="midia midia-${m.tipo}" data-midia="${escHtml(m.id)}" data-tipo="${m.tipo}">${m.tipo === 'audio' ? '🎙️' : m.tipo === 'video' ? '🎥' : '📸'} carregando…</div>`).join('');
      return `<div class="evento">
        <div class="evento-topo"><strong>${t.icone} ${escHtml(t.nome)} · ${escHtml(ev.qraNome || '?')}</strong><span>${horaCurta(ev.ts)}</span></div>
        <div class="evento-info">${local}${atraso}</div>
        ${ev.texto ? `<div class="evento-texto">${escHtml(ev.texto)}</div>` : ''}
        ${midias ? `<div class="midias">${midias}</div>` : ''}
      </div>`;
    }).join('');
    this.carregarMidias();
  }

  // Mídia só pelo backend, com o login da equipe
  async carregarMidias() {
    const caixas = Array.from(document.querySelectorAll('#mp-feed [data-midia]'));
    for (const caixa of caixas) {
      if (!caixa.isConnected) return;
      const id = caixa.dataset.midia;
      try {
        let url = this.midiaCache.get(id);
        if (!url) {
          const r = await qapApi({ acao: 'midia', id, token: await this.banco.token() });
          const bin = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
          url = URL.createObjectURL(new Blob([bin], { type: r.mime }));
          this.midiaCache.set(id, url);
        }
        if (!caixa.isConnected) continue;
        const tipo = caixa.dataset.tipo;
        const tag = tipo === 'foto' ? `<img src="${url}" alt="foto do QAP" draggable="false">`
          : tipo === 'video' ? `<video src="${url}" controls playsinline controlslist="nodownload noplaybackrate" disablepictureinpicture></video>`
            : `<audio src="${url}" controls controlslist="nodownload"></audio>`;
        caixa.innerHTML = tag;
      } catch (err) {
        if (caixa.isConnected) caixa.textContent = `⚠️ ${qapErroTexto(err)}`;
      }
    }
  }

  // ----- PINs -----

  renderPins() {
    const el = document.getElementById('lista-qras');
    if (!el || !this.carregado.qras) return;
    const busca = normalizeText(document.getElementById('busca-qra').value);
    const nomePosto = q => (this.sched.posts[q.postId] || {}).name || 'Reserva';
    const qras = Object.values(this.sched.qras || {}).filter(q => q && q.id)
      .filter(q => !busca || normalizeText(`${q.name} ${nomePosto(q)}`).includes(busca))
      .sort((a, b) => nomePosto(a).localeCompare(nomePosto(b), 'pt-BR') || String(a.name).localeCompare(String(b.name), 'pt-BR'));
    el.innerHTML = qras.map(q => {
      const tem = !!this.pins[q.id];
      return `<div class="qra-linha">
        <div><div class="nome">${escHtml(q.name)}</div><div class="sub">${escHtml(nomePosto(q))}</div></div>
        <div class="linha">
          <span class="tag-pin${tem ? '' : ' sem'}">${tem ? '🔑 tem PIN' : 'sem PIN'}</span>
          <button class="btn btn-small btn-primary" data-pin="${escHtml(q.id)}">${tem ? 'Gerar novo' : 'Gerar PIN'}</button>
          ${tem ? `<button class="btn btn-small btn-danger" data-sem-pin="${escHtml(q.id)}">Remover</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="card-linha fraca">Nenhum QRA encontrado.</div>';
  }

  async gerarPin(qraId) {
    const q = this.sched.qras[qraId];
    if (!q) return;
    if (this.pins[qraId] && !await this.confirmar(`Gerar um PIN novo para ${q.name}? O antigo para de funcionar.`, 'Gerar PIN novo')) return;
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
    const pin = String(n).padStart(4, '0');
    const ok = await this.gravar(this.banco.set(`procedimentos/pins/${qraId}`, await sha256Hex(`${qraId}:${pin}`)));
    if (!ok) return;
    document.getElementById('pin-nome').textContent = q.name;
    document.getElementById('pin-numero').textContent = pin;
    this.abrirModal('modal-pin');
  }

  async removerPin(qraId) {
    const q = this.sched.qras[qraId];
    if (!q || !await this.confirmar(`Remover o PIN de ${q.name}? Ele não consegue mais mandar QAP até ganhar outro.`, 'Remover PIN')) return;
    await this.gravar(this.banco.remove(`procedimentos/pins/${qraId}`), 'PIN removido.');
  }

  // ----- Diversos -----

  async gravar(promessa, msgOk) {
    try {
      await promessa;
      if (msgOk) this.toast(msgOk, 'success');
      return true;
    } catch (err) {
      console.error(err);
      this.toast('❌ Falha ao salvar. Ninguém vê essa alteração.', 'error');
      return false;
    }
  }

  relogio() {
    const d = new Date(this.agora());
    document.getElementById('clock').textContent = `${horaCurta(d.getTime())}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  abrirModal(id) { document.getElementById(id).classList.add('active'); }

  // Pergunta na própria tela (o confirm() do navegador é bloqueado em alguns navegadores e responde "não")
  confirmar(texto, botao) {
    if (this.respostaConfirma) this.respostaConfirma(false);
    document.getElementById('confirma-texto').textContent = texto;
    document.getElementById('confirma-sim').textContent = botao;
    this.abrirModal('modal-confirma');
    return new Promise(res => { this.respostaConfirma = res; });
  }

  responderConfirma(sim) {
    const res = this.respostaConfirma;
    this.respostaConfirma = null;
    document.getElementById('modal-confirma').classList.remove('active');
    if (res) res(sim);
  }

  fecharModal(el) {
    const m = el.closest('.modal-overlay');
    if (!m) return;
    if (m.id === 'modal-confirma') { this.responderConfirma(false); return; }
    m.classList.remove('active');
    if (m.id === 'modal-posto') { this.postoAberto = null; this.feedAssinatura = null; }
    if (m.id === 'modal-pin') document.getElementById('pin-numero').textContent = '';
  }

  atualizarBotoes() {
    document.getElementById('btn-som').textContent = this.sound.wanted ? '🔊 Som ligado' : '🔇 Som desligado';
    const n = document.getElementById('btn-notif');
    if (!('Notification' in window)) { n.textContent = '🔕 Navegador sem notificação'; n.disabled = true; return; }
    n.textContent = Notification.permission === 'granted' ? '🔔 Notificações ligadas' : Notification.permission === 'denied' ? '🔕 Notificações bloqueadas' : '🔔 Ativar notificações';
  }

  toast(msg, tipo = 'info') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${tipo}`;
    t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, tipo === 'error' ? 6000 : 3500);
  }

  async checarVersao() {
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      const { v } = await r.json();
      if (!v || v === APP_VERSION || document.querySelector('.modal-overlay.active')) return;
      this.toast('⬆️ Nova versão do app — atualizando…');
      setTimeout(() => location.reload(), 800);
    } catch (e) { /* sem internet */ }
  }

  ligarEventos() {
    // áudio só libera depois de um toque
    document.addEventListener('click', () => this.sound.unlock(), { capture: true });
    document.querySelectorAll('.view-tabs [data-view]').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.view-tabs [data-view]').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('view-agora').classList.toggle('hidden', b.dataset.view !== 'agora');
      document.getElementById('view-pins').classList.toggle('hidden', b.dataset.view !== 'pins');
    }));
    document.getElementById('busca').addEventListener('input', () => this.agendarRender());
    document.getElementById('mostrar-fora').addEventListener('change', () => this.agendarRender());
    document.getElementById('busca-qra').addEventListener('input', () => this.renderPins());
    document.getElementById('postos').addEventListener('click', e => {
      const c = e.target.closest('[data-posto]');
      if (c) this.abrirPosto(c.dataset.posto);
    });
    document.getElementById('aviso-alertas').addEventListener('click', e => {
      if (e.target.id !== 'btn-ciente') return;
      (this.atrasadosAgora || []).forEach(k => this.cientes.add(k));
      this.toast('🔕 Som parado para estes atrasos. Se outro posto atrasar, volta a tocar.');
    });
    document.getElementById('btn-som').addEventListener('click', () => {
      this.sound.setWanted(!this.sound.wanted);
      this.sound.unlock();
      if (this.sound.wanted && !this.sound.alarm()) this.toast('Toque em qualquer lugar da tela para liberar o som.');
      this.atualizarBotoes();
    });
    document.getElementById('btn-notif').addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'denied') return this.toast('As notificações estão bloqueadas para este site: libere no cadeado da barra de endereço.', 'error');
      await Notification.requestPermission();
      this.atualizarBotoes();
      if (Notification.permission === 'granted') this.toast('🔔 Você vai receber aviso de QAP atrasado enquanto este painel estiver aberto.', 'success');
    });
    document.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', () => this.fecharModal(b)));
    document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m) this.fecharModal(m); }));
    document.getElementById('cfg-salvar').addEventListener('click', () => this.salvarConfig());
    document.getElementById('cfg-ativo').addEventListener('change', () => this.salvarConfig());
    document.getElementById('cfg-novo-link').addEventListener('click', () => this.novoLink());
    document.getElementById('cfg-copiar').addEventListener('click', () => this.copiarLink());
    document.getElementById('cfg-whats').addEventListener('click', () => this.whatsLink());
    document.querySelectorAll('#modal-posto [data-dia]').forEach(b => b.addEventListener('click', () => {
      this.diaFeed = Number(b.dataset.dia);
      document.querySelectorAll('#modal-posto [data-dia]').forEach(x => x.classList.toggle('active', x === b));
      this.renderFeed();
    }));
    document.getElementById('confirma-sim').addEventListener('click', () => this.responderConfirma(true));
    document.getElementById('lista-qras').addEventListener('click', e => {
      const g = e.target.closest('[data-pin]');
      const r = e.target.closest('[data-sem-pin]');
      if (g) this.gerarPin(g.dataset.pin);
      if (r) this.removerPin(r.dataset.semPin);
    });
    // sem menu de "salvar imagem/vídeo como"
    document.addEventListener('contextmenu', e => { if (e.target.closest('.midia')) e.preventDefault(); });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (QAP_MOCK) { new PainelApp(new BancoMock()).init(); return; }
  AuthGate.start(QAP_CONFIG.firebase).then(() => new PainelApp(new BancoFirebase()).init());
});
