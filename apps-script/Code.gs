/**
 * Front Security - App QAP: backend no Google Apps Script (roda na conta Google da empresa).
 *
 * - Tela do QRA (qth.html): confere a chave do posto + PIN do QRA, guarda foto/vídeo/áudio no
 *   Google Drive (pasta "Front Security - QAP/<posto>/<dia>") e grava o registro no Firebase
 *   (projeto front-security-coberturas, nó procedimentos/eventos/<dia>/<posto>).
 * - Painel da supervisão (index.html): entrega a mídia só para a conta da equipe (ID token do
 *   Firebase Auth). Os arquivos no Drive nunca ficam públicos.
 *
 * O Firebase é acessado com o login de quem implantou (dono do projeto), por isso este script não
 * guarda senha nenhuma. Instalação: ../LEIAME.md, seção "Backend no Google Apps Script".
 */

const FIREBASE_DB = 'https://front-security-coberturas-default-rtdb.firebaseio.com';
const FIREBASE_API_KEY = 'AIzaSyB2XpLy5atMeLtc-XuOaAtY9m72mK9dZSY';
const TEAM_EMAIL = 'schiavolindaniel@gmail.com';
const PASTA_RAIZ = 'Front Security - QAP';
const MARCA_ARQUIVO = 'front-security-qap'; // só arquivos com esta descrição podem ser entregues
const TZ = 'America/Sao_Paulo';
const DIAS_GUARDAR = 35;                    // limparAntigos(): manda para a lixeira o que for mais velho
const TIPOS = ['qti', 'assumir', 'qap', 'ronda', 'pausa_ini', 'pausa_fim', 'passar', 'qru'];
const PRECISA_IMAGEM = ['qap', 'assumir'];
const MIMES = { foto: ['image/jpeg'], video: ['video/mp4', 'video/webm'], audio: ['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg'] };
const EXT = { 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' };
const MAX_MB = 15;
const MAX_SEG = 16; // 15 s + folga do gravador
const MAX_MIDIAS = 4;
const PIN_TENTATIVAS = 5;
const PIN_BLOQUEIO_S = 15 * 60;
const ID_VALIDO = /^[A-Za-z0-9_\-]{1,80}$/;

function doGet() {
  return json_({ ok: true, agora: Date.now() });
}

// A tela manda JSON como text/plain (sem "preflight" de CORS, que o Apps Script não atende)
function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (req.acao) {
      case 'posto': return json_(posto_(req));
      case 'entrar': return json_(entrar_(req));
      case 'evento': return json_(evento_(req));
      case 'midia': return json_(midia_(req));
      default: return json_({ ok: false, erro: 'acao' });
    }
  } catch (err) {
    if (err && err.qap) return json_({ ok: false, erro: err.qap });
    console.error(err && err.stack || err);
    return json_({ ok: false, erro: 'interno' });
  }
}

// ===== Ações =====

// Dados do posto para a tela do QRA: nome, regras, lista de QRAs e o último QAP
function posto_(req) {
  const { post, cfg } = checarPosto_(req.p, req.k);
  const qras = db_('qras') || {};
  const hoje = diaOperacional_(new Date());
  const coberturas = db_('coberturas') || {};
  const cobrindo = {};
  Object.keys(coberturas).forEach(id => {
    const c = coberturas[id];
    if (c && c.postId === req.p && c.qraId && (c.date === hoje || c.date === ontem_(hoje))) cobrindo[c.qraId] = true;
  });
  const lista = Object.keys(qras).map(id => {
    const q = qras[id] || {};
    const doPosto = q.postId === req.p || (q.extra || []).some(x => x && x.postId === req.p) || !!cobrindo[id];
    return { id, nome: String(q.name || id), doPosto };
  }).sort((a, b) => (b.doPosto - a.doPosto) || a.nome.localeCompare(b.nome, 'pt-BR'));
  return {
    ok: true,
    agora: Date.now(),
    posto: { id: req.p, nome: post.name, categoria: post.category || '', intervaloMin: cfg.intervaloMin || 60 },
    qras: lista,
    ultimo: ultimoQap_(req.p, hoje),
  };
}

function entrar_(req) {
  checarPosto_(req.p, req.k);
  const qra = checarPin_(req.qraId, req.pin);
  return { ok: true, agora: Date.now(), qra };
}

