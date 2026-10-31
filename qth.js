// ============================================================
// Front Security - App QAP: tela do QRA
// Abre pela URL do QTH (qth.html?p=<posto>&k=<chave>). O QRA entra com nome + PIN e envia QAP
// com foto ou vídeo tirados na hora (sem galeria), áudio de até 15 s e localização.
// Aba "Objetos de valor": lista do QTH por categoria, adicionar/remover e check-up geral.
// Aba "Mensagens": like, texto e áudio da supervisão em cada informe (busca a cada minuto).
// Não mostra mídia de ninguém: o QRA só envia. Não usa a senha da equipe.
// ============================================================

// Mudar junto com version.json a cada publicação
const APP_VERSION = '2026-10-31.8';
const MAX_SEG = 15;
const FOTO_MAX_PX = 1280;
const VIDEO_LADO = 640; // vídeo sai em 640x480 (ou 480x640 em pé)
const MAX_ANEXOS = 3;

const URL_PARAMS = new URLSearchParams(location.search);
const POSTO = URL_PARAMS.get('p') || '';
const CHAVE = URL_PARAMS.get('k') || '';

// imagem: obrigatoria | opcional | nenhuma
const ACOES = [
  { tipo: 'qap', imagem: 'obrigatoria', principal: true, nome: 'Mandar QAP' },
  { tipo: 'assumir', imagem: 'obrigatoria', nome: 'Assumir posto' },
  { tipo: 'ronda', imagem: 'opcional', nome: 'Ronda' },
  { tipo: 'pausa_ini', imagem: 'nenhuma', nome: 'Saída 3/6' },
  { tipo: 'pausa_fim', imagem: 'nenhuma', nome: 'Volta do 3/6' },
  { tipo: 'passar', imagem: 'opcional', nome: 'Passar posto' },
  { tipo: 'qru', imagem: 'opcional', nome: 'Ocorrência' },
  { tipo: 'qti', imagem: 'nenhuma', nome: 'QTI (a caminho)' },
];
const ICONES = { qap: '📸', assumir: '✅', ronda: '🔦', pausa_ini: '🍽️', pausa_fim: '↩️', passar: '🔄', qru: '🚨', qti: '📻' };
const NOME_INFORME = { qap: 'QAP', assumir: 'Assumir posto', ronda: 'Ronda', pausa_ini: 'Saída 3/6', pausa_fim: 'Volta do 3/6', passar: 'Passar posto', qru: 'Ocorrência', qti: 'QTI' };
const QUE_CONTA =ev => ev && (ev.temImagem || ev.tipo === 'pausa_fim');

// ===== Fila de envios (IndexedDB): sem internet, o envio fica guardado e sai sozinho depois =====

const Fila = {
  db: null,
  memoria: [],
  async abrir() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('qap-fila', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('envios', { keyPath: 'id', autoIncrement: true });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch (e) { this.db = null; } // navegação privada: fila só na memória
  },
  op(modo, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('envios', modo);
      const req = fn(t.objectStore('envios'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  add(item) {
    if (!this.db) { item.id = Date.now() + Math.random(); this.memoria.push(item); return Promise.resolve(); }
    return this.op('readwrite', st => st.add(item));
  },
  todos() {
    if (!this.db) return Promise.resolve(this.memoria.slice());
    return this.op('readonly', st => st.getAll());
  },
  remover(id) {
    if (!this.db) { this.memoria = this.memoria.filter(i => i.id !== id); return Promise.resolve(); }
    return this.op('readwrite', st => st.delete(id));
  },
};

// ===== Câmera e microfone =====

async function abrirCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
    });
  } catch (e) {
    if (QAP_MOCK) return cameraFalsa();
    throw e;
  }
}

// Só no teste local (?mock=1) quando o aparelho não tem câmera
function cameraFalsa() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const ctx = c.getContext('2d');
  let i = 0;
  setInterval(() => {
    i++;
    ctx.fillStyle = `hsl(${(i * 3) % 360}, 40%, 30%)`;
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#fff';
    ctx.font = '700 40px sans-serif';
    ctx.fillText('CÂMERA DE TESTE', 140, 220);
    ctx.fillText(new Date().toLocaleTimeString('pt-BR'), 220, 280);
  }, 66);
  return c.captureStream(15);
}

// Só a data/hora do servidor, no canto de baixo, gravada dentro da foto/vídeo
// (sem empresa, posto, QRA ou localização: isso fica no registro, não na imagem)
function desenharCarimbo(ctx, w, h, texto) {
  const fs = Math.max(13, Math.round(w / 42));
  ctx.font = `700 ${fs}px Inter, sans-serif`;
  const larg = ctx.measureText(texto).width + fs;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(w - larg, h - fs * 1.6, larg, fs * 1.6);
  ctx.fillStyle = '#fff';
  ctx.fillText(texto, w - larg + fs * 0.5, h - fs * 0.5);
}

