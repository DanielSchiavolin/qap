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
// Objetos de valor: tipo do posto -> categorias (iguais ao INV_TIPOS do config.js)
const INV_CATEGORIAS = { stand: ['copa', 'decorado', 'salao', 'area_externa'], terreno: ['terreno'] };
const INV_CHAVE = /^[a-z0-9_]{1,40}$/;
const INV_MAX_ITENS = 150;

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
      case 'inventario': return json_(inventario_(req));
      case 'inventario_salvar': return json_(inventarioSalvar_(req));
      case 'checkup': return json_(checkup_(req));
      case 'responder': return json_(responder_(req));
      case 'mensagens': return json_(mensagens_(req));
      case 'midia_resp': return json_(midiaResp_(req));
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

// ===== Respostas da supervisão a cada informe (procedimentos/respostas/<dia>/<posto>/<evento>) =====

// Painel (conta da equipe): curtir, mensagem de texto ou áudio de até 15 s para o QRA que enviou
function responder_(req) {
  checarEquipe_(req.token);
  const p = String(req.p || ''), dia = String(req.dia || ''), ev = String(req.ev || '');
  if (!ID_VALIDO.test(p) || !/^\d{4}-\d{2}-\d{2}$/.test(dia) || !ID_VALIDO.test(ev)) throw erro_('resposta');
  const evento = db_(`procedimentos/eventos/${dia}/${p}/${ev}`);
  if (!evento) throw erro_('resposta');
  const base = `procedimentos/respostas/${dia}/${p}/${ev}`;
  const agora = Date.now();
  let msg = null;
  if (req.tipo === 'texto') {
    const texto = String(req.texto || '').trim().slice(0, 500);
    if (!texto) throw erro_('resposta');
    msg = { tipo: 'texto', texto, ts: agora };
  } else if (req.tipo === 'audio') {
    const post = db_(`posts/${p}`) || {};
    const hora = Utilities.formatDate(new Date(agora), TZ, 'HH-mm-ss');
    const midia = salvarMidia_(Object.assign({}, req.midia, { tipo: 'audio' }), pastaDoDia_(post.name, p, dia), `${hora}_resposta_supervisao`);
    msg = { tipo: 'audio', midia, ts: agora };
  } else if (req.tipo !== 'curtir') {
    throw erro_('resposta');
  }
  db_(base, 'patch', { qraId: evento.qraId, qraNome: evento.qraNome || '', evTipo: evento.tipo, evTs: evento.ts });
  if (msg) db_(`${base}/msgs`, 'post', msg);
  else if (req.valor) db_(`${base}/curtida`, 'put', { ts: agora });
  else db_(`${base}/curtida`, 'delete');
  CacheService.getScriptCache().remove(`resp_${dia}_${p}`);
  return { ok: true };
}

// Tela do QRA: respostas aos informes dele de hoje e de ontem. Chamada a cada minuto pelos
// celulares abertos, por isso tudo vem do cache (o responder_ limpa o cache quando muda algo).
function mensagens_(req) {
  checarQraLeve_(req);
  return { ok: true, agora: Date.now(), itens: respostasDoQra_(req.p, req.qraId) };
}

// Áudio de resposta: só se a resposta for para este QRA
function midiaResp_(req) {
  checarQraLeve_(req);
  const id = String(req.id || '');
  const dele = respostasDoQra_(req.p, req.qraId).some(i => i.msgs.some(m => m.midia && m.midia.id === id));
  if (!dele) throw erro_('midia');
  const blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
}

// Link + PIN com cache de 5 min. PIN que não bate passa pelo checarPin_ (conta erro e bloqueia).
function checarQraLeve_(req) {
  if (!ID_VALIDO.test(String(req.p || '')) || !req.k) throw erro_('link');
  const cfg = doCache_(`cfg_${req.p}`, 300, () => db_(`procedimentos/config/${req.p}`));
  if (!cfg || !cfg.chave || cfg.chave !== String(req.k)) throw erro_('link');
  if (!ID_VALIDO.test(String(req.qraId || ''))) throw erro_('pin');
  const pin = doCache_(`pinh_${req.qraId}`, 300, () => db_(`procedimentos/pins/${req.qraId}`));
  if (!pin || !/^\d{4}$/.test(String(req.pin || '')) || sha256_(`${req.qraId}:${req.pin}`) !== pin) checarPin_(req.qraId, req.pin);
}

function respostasDoQra_(p, qraId) {
  const hoje = diaOperacional_(new Date());
  const itens = [];
  [ontem_(hoje), hoje].forEach(dia => {
    const tudo = doCache_(`resp_${dia}_${p}`, 600, () => db_(`procedimentos/respostas/${dia}/${p}`)) || {};
    Object.keys(tudo).forEach(ev => {
      const r = tudo[ev];
      if (!r || r.qraId !== qraId) return;
      const msgs = Object.keys(r.msgs || {}).map(k => r.msgs[k]).sort((a, b) => a.ts - b.ts);
      if (!msgs.length && !r.curtida) return;
      itens.push({ dia, ev, evTipo: r.evTipo, evTs: r.evTs, curtida: r.curtida || null, msgs });
    });
  });
  return itens.sort((a, b) => b.evTs - a.evTs);
}