function evento_(req) {
  const { post } = checarPosto_(req.p, req.k);
  const qra = checarPin_(req.qraId, req.pin);
  if (TIPOS.indexOf(req.tipo) < 0) throw erro_('tipo');
  const midias = Array.isArray(req.midias) ? req.midias.slice(0, MAX_MIDIAS) : [];
  if (PRECISA_IMAGEM.indexOf(req.tipo) >= 0 && !midias.some(m => m && (m.tipo === 'foto' || m.tipo === 'video'))) throw erro_('sem_imagem');

  const agora = Date.now();
  // horário da captura (relógio do celular corrigido pelo servidor); fora de 12 h, vale a chegada
  let capturadoEm = Number(req.capturadoEm);
  if (!isFinite(capturadoEm) || capturadoEm > agora + 120000 || capturadoEm < agora - 12 * 3600000) capturadoEm = agora;
  const dia = diaOperacional_(new Date(capturadoEm));

  const pasta = pastaDoDia_(post.name, req.p, dia);
  const hora = Utilities.formatDate(new Date(capturadoEm), TZ, 'HH-mm-ss');
  const salvas = midias.map((m, i) => salvarMidia_(m, pasta, `${hora}_${req.tipo}_${qra.nome}_${i + 1}`));

  const ev = {
    tipo: req.tipo,
    qraId: qra.id,
    qraNome: qra.nome,
    ts: capturadoEm,
    recebidoEm: agora,
    texto: String(req.texto || '').slice(0, 500),
    midia: salvas,
  };
  ['lat', 'lng', 'prec'].forEach(k => { const v = Number(req[k]); if (req[k] !== null && req[k] !== undefined && req[k] !== '' && isFinite(v)) ev[k] = v; });
  if (req.semLocal) ev.semLocal = String(req.semLocal).slice(0, 60);
  const r = db_(`procedimentos/eventos/${dia}/${req.p}`, 'post', ev);
  return { ok: true, id: r && r.name, ts: capturadoEm, dia };
}

// Mídia para o painel: só para a conta da equipe e só arquivos criados por este script
function midia_(req) {
  checarEquipe_(req.token);
  if (!/^[A-Za-z0-9_\-]{10,}$/.test(String(req.id || ''))) throw erro_('midia');
  let arq;
  try { arq = DriveApp.getFileById(req.id); } catch (e) { throw erro_('midia'); }
  if (arq.getDescription() !== MARCA_ARQUIVO || arq.isTrashed()) throw erro_('midia');
  const blob = arq.getBlob();
  return { ok: true, mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
}

// ===== Conferências =====

function checarPosto_(p, k) {
  if (!ID_VALIDO.test(String(p || '')) || !k) throw erro_('link');
  const cfg = db_(`procedimentos/config/${p}`);
  if (!cfg || !cfg.chave || cfg.chave !== String(k)) throw erro_('link');
  const post = db_(`posts/${p}`);
  if (!post) throw erro_('link');
  return { post, cfg };
}

// PIN de 4 dígitos guardado como SHA-256 de "<qraId>:<pin>". 5 erros = 15 min bloqueado.
function checarPin_(qraId, pin) {
  if (!ID_VALIDO.test(String(qraId || ''))) throw erro_('pin');
  const cache = CacheService.getScriptCache();
  const chaveCache = 'pin_' + qraId;
  const erros = Number(cache.get(chaveCache) || 0);
  if (erros >= PIN_TENTATIVAS) throw erro_('bloqueado');
  const guardado = db_(`procedimentos/pins/${qraId}`);
  if (!guardado) throw erro_('sem_pin');
  if (!/^\d{4}$/.test(String(pin || '')) || sha256_(`${qraId}:${pin}`) !== guardado) {
    cache.put(chaveCache, String(erros + 1), PIN_BLOQUEIO_S);
    throw erro_('pin');
  }
  cache.remove(chaveCache);
  const q = db_(`qras/${qraId}`);
  if (!q) throw erro_('pin');
  return { id: qraId, nome: String(q.name || qraId) };
}

// ID token do Firebase Auth da conta da equipe (conferido no Google; guardado 10 min em cache)
function checarEquipe_(token) {
  if (!token) throw erro_('equipe');
  const cache = CacheService.getScriptCache();
  const k = 'tk_' + sha256_(String(token)).slice(0, 40);
  if (cache.get(k) === 'ok') return;
  const r = UrlFetchApp.fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: String(token) }), muteHttpExceptions: true,
  });
  const u = r.getResponseCode() === 200 && JSON.parse(r.getContentText()).users;
  if (!u || !u[0] || u[0].email !== TEAM_EMAIL) throw erro_('equipe');
  cache.put(k, 'ok', 600);
}

// ===== Drive =====

