// ============================================================
// Front Security - App QAP: tela do QRA
// Abre pela URL do QTH (qth.html?p=<posto>&k=<chave>). O QRA entra com nome + PIN e envia QAP
// com foto ou vídeo tirados na hora (sem galeria), áudio de até 15 s e localização.
// Não mostra mídia de ninguém: o QRA só envia. Não usa a senha da equipe.
// ============================================================

// Mudar junto com version.json a cada publicação
const APP_VERSION = '2026-10-31.1';
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
const QUE_CONTA = ev => ev && (ev.temImagem || ev.tipo === 'pausa_fim');

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

function escolherMime(opcoes) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return opcoes.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

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

async function abrirMicrofone() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (e) {
    if (QAP_MOCK) return microfoneFalso();
    throw e;
  }
}

// Só no teste local (?mock=1) quando o aparelho não tem câmera/microfone
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

function microfoneFalso() {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const dest = ac.createMediaStreamDestination();
  osc.frequency.value = 440;
  osc.connect(dest);
  osc.start();
  return dest.stream;
}

function pararStream(s) {
  if (s) s.getTracks().forEach(t => t.stop());
}

// Grava um stream até 15 s (ou até parar()). onTick(segundosRestantes)
class Gravador {
  constructor(stream, mime, opcoes, onTick) {
    this.chunks = [];
    this.rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, opcoes));
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.pronto = new Promise(res => {
      this.rec.onstop = () => {
        clearInterval(this.timer);
        const seg = Math.min(MAX_SEG, (Date.now() - this.inicio) / 1000);
        res({ blob: new Blob(this.chunks, { type: (this.rec.mimeType || mime || '').split(';')[0] }), seg });
      };
    });
    this.inicio = Date.now();
    this.rec.start(1000);
    onTick(MAX_SEG);
    this.timer = setInterval(() => {
      const resta = MAX_SEG - Math.floor((Date.now() - this.inicio) / 1000);
      onTick(Math.max(0, resta));
      if (resta <= 0) this.parar();
    }, 250);
  }
  parar() {
    if (this.rec.state !== 'inactive') this.rec.stop();
    return this.pronto;
  }
}

function blobParaBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// Faixa com posto, QRA, data/hora do servidor e localização, gravada dentro da foto/vídeo
function desenharCarimbo(ctx, w, h, linhas) {
  const fs = Math.max(13, Math.round(w / 42));
  const alt = fs * 2.7;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, h - alt, w, alt);
  ctx.fillStyle = '#F5A623';
  ctx.font = `800 ${fs}px Inter, sans-serif`;
  ctx.fillText(linhas[0], fs * 0.6, h - fs * 1.5);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(fs * 0.85)}px Inter, sans-serif`;
  ctx.fillText(linhas[1], fs * 0.6, h - fs * 0.5);
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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this.enviarFila();
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
    this.abrirEntrar();
  }

  // ----- Principal -----

  abrirPrincipal() {
    document.getElementById('principal-posto').textContent = this.posto.nome;
    document.getElementById('principal-qra').textContent = `QRA ${this.sessao.qraNome}`;
    this.mostrarTela('tela-principal');
    this.tique();
    this.atualizarFila();
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
    const l = this.cap && this.cap.local;
    return [
      `FRONT SECURITY · ${this.posto.nome}`,
      `${this.sessao.qraNome} · ${dataHora(this.agora())}${l ? ` · ${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : ''}`,
    ];
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
      if (!v || v === APP_VERSION || this.cap || this.enviandoFila) return;
      if ((await Fila.todos()).length) return; // nunca recarregar com envio pendente
      location.reload();
    } catch (e) { /* sem internet */ }
  }

  ligarEventos() {
    document.getElementById('btn-tentar').addEventListener('click', () => this.carregarPosto());
    document.getElementById('btn-sair').addEventListener('click', () => this.sair());
    document.getElementById('acoes').addEventListener('click', e => {
      const b = e.target.closest('[data-tipo]');
      if (b) this.abrirCaptura(b.dataset.tipo);
    });
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