// Desenha o vídeo da câmera cortado para preencher w x h (sem distorcer)
function desenharCover(ctx, video, w, h) {
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const s = Math.max(w / vw, h / vh);
  const dw = vw * s;
  const dh = vh * s;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// ===== App =====

class QthApp {
  constructor() {
    this.offset = 0;          // relógio do servidor - relógio do celular
    this.posto = null;
    this.qras = [];
    this.sessao = null;
    this.pinDigitado = '';
    this.cap = null;          // estado da captura aberta
    this.enviandoFila = false;
    // objetos de valor: como está no servidor, o rascunho que o QRA está mexendo e o check-up aberto
    this.inv = null;
    this.invRascunho = null;
    this.invModo = 'lista';   // lista | checkup
    this.invAdd = null;       // categoria com o "Adicionar objeto" aberto
    this.invAddQtd = 1;
    this.invAchados = {};     // check-up: "<categoria>/<objeto>" -> quantidade encontrada
    this.invObs = '';
    this.aba = 'qap';
    this.msgs = null;         // respostas da supervisão (null = ainda não buscou)
  }

  agora() { return Date.now() + this.offset; }

  async init() {
    document.getElementById('versao').textContent = `v${APP_VERSION}`;
    this.montarTeclado();
    this.montarAcoes();
    this.ligarEventos();
    setInterval(() => this.tique(), 1000);
    await Fila.abrir();
    try { this.sessao = JSON.parse(localStorage.getItem(this.chaveSessao()) || 'null'); } catch (e) { this.sessao = null; }
    await this.carregarPosto();
    window.addEventListener('online', () => this.enviarFila());
    setInterval(() => this.enviarFila(), 30000);
    setInterval(() => { if (!document.hidden) this.buscarMensagens(); }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this.enviarFila();
      this.buscarMensagens();
      if (Date.now() - (this.carregadoEm || 0) > 5 * 60000) this.carregarPosto(true);
      this.checarVersao();
    });
  }

  chaveSessao() { return `qapSessao_${POSTO}`; }

  mostrarTela(id) {
    ['tela-carregando', 'tela-erro', 'tela-entrar', 'tela-principal'].forEach(t => document.getElementById(t).classList.toggle('hidden', t !== id));
  }

  erroTela(texto) {
    document.getElementById('erro-texto').textContent = texto;
    this.mostrarTela('tela-erro');
  }

  // Dados do posto (nome, QRAs, último QAP). Chamado ao abrir e ao voltar para o app.
  async carregarPosto(silencioso) {
    if (!POSTO || !CHAVE) return this.erroTela(QAP_ERROS.link);
    if (!silencioso) this.mostrarTela('tela-carregando');
    try {
      const t0 = Date.now();
      const r = await qapApi({ acao: 'posto', p: POSTO, k: CHAVE });
      this.offset = r.agora - Math.round((t0 + Date.now()) / 2);
      this.posto = r.posto;
      this.qras = r.qras || [];
      this.ultimo = r.ultimo ? { ts: r.ultimo.ts, qraNome: r.ultimo.qraNome, temImagem: true } : null;
      this.carregadoEm = Date.now();
      document.title = `QAP - ${this.posto.nome}`;
      if (this.sessao && this.qras.some(q => q.id === this.sessao.qraId)) this.abrirPrincipal();
      else if (!silencioso || !this.sessao) this.abrirEntrar();
      this.enviarFila();
    } catch (err) {
      if (silencioso) return;
      this.erroTela(qapErroTexto(err));
    }
  }

  // ----- Entrar -----

  abrirEntrar() {
    document.getElementById('entrar-posto').textContent = this.posto.nome;
    const sel = document.getElementById('sel-qra');
    const doPosto = this.qras.filter(q => q.doPosto);
    const outros = this.qras.filter(q => !q.doPosto);
    const opt = q => `<option value="${escHtml(q.id)}">${escHtml(q.nome)}</option>`;
    sel.innerHTML = '<option value="">— escolha —</option>'
      + (doPosto.length ? `<optgroup label="Deste posto">${doPosto.map(opt).join('')}</optgroup>` : '')
      + (outros.length ? `<optgroup label="Outros (cobertura)">${outros.map(opt).join('')}</optgroup>` : '');
    this.pinDigitado = '';
    this.atualizarPin();
    this.mostrarTela('tela-entrar');
  }

  montarTeclado() {
    const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];
    const el = document.getElementById('teclado');
    el.innerHTML = teclas.map(t => `<button type="button" data-t="${t}">${t}</button>`).join('');
    el.addEventListener('click', e => {
      const t = e.target.closest('button') && e.target.closest('button').dataset.t;
      if (!t) return;
      if (t === '⌫') this.pinDigitado = this.pinDigitado.slice(0, -1);
      else if (t === '✓') return this.entrar();
      else if (this.pinDigitado.length < 4) this.pinDigitado += t;
      this.atualizarPin();
      if (this.pinDigitado.length === 4) this.entrar();
    });
  }

  atualizarPin() {
    document.getElementById('pin-pontos').textContent = '●'.repeat(this.pinDigitado.length) + '○'.repeat(4 - this.pinDigitado.length);
  }

  async entrar() {
    const qraId = document.getElementById('sel-qra').value;
    if (!qraId) { this.pinDigitado = ''; this.atualizarPin(); return this.toast('Escolha seu nome primeiro.', 'error'); }
    if (this.pinDigitado.length !== 4) return;
    const pin = this.pinDigitado;
    this.ocupado(true, 'Conferindo PIN…');
    try {
      const r = await qapApi({ acao: 'entrar', p: POSTO, k: CHAVE, qraId, pin });
      this.sessao = { qraId: r.qra.id, qraNome: r.qra.nome, pin };
      try { localStorage.setItem(this.chaveSessao(), JSON.stringify(this.sessao)); } catch (e) { /* fica só nesta aba */ }
      this.abrirPrincipal();
    } catch (err) {
      this.toast(qapErroTexto(err), 'error');
    } finally {
      this.pinDigitado = '';
      this.atualizarPin();
      this.ocupado(false);
    }
  }

  sair() {
    try { localStorage.removeItem(this.chaveSessao()); } catch (e) {}
    this.sessao = null;
    this.inv = null;
    this.invRascunho = null;
    this.msgs = null;
    this.mostrarAba('qap');
    this.abrirEntrar();
  }

  // ----- Principal -----

  abrirPrincipal() {
    document.getElementById('principal-posto').textContent = this.posto.nome;
    document.getElementById('principal-qra').textContent = `QRA ${this.sessao.qraNome}`;
    this.mostrarTela('tela-principal');
    this.tique();
    this.atualizarFila();
    this.buscarMensagens();
  }

  montarAcoes() {
    document.getElementById('acoes').innerHTML = ACOES.map(a =>
      `<button class="acao${a.principal ? ' principal' : ''}" data-tipo="${a.tipo}"><span class="ic">${ICONES[a.tipo]}</span>${a.nome}</button>`).join('');
  }

  // Relógio + contagem para o próximo QAP (do último QAP do posto, de qualquer QRA)
  tique() {
    const agora = this.agora();
    document.getElementById('clock').textContent = horaCurta(agora);
    if (!this.posto || document.getElementById('tela-principal').classList.contains('hidden')) return;
    const box = document.getElementById('status-qap');
    const grande = document.getElementById('status-grande');
    const peq = document.getElementById('status-peq');
    box.className = 'status-qap';
    if (!this.ultimo || agora - this.ultimo.ts > 12 * 3600000) {
      grande.textContent = 'Mande o QAP';
      peq.textContent = 'Nenhum QAP deste posto nas últimas horas.';
      box.classList.add('vence');
      return;
    }
    const proximo = this.ultimo.ts + (this.posto.intervaloMin || 60) * 60000;
    const falta = Math.round((proximo - agora) / 60000);
    peq.textContent = `Último QAP às ${horaCurta(this.ultimo.ts)}${this.ultimo.qraNome ? ` (${this.ultimo.qraNome})` : ''}`;
    if (falta >= 0) {
      grande.textContent = `Próximo até ${horaCurta(proximo)}`;
      peq.textContent += ` · faltam ${falta} min`;
      if (falta <= 10) box.classList.add('vence');
    } else {
      grande.textContent = `⚠️ QAP atrasado ${-falta} min`;
      box.classList.add('atrasado');
    }
  }

  // ----- Captura -----

  async abrirCaptura(tipo) {
    const acao = ACOES.find(a => a.tipo === tipo);
    this.cap = { acao, anexos: [], local: null, capturadoEm: null, stream: null, gravando: null };
    document.getElementById('cap-titulo').textContent = `${ICONES[tipo]} ${acao.nome}`;
    document.getElementById('cap-texto').value = '';
    document.getElementById('captura').classList.remove('hidden');
    const comImagem = acao.imagem !== 'nenhuma';
    document.getElementById('visor').classList.toggle('hidden', !comImagem);
    document.getElementById('cap-botoes-imagem').classList.toggle('hidden', !comImagem);
    this.renderAnexos();
    this.pegarLocalizacao();
    if (comImagem) {
      this.visorMsg('Abrindo a câmera…');
      try {
        this.cap.stream = await abrirCamera();
        const v = document.getElementById('cap-video');
        v.srcObject = this.cap.stream;
        await v.play().catch(() => {});
        this.visorMsg('');
      } catch (e) {
        this.visorMsg('Câmera bloqueada. Libere a câmera para este site nas configurações do navegador e abra de novo.');
      }
    }
  }

  visorMsg(texto) {
    const m = document.getElementById('cap-msg');
    m.textContent = texto;
    m.classList.toggle('hidden', !texto);
  }

  fecharCaptura() {
    if (!this.cap) return;
    if (this.cap.gravando) this.cap.gravando.gravador.parar();
    pararStream(this.cap.stream);
    this.cap.anexos.forEach(a => URL.revokeObjectURL(a.url));
    document.getElementById('cap-video').srcObject = null;
    document.getElementById('captura').classList.add('hidden');
    this.cap = null;
  }

  pegarLocalizacao() {
    const el = document.getElementById('cap-local');
    if (!navigator.geolocation) { el.textContent = '📍 Sem localização neste aparelho'; return; }
    el.textContent = '📍 Pegando localização…';
    const cap = this.cap;
    navigator.geolocation.getCurrentPosition(
      p => { if (cap !== this.cap) return; cap.local = { lat: p.coords.latitude, lng: p.coords.longitude, prec: Math.round(p.coords.accuracy) }; el.textContent = `📍 Localização ok (±${cap.local.prec} m)`; },
      err => { if (cap !== this.cap) return; cap.semLocal = err.code === 1 ? 'negada' : 'indisponivel'; el.textContent = err.code === 1 ? '📍 Localização bloqueada: libere para este site.' : '📍 Localização indisponível agora.'; },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  carimbo() {
    return dataHora(this.agora());
  }

  podeAnexar(tipo) {
    if (this.cap.anexos.length >= MAX_ANEXOS) { this.toast(`No máximo ${MAX_ANEXOS} anexos por envio.`, 'error'); return false; }
    if (tipo === 'audio' && this.cap.anexos.some(a => a.tipo === 'audio')) { this.toast('Já tem um áudio. Apague para gravar outro.', 'error'); return false; }
    return true;
  }

  async tirarFoto() {
    const v = document.getElementById('cap-video');
    if (!this.cap || !this.cap.stream || !v.videoWidth || this.cap.gravando || !this.podeAnexar('foto')) return;
    const s = Math.min(1, FOTO_MAX_PX / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s);
    c.height = Math.round(v.videoHeight * s);
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, c.width, c.height);
    desenharCarimbo(ctx, c.width, c.height, this.carimbo());
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.7));
    if (!blob || !this.cap) return;
    this.cap.capturadoEm = this.cap.capturadoEm || this.agora();
    this.cap.anexos.push({ tipo: 'foto', mime: 'image/jpeg', blob, url: URL.createObjectURL(blob) });
    this.renderAnexos();
  }

  // Vídeo gravado de um canvas (640x480 + carimbo com hora correndo) para ficar leve e carimbado
  async gravarVideo() {
    const btn = document.getElementById('btn-video');
    if (this.cap && this.cap.gravando && this.cap.gravando.tipo === 'video') return this.pararGravacao();
    const v = document.getElementById('cap-video');
    if (!this.cap || !this.cap.stream || !v.videoWidth || this.cap.gravando || !this.podeAnexar('video')) return;
    const mime = escolherMime(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']);
    if (!window.MediaRecorder) return this.toast('Este navegador não grava vídeo. Use a foto.', 'error');
    const empe = v.videoHeight > v.videoWidth;
    const c = document.createElement('canvas');
    c.width = empe ? 480 : VIDEO_LADO;
    c.height = empe ? VIDEO_LADO : 480;
    const ctx = c.getContext('2d');
    const desenhar = () => { desenharCover(ctx, v, c.width, c.height); desenharCarimbo(ctx, c.width, c.height, this.carimbo()); };
    desenhar();
    const loop = setInterval(desenhar, 50);
    const stream = c.captureStream(20);
    let mic = null;
    try { mic = await abrirMicrofone(); mic.getAudioTracks().forEach(t => stream.addTrack(t)); } catch (e) { /* vídeo sem som */ }
    const cap = this.cap;
    cap.capturadoEm = cap.capturadoEm || this.agora();
    const rec = document.getElementById('cap-rec');
    rec.classList.remove('hidden');
    const gravador = new Gravador(stream, mime, { videoBitsPerSecond: 700000, audioBitsPerSecond: 32000 }, s => {
      rec.textContent = `● ${s}s`;
      btn.textContent = `⏹️ Parar (${s})`;
    });
    cap.gravando = { tipo: 'video', gravador };
    const r = await gravador.pronto;
    clearInterval(loop);
    pararStream(stream);
    pararStream(mic);
    rec.classList.add('hidden');
    btn.textContent = '🎥 Vídeo 15 s';
    if (cap !== this.cap) return;
    cap.gravando = null;
    if (r.blob.size) cap.anexos.push({ tipo: 'video', mime: r.blob.type || mime.split(';')[0], blob: r.blob, seg: r.seg, url: URL.createObjectURL(r.blob) });
    this.renderAnexos();
  }

  async gravarAudio() {
    const btn = document.getElementById('btn-audio');
    if (this.cap && this.cap.gravando && this.cap.gravando.tipo === 'audio') return this.pararGravacao();
    if (!this.cap || this.cap.gravando || !this.podeAnexar('audio')) return;
    if (!window.MediaRecorder) return this.toast('Este navegador não grava áudio.', 'error');
    let mic;
    try { mic = await abrirMicrofone(); } catch (e) { return this.toast('Microfone bloqueado. Libere para este site.', 'error'); }
    const mime = escolherMime(['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
    const cap = this.cap;
    const gravador = new Gravador(mic, mime, { audioBitsPerSecond: 32000 }, s => { btn.textContent = `⏹️ Parar áudio (${s})`; });
    cap.gravando = { tipo: 'audio', gravador };
    const r = await gravador.pronto;
    pararStream(mic);
    btn.textContent = '🎙️ Gravar áudio (até 15 s)';
    if (cap !== this.cap) return;
    cap.gravando = null;
    if (r.blob.size) cap.anexos.push({ tipo: 'audio', mime: r.blob.type || mime.split(';')[0], blob: r.blob, seg: r.seg, url: URL.createObjectURL(r.blob) });
    this.renderAnexos();
  }

  pararGravacao() {
    if (this.cap && this.cap.gravando) this.cap.gravando.gravador.parar();
  }

  renderAnexos() {
    const el = document.getElementById('anexos');
    const nomes = { foto: '📸 Foto', video: '🎥 Vídeo', audio: '🎙️ Áudio' };
    const falta = this.cap.acao.imagem === 'obrigatoria' && !this.cap.anexos.some(a => a.tipo === 'foto' || a.tipo === 'video');
    document.getElementById('btn-enviar').textContent = falta ? 'Enviar (precisa de foto ou vídeo)' : 'Enviar';
    el.innerHTML = this.cap.anexos.map((a, i) => `
      <div class="anexo">
        <span>${nomes[a.tipo]}${a.seg ? ` · ${Math.round(a.seg)} s` : ''} · ${Math.max(1, Math.round(a.blob.size / 1024))} KB</span>
        <button class="btn btn-small btn-danger" data-apagar="${i}">Apagar</button>
      </div>`).join('');
  }

  async enviar() {
    const cap = this.cap;
    if (!cap) return;
    if (cap.gravando) return this.toast('Termine a gravação antes de enviar.', 'error');
    const temImagem = cap.anexos.some(a => a.tipo === 'foto' || a.tipo === 'video');
    if (cap.acao.imagem === 'obrigatoria' && !temImagem) return this.toast('Tire uma foto ou grave um vídeo antes de enviar.', 'error');
    if (cap.acao.tipo === 'qru' && !cap.anexos.length && !document.getElementById('cap-texto').value.trim()) {
      return this.toast('Descreva a ocorrência (texto, áudio ou foto).', 'error');
    }
    this.ocupado(true, 'Preparando…');
    try {
      const midias = [];
      for (const a of cap.anexos) midias.push({ tipo: a.tipo, mime: a.mime, seg: a.seg || 0, b64: await blobParaBase64(a.blob) });
      const body = {
        acao: 'evento', p: POSTO, k: CHAVE, qraId: this.sessao.qraId, pin: this.sessao.pin,
        tipo: cap.acao.tipo, texto: document.getElementById('cap-texto').value.trim(),
        capturadoEm: cap.capturadoEm || this.agora(), midias,
      };
      if (cap.local) Object.assign(body, cap.local);
      else body.semLocal = cap.semLocal || 'sem_resposta';
      await Fila.add({ body, criadoEm: Date.now(), tipo: cap.acao.tipo, temImagem });
      this.fecharCaptura();
    } catch (e) {
      this.ocupado(false);
      return this.toast('Não deu para preparar o envio. Tente de novo.', 'error');
    }
    this.ocupado(false);
    await this.enviarFila(true);
  }

  // Manda tudo o que está na fila, na ordem. Sem internet: fica guardado para a próxima tentativa.
  async enviarFila(mostrar) {
    if (this.enviandoFila || !this.posto) return;
    this.enviandoFila = true;
    let itens = [];
    try { itens = await Fila.todos(); } catch (e) { itens = []; }
    if (mostrar && itens.length) this.ocupado(true, 'Enviando…');
    try {
      for (const item of itens) {
        try {
          const r = await qapApi(item.body);
          await Fila.remover(item.id);
          if (QUE_CONTA(item) && (!this.ultimo || r.ts > this.ultimo.ts)) this.ultimo = { ts: r.ts, qraNome: this.sessao ? this.sessao.qraNome : '', temImagem: true };
          const nome = (ACOES.find(a => a.tipo === item.tipo) || {}).nome || 'Envio';
          this.toast(`✅ ${nome} enviado às ${horaCurta(r.ts)}`, 'success');
        } catch (err) {
          if (err.codigo === 'rede' || err.codigo === 'interno' || err.codigo === 'config') {
            if (mostrar) this.toast('📶 Sem conexão: o envio ficou guardado e sai sozinho quando a internet voltar. Não feche o app.', 'error');
            break;
          }
          // recusado pelo servidor (PIN trocado, link trocado...): não adianta repetir
          await Fila.remover(item.id);
          this.toast(`❌ NÃO enviado: ${qapErroTexto(err)}`, 'error');
          if (err.codigo === 'pin' || err.codigo === 'sem_pin') { this.sair(); break; }
          if (err.codigo === 'link') { this.erroTela(QAP_ERROS.link); break; }
        }
      }
    } finally {
      this.enviandoFila = false;
      this.ocupado(false);
      this.atualizarFila();
      this.tique();
    }
  }

  async atualizarFila() {
    let n = 0;
    try { n = (await Fila.todos()).length; } catch (e) {}
    const el = document.getElementById('fila-aviso');
    el.textContent = `📤 ${n} envio(s) aguardando internet. Não feche o app.`;
    el.classList.toggle('hidden', n === 0);
  }

  // ----- Objetos de valor do QTH -----

  mostrarAba(aba) {
    this.aba = aba;
    document.querySelectorAll('#abas-qra [data-aba]').forEach(b => b.classList.toggle('active', b.dataset.aba === aba));
    ['qap', 'inv', 'msg'].forEach(a => document.getElementById(`aba-${a}`).classList.toggle('hidden', aba !== a));
    if (aba === 'inv' && !this.invRascunho) this.carregarInv();
    if (aba === 'msg') { this.renderMensagens(); this.marcarVistas(); }
  }

  // ----- Mensagens da supervisão (like, texto, áudio) -----

  chaveVisto() { return `qapVisto_${POSTO}_${this.sessao ? this.sessao.qraId : ''}`; }

  // Cada like/mensagem tem um horário; "visto" guarda o mais novo que o QRA já viu
  momentos(itens) {
    const ts = [];
    (itens || []).forEach(i => {
      if (i.curtida) ts.push(i.curtida.ts);
      i.msgs.forEach(m => ts.push(m.ts));
    });
    return ts;
  }

  async buscarMensagens() {
    if (!this.sessao || !this.posto || this.buscandoMsgs) return;
    this.buscandoMsgs = true;
    try {
      const r = await qapApi({ acao: 'mensagens', p: POSTO, k: CHAVE, qraId: this.sessao.qraId, pin: this.sessao.pin });
      const antes = Math.max(0, ...this.momentos(this.msgs));
      const primeira = this.msgs === null;
      this.msgs = r.itens || [];
      const novas = this.momentos(this.msgs).filter(t => t > antes).length;
      if (!primeira && novas && this.aba !== 'msg') this.avisarMensagem();
      if (this.aba === 'msg') { this.renderMensagens(); this.marcarVistas(); }
      this.atualizarBadge();
    } catch (err) {
      if (err.codigo === 'pin' || err.codigo === 'sem_pin' || err.codigo === 'link') this.erroSessao(err);
    } finally {
      this.buscandoMsgs = false;
    }
  }

  avisarMensagem() {
    this.toast('💬 A supervisão respondeu seu informe. Veja em Mensagens.', 'success');
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(ac.currentTime + 0.25);
    } catch (e) { /* sem som antes do primeiro toque */ }
  }

  marcarVistas() {
    const max = Math.max(0, ...this.momentos(this.msgs));
    try { localStorage.setItem(this.chaveVisto(), String(max)); } catch (e) {}
    this.atualizarBadge();
  }

  atualizarBadge() {
    let visto = 0;
    try { visto = Number(localStorage.getItem(this.chaveVisto()) || 0); } catch (e) {}
    const n = this.momentos(this.msgs).filter(t => t > visto).length;
    const b = document.getElementById('msg-badge');
    b.textContent = n;
    b.classList.toggle('hidden', !n);
  }

  renderMensagens() {
    const el = document.getElementById('msgs');
    if (this.msgs === null) { el.innerHTML = '<div class="inv-vazio">Carregando…</div>'; return; }
    if (!this.msgs.length) {
      el.innerHTML = '<div class="inv-vazio">Nenhuma resposta da supervisão hoje.<br>Quando ela curtir ou responder um informe seu, aparece aqui.</div>';
      return;
    }
    el.innerHTML = this.msgs.map(i => {
      return `<div class="msg-item">
        <div class="msg-topo">${ICONES[i.evTipo] || '•'} ${escHtml(NOME_INFORME[i.evTipo] || i.evTipo)} das ${horaCurta(i.evTs)}</div>
        ${i.curtida ? `<div class="msg-linha">👍 A supervisão curtiu <span>${horaCurta(i.curtida.ts)}</span></div>` : ''}
        ${i.msgs.map(m => `<div class="msg-linha">🗣️ ${m.tipo === 'texto'
          ? escHtml(m.texto)
          : `<span data-audio-resp="${escHtml((m.midia || {}).id)}"><button class="btn btn-small" data-ouvir="${escHtml((m.midia || {}).id)}">▶️ Ouvir áudio (${Math.round((m.midia || {}).seg || 0)} s)</button></span>`} <span>${horaCurta(m.ts)}</span></div>`).join('')}
      </div>`;
    }).join('');
  }

  async ouvirAudio(id) {
    const caixa = document.querySelector(`[data-audio-resp="${CSS.escape(id)}"]`);
    if (!caixa) return;
    caixa.textContent = 'Carregando o áudio…';
    try {
      const r = await qapApi({ acao: 'midia_resp', p: POSTO, k: CHAVE, qraId: this.sessao.qraId, pin: this.sessao.pin, id });
      const bin = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bin], { type: r.mime }));
      caixa.innerHTML = `<audio src="${url}" controls autoplay controlslist="nodownload"></audio>`;
    } catch (err) {
      caixa.textContent = `⚠️ ${qapErroTexto(err)}`;
    }
  }

  async carregarInv() {
    const el = document.getElementById('inv');
    el.innerHTML = '<div class="inv-vazio">Carregando os objetos…</div>';
    try {
      const r = await qapApi({ acao: 'inventario', p: POSTO, k: CHAVE, qraId: this.sessao.qraId, pin: this.sessao.pin });
      this.usarInv(r.inv || {});
    } catch (err) {
      if (this.erroSessao(err)) return;
      el.innerHTML = `<div class="inv-vazio">⚠️ ${escHtml(qapErroTexto(err))}</div><button class="btn" style="width:100%" data-inv="recarregar">Tentar de novo</button>`;
    }
  }

  usarInv(inv) {
    this.inv = inv;
    this.invRascunho = { tipo: inv.tipo || '', itens: JSON.parse(JSON.stringify(inv.itens || {})) };
    this.invModo = 'lista';
    this.invAdd = null;
    this.renderInv();
  }

  // PIN ou link trocados no meio do caminho: volta para a tela certa. Devolve true se tratou.
  erroSessao(err) {
    if (err.codigo === 'pin' || err.codigo === 'sem_pin') { this.toast(qapErroTexto(err), 'error'); this.sair(); return true; }
    if (err.codigo === 'link') { this.erroTela(QAP_ERROS.link); return true; }
    return false;
  }

  // Quantos objetos o rascunho tem de diferente do servidor (+1 se trocou o tipo do posto)
  invMudancas() {
    if (!this.inv || !this.invRascunho) return 0;
    const a = this.inv.itens || {}, d = this.invRascunho.itens;
    let n = (this.inv.tipo || '') !== this.invRascunho.tipo ? 1 : 0;
    new Set([...Object.keys(a), ...Object.keys(d)]).forEach(cat => {
      const x = a[cat] || {}, y = d[cat] || {};
      new Set([...Object.keys(x), ...Object.keys(y)]).forEach(k => { if (((x[k] || {}).qtd || 0) !== ((y[k] || {}).qtd || 0)) n++; });
    });
    return n;
  }

  invOcupado() { return this.invMudancas() > 0 || this.invModo === 'checkup'; }

  // Objetos de uma categoria em ordem alfabética: [[chave, {nome, qtd}], ...]
  invLista(itens, cat) {
    return Object.entries(itens[cat] || {}).sort((a, b) => a[1].nome.localeCompare(b[1].nome, 'pt-BR'));
  }

  renderInv() {
    const el = document.getElementById('inv');
    const r = this.invRascunho;
    if (!r) return;
    if (!r.tipo) {
      el.innerHTML = `<div class="inv-vazio">Que tipo de posto é este?</div>
        <div class="captura-botoes">${Object.entries(INV_TIPOS).map(([id, t]) =>
          `<button class="btn btn-primary" data-inv="tipo" data-tipo="${id}">${t.icone} ${t.nome}</button>`).join('')}</div>`;
      return;
    }
    if (this.invModo === 'checkup') return this.renderCheckup();
    const tipo = INV_TIPOS[r.tipo];
    const total = Object.keys(tipo.categorias).reduce((n, cat) => n + Object.keys(r.itens[cat] || {}).length, 0);
    const uc = this.inv.ultimoCheckup;
    const mud = this.invMudancas();
    let h = `<div class="inv-topo"><strong>${tipo.icone} ${tipo.nome}</strong>${total ? '' : '<button class="btn btn-small" data-inv="trocar-tipo">Trocar tipo</button>'}</div>`;
    h += uc
      ? `<div class="inv-checkup ${uc.divergencias ? 'ruim' : 'bom'}">${uc.divergencias ? `⚠️ Último check-up: ${uc.divergencias} divergência(s)` : '✅ Último check-up: tudo confere'}
          <div class="peq">${dataHora(uc.ts)} · ${escHtml(uc.qraNome)}</div></div>`
      : '<div class="inv-checkup">Nenhum check-up feito ainda.</div>';
    Object.entries(tipo.categorias).forEach(([cat, nomeCat]) => {
      const lista = this.invLista(r.itens, cat);
      h += `<div class="inv-cat"><div class="inv-cat-titulo">${escHtml(nomeCat)} <span>${lista.length} objeto(s)</span></div>`;
      h += lista.map(([k, it]) => `<div class="inv-item">
          <span class="nome">${escHtml(it.nome)}</span>
          <div class="qtd"><button data-inv="menos" data-cat="${cat}" data-k="${k}" aria-label="Menos">−</button><b>${it.qtd}</b><button data-inv="mais" data-cat="${cat}" data-k="${k}" aria-label="Mais">+</button></div>
          <button class="lixo" data-inv="remover" data-cat="${cat}" data-k="${k}" aria-label="Remover">🗑️</button>
        </div>`).join('') || '<div class="posto-sub">Nenhum objeto.</div>';
      h += this.invAdd === cat ? this.formAdd(cat) : `<button class="btn btn-small inv-add" data-inv="abrir-add" data-cat="${cat}">＋ Adicionar objeto</button>`;
      h += '</div>';
    });
    h += mud
      ? `<div class="inv-rodape"><button class="btn" data-inv="desfazer">Desfazer</button><button class="btn btn-primary" data-inv="salvar">💾 Salvar alterações (${mud})</button></div>`
      : `<button class="btn btn-primary inv-grande" data-inv="checkup"${total ? '' : ' disabled'}>✅ Fazer check-up geral</button>`;
    el.innerHTML = h;
  }

  formAdd(cat) {
    const lista = this.invRascunho.itens[cat] || {};
    const opcoes = INV_OBJETOS.filter(o => !lista[invChave(o)]).map(o => `<option>${escHtml(o)}</option>`).join('');
    return `<div class="inv-form">
      <select id="inv-add-obj" class="form-input"><option value="">— escolha o objeto —</option>${opcoes}<option value="__outro">Outro (digitar)…</option></select>
      <input id="inv-add-outro" class="form-input hidden" maxlength="40" placeholder="Nome do objeto">
      <div class="linha" style="justify-content:space-between">Quantidade
        <div class="qtd"><button data-inv="add-menos" aria-label="Menos">−</button><b id="inv-add-qtd">${this.invAddQtd}</b><button data-inv="add-mais" aria-label="Mais">+</button></div></div>
      <div class="inv-rodape"><button class="btn" data-inv="fechar-add">Cancelar</button><button class="btn btn-primary" data-inv="confirmar-add" data-cat="${cat}">Adicionar</button></div>
    </div>`;
  }

  // Check-up geral: confere a lista salva no servidor, objeto por objeto
  renderCheckup() {
    const inv = this.inv;
    const tipo = INV_TIPOS[inv.tipo];
    let total = 0, feitos = 0, div = 0;
    let h = `<div class="inv-topo"><strong>✅ Check-up geral</strong><button class="btn btn-small" data-inv="sair-checkup">✕ Cancelar</button></div>
      <div class="posto-sub" style="margin-bottom:10px">Conte cada objeto. Toque em <b>Confere</b> se a quantidade bate, ou ajuste no − / + quanto você encontrou.</div>`;
    Object.entries(tipo.categorias).forEach(([cat, nomeCat]) => {
      const lista = this.invLista(inv.itens || {}, cat);
      if (!lista.length) return;
      h += `<div class="inv-cat"><div class="inv-cat-titulo">${escHtml(nomeCat)}</div>`;
      h += lista.map(([k, it]) => {
        const chave = `${cat}/${k}`;
        const enc = this.invAchados[chave];
        total++;
        if (enc !== undefined) feitos++;
        if (enc !== undefined && enc !== it.qtd) div++;
        const st = enc === undefined ? '' : enc === it.qtd ? ' ok' : ' div';
        return `<div class="inv-item${st}">
          <span class="nome">${escHtml(it.nome)}<small>esperado ${it.qtd}${st === ' div' ? ` · encontrado ${enc}` : ''}</small></span>
          <div class="qtd"><button data-inv="ck-menos" data-chave="${chave}" aria-label="Menos">−</button><b>${enc === undefined ? '?' : enc}</b><button data-inv="ck-mais" data-chave="${chave}" aria-label="Mais">+</button></div>
          <button class="btn btn-small${st === ' ok' ? ' btn-primary' : ''}" data-inv="ck-ok" data-chave="${chave}">✔ Confere</button>
        </div>`;
      }).join('');
      h += '</div>';
    });
    h += `<textarea id="inv-obs" class="form-input" rows="2" maxlength="500" placeholder="Observação (opcional): o que sumiu, quebrou…">${escHtml(this.invObs)}</textarea>
      <button class="btn btn-primary inv-grande" data-inv="enviar-checkup"${feitos < total ? ' disabled' : ''}>Enviar check-up (${feitos}/${total})${div ? ` · ${div} divergência(s)` : ''}</button>`;
    document.getElementById('inv').innerHTML = h;
  }

  esperado(chave) {
    const [cat, k] = chave.split('/');
    return ((this.inv.itens || {})[cat] || {})[k].qtd;
  }

  acaoInv(acao, d) {
    const r = this.invRascunho;
    const it = d.cat && d.k && r && (r.itens[d.cat] || {})[d.k];
    switch (acao) {
      case 'recarregar': return this.carregarInv();
      case 'tipo': r.tipo = d.tipo; break;
      case 'trocar-tipo': r.tipo = ''; break;
      case 'menos': if (it) it.qtd = Math.max(1, it.qtd - 1); break;
      case 'mais': if (it) it.qtd = Math.min(999, it.qtd + 1); break;
      case 'remover':
        delete r.itens[d.cat][d.k];
        if (!Object.keys(r.itens[d.cat]).length) delete r.itens[d.cat];
        break;
      case 'abrir-add': this.invAdd = d.cat; this.invAddQtd = 1; break;
      case 'fechar-add': this.invAdd = null; break;
      case 'add-menos':
      case 'add-mais':
        this.invAddQtd = Math.min(999, Math.max(1, this.invAddQtd + (acao === 'add-mais' ? 1 : -1)));
        document.getElementById('inv-add-qtd').textContent = this.invAddQtd;
        return;
      case 'confirmar-add': {
        const sel = document.getElementById('inv-add-obj').value;
        const nome = (sel === '__outro' ? document.getElementById('inv-add-outro').value : sel).trim().slice(0, 40);
        const k = invChave(nome);
        if (!nome || !k) return this.toast(sel === '__outro' ? 'Digite o nome do objeto.' : 'Escolha o objeto.', 'error');
        const lista = r.itens[d.cat] = r.itens[d.cat] || {};
        if (lista[k]) lista[k].qtd = Math.min(999, lista[k].qtd + this.invAddQtd);
        else lista[k] = { nome, qtd: this.invAddQtd };
        this.invAdd = null;
        break;
      }
      case 'desfazer': return this.usarInv(this.inv);
      case 'salvar': return this.salvarInv();
      case 'checkup': this.invModo = 'checkup'; this.invAchados = {}; this.invObs = ''; break;
      case 'sair-checkup': this.invModo = 'lista'; break;
      case 'ck-ok': this.invAchados[d.chave] = this.esperado(d.chave); break;
      case 'ck-menos':
      case 'ck-mais': {
        const atual = this.invAchados[d.chave] !== undefined ? this.invAchados[d.chave] : this.esperado(d.chave);
        this.invAchados[d.chave] = Math.min(999, Math.max(0, atual + (acao === 'ck-mais' ? 1 : -1)));
        break;
      }
      case 'enviar-checkup': return this.enviarCheckup();
      default: return;
    }
    this.renderInv();
  }

  async salvarInv() {
    this.ocupado(true, 'Salvando…');
    try {
      const r = await qapApi({
        acao: 'inventario_salvar', p: POSTO, k: CHAVE, qraId: this.sessao.qraId, pin: this.sessao.pin,
        tipo: this.invRascunho.tipo, itens: this.invRascunho.itens,
      });
      this.usarInv(r.inv || {});
      this.toast('✅ Objetos salvos.', 'success');
    } catch (err) {
      if (!this.erroSessao(err)) this.toast(`❌ Não salvou: ${qapErroTexto(err)}`, 'error');
    } finally {
      this.ocupado(false);
    }
  }

  async enviarCheckup() {
    this.ocupado(true, 'Enviando check-up…');
    try {
      const r = await qapApi({
        acao: 'checkup', p: POSTO, k: CHAVE, qraId: this.sessao.qraId, pin: this.sessao.pin,
        encontrados: this.invAchados, obs: this.invObs.trim(),
      });
      const uc = r.ultimoCheckup;
      this.inv.ultimoCheckup = uc;
      this.invModo = 'lista';
      this.invAchados = {};
      this.invObs = '';
      this.renderInv();
      this.toast(uc.divergencias ? `⚠️ Check-up enviado com ${uc.divergencias} divergência(s). Aparece para a supervisão.` : '✅ Check-up enviado: tudo confere.', uc.divergencias ? 'error' : 'success');
    } catch (err) {
      if (this.erroSessao(err)) return;
      this.toast(`❌ Check-up NÃO enviado: ${qapErroTexto(err)}`, 'error');
      if (err.codigo === 'checkup') this.carregarInv();
    } finally {
      this.ocupado(false);
    }
  }

  // ----- Diversos -----

  ocupado(sim, texto) {
    const el = document.getElementById('enviando');
    if (texto) el.textContent = texto;
    el.classList.toggle('hidden', !sim);
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
      if (!v || v === APP_VERSION || this.cap || this.enviandoFila || this.invOcupado()) return;
      if ((await Fila.todos()).length) return; // nunca recarregar com envio pendente
      recarregarParaVersao(v, ['qth.html', 'qth.js', 'style.css', 'config.js']);
    } catch (e) { /* sem internet */ }
  }

  ligarEventos() {
    document.getElementById('btn-tentar').addEventListener('click', () => this.carregarPosto());
    document.getElementById('btn-sair').addEventListener('click', () => this.sair());
    document.getElementById('acoes').addEventListener('click', e => {
      const b = e.target.closest('[data-tipo]');
      if (b) this.abrirCaptura(b.dataset.tipo);
    });
    document.getElementById('abas-qra').addEventListener('click', e => {
      const b = e.target.closest('[data-aba]');
      if (b) this.mostrarAba(b.dataset.aba);
    });
    document.getElementById('msgs').addEventListener('click', e => {
      const b = e.target.closest('[data-ouvir]');
      if (b) this.ouvirAudio(b.dataset.ouvir);
    });
    const inv = document.getElementById('inv');
    inv.addEventListener('click', e => {
      const b = e.target.closest('[data-inv]');
      if (b && !b.disabled) this.acaoInv(b.dataset.inv, b.dataset);
    });
    inv.addEventListener('change', e => {
      if (e.target.id === 'inv-add-obj') document.getElementById('inv-add-outro').classList.toggle('hidden', e.target.value !== '__outro');
    });
    inv.addEventListener('input', e => { if (e.target.id === 'inv-obs') this.invObs = e.target.value; });
    document.getElementById('cap-fechar').addEventListener('click', () => this.fecharCaptura());
    document.getElementById('btn-foto').addEventListener('click', () => this.tirarFoto());
    document.getElementById('btn-video').addEventListener('click', () => this.gravarVideo());
    document.getElementById('btn-audio').addEventListener('click', () => this.gravarAudio());
    document.getElementById('btn-enviar').addEventListener('click', () => this.enviar());
    document.getElementById('anexos').addEventListener('click', e => {
      const b = e.target.closest('[data-apagar]');
      if (!b || !this.cap) return;
      const [a] = this.cap.anexos.splice(Number(b.dataset.apagar), 1);
      if (a) URL.revokeObjectURL(a.url);
      this.renderAnexos();
    });
    // nada de menu de "salvar imagem" / arrastar
    document.addEventListener('contextmenu', e => e.preventDefault());
  }
}

const app = new QthApp();
document.addEventListener('DOMContentLoaded', () => app.init());