function salvarMidia_(m, pasta, nomeBase) {
  if (!m || !MIMES[m.tipo]) throw erro_('midia');
  const mime = String(m.mime || '').split(';')[0].trim();
  if (MIMES[m.tipo].indexOf(mime) < 0) throw erro_('midia');
  const seg = Number(m.seg) || 0;
  if (m.tipo !== 'foto' && seg > MAX_SEG) throw erro_('longo');
  const bytes = Utilities.base64Decode(String(m.b64 || ''));
  if (!bytes.length || bytes.length > MAX_MB * 1024 * 1024) throw erro_('grande');
  const nome = `${limparNome_(nomeBase)}.${EXT[mime]}`;
  const arq = pasta.createFile(Utilities.newBlob(bytes, mime, nome));
  arq.setDescription(MARCA_ARQUIVO);
  const out = { id: arq.getId(), tipo: m.tipo, mime, kb: Math.round(bytes.length / 1024) };
  if (m.tipo !== 'foto') out.seg = Math.round(seg * 10) / 10;
  return out;
}

function pastaRaiz_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('pastaRaiz');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* recria abaixo */ }
  }
  const it = DriveApp.getRootFolder().getFoldersByName(PASTA_RAIZ);
  const f = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(PASTA_RAIZ);
  props.setProperty('pastaRaiz', f.getId());
  return f;
}

// Tira do nome os caracteres que o Drive/Windows não aceitam em nome de arquivo (\x22 = aspas)
function limparNome_(s) {
  return String(s).replace(/[\\/:*?\x22<>|]/g, '');
}

function subpasta_(pai, nome) {
  const it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

// Uma trava evita duas pastas com o mesmo nome quando dois envios chegam juntos
function pastaDoDia_(nomePosto, postId, dia) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const posto = subpasta_(pastaRaiz_(), `${limparNome_(nomePosto || postId)} (${postId})`);
    return subpasta_(posto, dia);
  } finally {
    lock.releaseLock();
  }
}

// ===== Firebase (REST, com o login do dono do projeto) =====

function db_(caminho, metodo, corpo) {
  const opt = {
    method: metodo || 'get',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (corpo !== undefined) opt.payload = JSON.stringify(corpo);
  const r = UrlFetchApp.fetch(`${FIREBASE_DB}/${caminho}.json`, opt);
  if (r.getResponseCode() >= 300) throw new Error(`Firebase ${r.getResponseCode()} em ${caminho}: ${r.getContentText().slice(0, 200)}`);
  return JSON.parse(r.getContentText() || 'null');
}

function ultimoQap_(postId, hoje) {
  let melhor = null;
  [ontem_(hoje), hoje].forEach(dia => {
    const evs = db_(`procedimentos/eventos/${dia}/${postId}`) || {};
    Object.keys(evs).forEach(id => {
      const ev = evs[id];
      const conta = ev && ((ev.midia || []).some(m => m.tipo === 'foto' || m.tipo === 'video') || ev.tipo === 'pausa_fim');
      if (conta && (!melhor || ev.ts > melhor.ts)) melhor = { ts: ev.ts, qraNome: ev.qraNome, tipo: ev.tipo };
    });
  });
  return melhor;
}

// ===== Utilidades =====

// Dia operacional: antes das 07:00 ainda é a noite do dia anterior
function diaOperacional_(d) {
  const hora = Number(Utilities.formatDate(d, TZ, 'H'));
  const base = hora < 7 ? new Date(d.getTime() - 12 * 3600000) : d;
  return Utilities.formatDate(base, TZ, 'yyyy-MM-dd');
}

function ontem_(dia) {
  const [y, m, d] = dia.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(y, m - 1, d - 1, 15)), TZ, 'yyyy-MM-dd');
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function erro_(codigo) {
  const e = new Error(codigo);
  e.qap = codigo;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===== Rodar à mão no editor =====

// 1ª vez: autoriza o script (Drive + Firebase) e confere se ele enxerga o banco. Não grava nada no banco.
function testarConexao() {
  const posts = db_('posts') || {};
  const pasta = pastaRaiz_();
  console.log(`Firebase ok: ${Object.keys(posts).length} postos. Pasta no Drive: ${pasta.getName()} (${pasta.getUrl()})`);
}

// Manda para a lixeira do Drive as pastas de dias com mais de DIAS_GUARDAR dias (a lixeira do
// Google esvazia sozinha em 30 dias). Para rodar todo dia: Acionadores > Adicionar > limparAntigos.
function limparAntigos() {
  const limite = Utilities.formatDate(new Date(Date.now() - DIAS_GUARDAR * 86400000), TZ, 'yyyy-MM-dd');
  let n = 0;
  const postos = pastaRaiz_().getFolders();
  while (postos.hasNext()) {
    const dias = postos.next().getFolders();
    while (dias.hasNext()) {
      const d = dias.next();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d.getName()) && d.getName() < limite) { d.setTrashed(true); n++; }
    }
  }
  console.log(`${n} pasta(s) de dia anteriores a ${limite} foram para a lixeira.`);
}