function doCache_(chave, segundos, ler) {
  const cache = CacheService.getScriptCache();
  const guardado = cache.get(chave);
  if (guardado !== null) return JSON.parse(guardado);
  const v = ler();
  const s = JSON.stringify(v === undefined ? null : v);
  if (s.length < 90000) cache.put(chave, s, segundos);
  return v;
}

// ===== Objetos de valor do QTH (procedimentos/inventario/<posto> e inventario_hist/<posto>) =====

function inventario_(req) {
  checarPosto_(req.p, req.k);
  checarPin_(req.qraId, req.pin);
  return { ok: true, inv: db_(`procedimentos/inventario/${req.p}`) || {} };
}

// O QRA manda a lista inteira (tipo + objetos); o que mudou vai para o histórico com o nome dele
function inventarioSalvar_(req) {
  checarPosto_(req.p, req.k);
  const qra = checarPin_(req.qraId, req.pin);
  const tipo = String(req.tipo || '');
  if (!INV_CATEGORIAS[tipo]) throw erro_('inventario');
  const itens = limparItens_(tipo, req.itens);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const atual = db_(`procedimentos/inventario/${req.p}`) || {};
    const mudancas = diferencas_(atual.itens || {}, itens);
    const trocouTipo = (atual.tipo || '') !== tipo;
    if (!mudancas.length && !trocouTipo) return { ok: true, inv: atual, mudancas: 0 };
    const agora = Date.now();
    const novo = { tipo, itens, alteradoEm: agora, alteradoPor: qra.nome };
    if (atual.ultimoCheckup) novo.ultimoCheckup = atual.ultimoCheckup;
    db_(`procedimentos/inventario/${req.p}`, 'put', novo);
    const hist = { acao: 'alteracao', ts: agora, qraId: qra.id, qraNome: qra.nome, mudancas };
    if (trocouTipo) hist.tipo = { de: atual.tipo || '', para: tipo };
    db_(`procedimentos/inventario_hist/${req.p}`, 'post', hist);
    return { ok: true, inv: novo, mudancas: mudancas.length };
  } finally {
    lock.releaseLock();
  }
}

// Check-up geral: o QRA manda quanto encontrou de cada objeto; o esperado vem do banco
function checkup_(req) {
  checarPosto_(req.p, req.k);
  const qra = checarPin_(req.qraId, req.pin);
  const inv = db_(`procedimentos/inventario/${req.p}`) || {};
  const achados = req.encontrados || {};
  const itens = [];
  let divergencias = 0;
  Object.keys(inv.itens || {}).forEach(cat => Object.keys(inv.itens[cat] || {}).forEach(k => {
    const it = inv.itens[cat][k];
    const v = achados[`${cat}/${k}`];
    const enc = Number(v);
    if (v === undefined || v === null || v === '' || !(enc >= 0 && enc <= 999 && Math.floor(enc) === enc)) throw erro_('checkup');
    if (enc !== it.qtd) divergencias++;
    itens.push({ cat, nome: it.nome, esperado: it.qtd, encontrado: enc });
  }));
  if (!itens.length) throw erro_('checkup');
  const resumo = { ts: Date.now(), qraId: qra.id, qraNome: qra.nome, total: itens.length, divergencias, obs: String(req.obs || '').slice(0, 500) };
  db_(`procedimentos/inventario_hist/${req.p}`, 'post', Object.assign({ acao: 'checkup', itens }, resumo));
  db_(`procedimentos/inventario/${req.p}/ultimoCheckup`, 'put', resumo);
  return { ok: true, ultimoCheckup: resumo };
}

function limparItens_(tipo, itens) {
  const out = {};
  let n = 0;
  INV_CATEGORIAS[tipo].forEach(cat => {
    const lista = (itens && itens[cat]) || {};
    Object.keys(lista).forEach(k => {
      const it = lista[k] || {};
      const qtd = Number(it.qtd);
      const nome = String(it.nome || '').trim().slice(0, 40);
      if (!INV_CHAVE.test(k) || !nome || !(qtd >= 1 && qtd <= 999 && Math.floor(qtd) === qtd)) throw erro_('inventario');
      if (++n > INV_MAX_ITENS) throw erro_('inventario');
      (out[cat] = out[cat] || {})[k] = { nome, qtd };
    });
  });
  return out;
}

function diferencas_(antes, depois) {
  const mudancas = [];
  const cats = Object.keys(Object.assign({}, antes, depois));
  cats.forEach(cat => {
    const a = antes[cat] || {}, d = depois[cat] || {};
    Object.keys(Object.assign({}, a, d)).forEach(k => {
      const de = (a[k] && a[k].qtd) || 0, para = (d[k] && d[k].qtd) || 0;
      if (de !== para) mudancas.push({ cat, nome: (d[k] || a[k]).nome, de, para });
    });
  });
  return mudancas;
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
