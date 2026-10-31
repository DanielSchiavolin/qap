/**
 * Front Security - App QAP: backend no Google Apps Script (roda na conta Google da empresa).
 *
 * - Tela do QRA (qth.html): confere a chave do posto + PIN do QRA, guarda foto/vídeo/áudio no
 *   Google Drive (pasta "Front Security - QAP/<posto>/<dia>") e grava o registro no Firebase
 *   (projeto front-security-coberturas, nó procedimentos/eventos/<dia>/<posto>).
 * - Painel da supervisão (index.html): entrega a mídia só para a conta da equipe (ID token do
 *   Firebase Auth). Os arquivos no Drive nunca ficam públicos.
 *
 * Segurança: a tela do QRA só passa pela "porta" (porta_): sistema não pausado, pedido assinado pelo
 * app oficial (quando "Exigir app" está ligado), limite de pedidos por posto e sessão assinada (o
 * celular nunca guarda o PIN). Bloqueios, prints e gravações vão para procedimentos/seguranca.
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

// Segurança
const SESSAO_HORAS = 16;                    // depois disso o QRA digita o PIN de novo
const APP_JANELA_MS = 6 * 3600000;          // relógio do celular pode estar até 6 h errado
const MAX_CORPO = 45 * 1024 * 1024;         // pedido maior que isso nem é lido
const POSTO_PIN_ERROS = 20;                 // erros de PIN no mesmo posto em 15 min = link travado 15 min
const LIMITE_POSTO = 300;                   // pedidos por posto a cada 10 min
const LIMITE_ENVIOS = 60;                   // envios (QAP, ronda...) por posto a cada 10 min
const ALERTAS_APP = ['print', 'gravacao'];

// Ações da tela do QRA (passam pela "porta": app oficial, limites, sistema não pausado)
const ACOES_QRA = {
  posto: req => posto_(req),
  entrar: req => entrar_(req),
  evento: req => evento_(req),
  inventario: req => inventario_(req),
  inventario_salvar: req => inventarioSalvar_(req),
  checkup: req => checkup_(req),
  mensagens: req => mensagens_(req),
  midia_resp: req => midiaResp_(req),
  alerta_seguranca: req => alertaSeguranca_(req),
};
// Ações do painel (conferem o login da equipe)
const ACOES_EQUIPE = {
  midia: req => midia_(req),
  responder: req => responder_(req),
  sistema: req => sistemaConfig_(req),
  segredo_app: req => segredoAppEquipe_(req),
  alerta_seguranca_equipe: req => alertaSegurancaEquipe_(req),
};

function doGet() {
  return json_({ ok: true, agora: Date.now() });
}

// A tela manda JSON como text/plain (sem "preflight" de CORS, que o Apps Script não atende)
function doPost(e) {
  try {
    if (e && e.postData && e.postData.length > MAX_CORPO) throw erro_('grande');
    let req;
    try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { throw erro_('acao'); }
    if (!req || typeof req !== 'object') throw erro_('acao');
    if (ACOES_QRA[req.acao]) {
      porta_(req);
      return json_(ACOES_QRA[req.acao](req));
    }
    if (ACOES_EQUIPE[req.acao]) return json_(ACOES_EQUIPE[req.acao](req));
    throw erro_('acao');
  } catch (err) {
    if (err && err.qap) return json_({ ok: false, erro: err.qap });
    console.error(err && err.stack || err);
    return json_({ ok: false, erro: 'interno' });
  }
}

// ===== Porta de entrada da tela do QRA =====

function porta_(req) {
  const sis = sistema_();
  if (sis.pausado) throw erro_('pausado');
  if (!ID_VALIDO.test(String(req.p || ''))) throw erro_('link');
  req.aparelho = checarApp_(req, sis);
  limite_(`p_${req.p}`, LIMITE_POSTO, 600);
  if (req.acao === 'evento') limite_(`e_${req.p}`, LIMITE_ENVIOS, 600);
}

// Pedido assinado pelo app oficial: HMAC-SHA256("<ts>.<n>.<acao>.<posto>.<aparelho>") com o
// segredo que vai dentro do app. "n" só vale uma vez (não dá para repetir um pedido copiado).
// Com "Exigir app" desligado, o navegador ainda passa (sem assinatura).
function checarApp_(req, sis) {
  const a = req.app;
  if (!a || typeof a !== 'object') {
    if (!sis.exigirApp) return null;
    registrarSeguranca_('sem_app', { p: req.p });
    throw erro_('sem_app');
  }
  const ts = Number(a.ts), n = String(a.n || ''), disp = String(a.disp || '');
  const certo = /^[A-Za-z0-9_\-]{8,64}$/.test(n) && /^[A-Za-z0-9_\-]{8,64}$/.test(disp) && isFinite(ts)
    && Math.abs(Date.now() - ts) < APP_JANELA_MS
    && String(a.ass || '') === hmac_(`${ts}.${n}.${req.acao}.${req.p}.${disp}`, segredoApp_());
  const cache = CacheService.getScriptCache();
  if (!certo || cache.get(`n_${n}`)) {
    registrarSeguranca_('app_invalido', { p: req.p, disp: disp.slice(0, 64) });
    throw erro_('app_invalido');
  }
  cache.put(`n_${n}`, '1', 21600);
  return { disp, versao: Number(a.v) || 0 };
}

// Conta pedidos numa janela; passou do máximo = recusa (e registra uma vez)
function limite_(chave, max, janelaS) {
  const cache = CacheService.getScriptCache();
  const k = `lim_${chave}`;
  const n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), janelaS);
  if (n > max) {
    if (n === max + 1) registrarSeguranca_('limite', { chave });
    throw erro_('limite');
  }
}

// procedimentos/sistema: { exigirApp, pausado } (só o painel muda, pela ação "sistema")
function sistema_() {
  return doCache_('sistema', 60, () => db_('procedimentos/sistema')) || {};
}

function sistemaConfig_(req) {
  checarEquipe_(req.token);
  const mudar = {};
  ['exigirApp', 'pausado'].forEach(k => { if (typeof req[k] === 'boolean') mudar[k] = req[k]; });
  if (!Object.keys(mudar).length) throw erro_('acao');
  db_('procedimentos/sistema', 'patch', mudar);
  CacheService.getScriptCache().remove('sistema');
  registrarSeguranca_('config', mudar);
  return { ok: true };
}

// Segredo que vai dentro do app (o painel mostra para colar no GitHub). Criado na 1ª vez.
function segredoApp_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('APP_SEGREDO');
  if (!s) {
    s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('APP_SEGREDO', s);
  }
  return s;
}

function segredoAppEquipe_(req) {
  checarEquipe_(req.token);
  return { ok: true, segredo: segredoApp_() };
}

// Chave só do servidor para assinar as sessões dos QRAs. Trocar = todo mundo entra de novo.
function chaveSessao_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('CHAVE_SESSAO');
  if (!s) {
    s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('CHAVE_SESSAO', s);
  }
  return s;
}

// Sessão do QRA: "<qraId>.<posto>.<criada>.<pin>.<assinatura>". O celular não guarda o PIN.
// Cai sozinha em 16 h, quando o PIN é trocado/removido e quando o QRA dá o QTA.
function criarSessao_(qraId, p, pinHash) {
  const base = `${qraId}.${p}.${Date.now()}.${String(pinHash).slice(0, 10)}`;
  return `${base}.${hmac_(base, chaveSessao_())}`;
}

function checarSessao_(req) {
  const partes = String(req.sessao || '').split('.');
  if (partes.length !== 5) throw erro_('sessao');
  const [qraId, p, criada, pin8, ass] = partes;
  if (hmac_(partes.slice(0, 4).join('.'), chaveSessao_()) !== ass || p !== req.p) throw erro_('sessao');
  if (Date.now() - Number(criada) > SESSAO_HORAS * 3600000) throw erro_('sessao');
  const pin = doCache_(`pinh_${qraId}`, 300, () => db_(`procedimentos/pins/${qraId}`));
  if (!pin || String(pin).slice(0, 10) !== pin8) throw erro_('sessao');
  const qta = Number(doCache_(`qta_${qraId}`, 300, () => db_(`procedimentos/qta/${qraId}`)) || 0);
  if (qta > Number(criada)) throw erro_('sessao');
  const q = doCache_(`qra_${qraId}`, 3600, () => db_(`qras/${qraId}`));
  if (!q) throw erro_('sessao');
  return { id: qraId, nome: String(q.name || qraId) };
}

// Print/gravação vistos pelo app (com ou sem QRA logado)
function alertaSeguranca_(req) {
  if (!req.aparelho) throw erro_('sem_app');
  if (ALERTAS_APP.indexOf(req.tipo) < 0) throw erro_('acao');
  checarLink_(req.p, req.k);
  let qra = null;
  try { if (req.sessao) qra = checarSessao_(req); } catch (e) { /* sem sessão: registra só o posto */ }
  registrarSeguranca_(req.tipo, { p: req.p, qraId: qra ? qra.id : '', qraNome: qra ? qra.nome : '', disp: req.aparelho.disp, tela: String(req.tela || '').slice(0, 20) });
  return { ok: true };
}

function alertaSegurancaEquipe_(req) {
  checarEquipe_(req.token);
  if (ALERTAS_APP.indexOf(req.tipo) < 0) throw erro_('acao');
  registrarSeguranca_(req.tipo, { tela: 'painel', qraNome: 'Supervisão' });
  return { ok: true };
}

// procedimentos/seguranca/<dia>/<id>: o painel mostra e avisa. O mesmo aviso no máximo 1x a cada 2 min.
function registrarSeguranca_(tipo, dados) {
  try {
    const cache = CacheService.getScriptCache();
    const k = `log_${sha256_(tipo + JSON.stringify(dados)).slice(0, 24)}`;
    if (cache.get(k)) return;
    cache.put(k, '1', 120);
    db_(`procedimentos/seguranca/${diaOperacional_(new Date())}`, 'post', Object.assign({ tipo, ts: Date.now() }, dados));
  } catch (e) {
    console.error(e);
  }
}

function hmac_(texto, chave) {
  return Utilities.computeHmacSha256Signature(texto, chave, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
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

// Nome + PIN -> sessão assinada (o celular guarda a sessão, nunca o PIN)
function entrar_(req) {
  checarPosto_(req.p, req.k);
  const qra = checarPin_(req.qraId, req.pin, req.p);
  if (req.aparelho) registrarSeguranca_('entrada', { p: req.p, qraId: qra.id, qraNome: qra.nome, disp: req.aparelho.disp });
  return { ok: true, agora: Date.now(), qra: { id: qra.id, nome: qra.nome }, sessao: criarSessao_(qra.id, req.p, qra.pinHash) };
}

function evento_(req) {
  const { post } = checarPosto_(req.p, req.k);
  const qra = checarSessao_(req);
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
  if (req.aparelho) ev.disp = req.aparelho.disp;
  const r = db_(`procedimentos/eventos/${dia}/${req.p}`, 'post', ev);
  const cache = CacheService.getScriptCache();
  cache.remove(`ev_${dia}_${req.p}`);
  // QTA: a sessão deste QRA acaba aqui (o próximo precisa do PIN)
  if (req.tipo === 'passar') {
    db_(`procedimentos/qta/${qra.id}`, 'put', agora);
    cache.remove(`qta_${qra.id}`);
  }
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

// Tela do QRA, aba "Meu turno": os informes dele no turno (até o QTA) com as respostas da
// supervisão. Chamada a cada minuto pelos celulares abertos, por isso tudo vem do cache
// (evento_ e responder_ limpam o cache quando muda algo).
function mensagens_(req) {
  checarLink_(req.p, req.k);
  const qra = checarSessao_(req);
  return { ok: true, agora: Date.now(), informes: informesDoTurno_(req.p, qra.id) };
}

// Áudio de resposta: só se a resposta for para este QRA, num informe do turno dele
function midiaResp_(req) {
  checarLink_(req.p, req.k);
  const qra = checarSessao_(req);
  const id = String(req.id || '');
  const dele = informesDoTurno_(req.p, qra.id).some(i => i.msgs.some(m => m.midia && m.midia.id === id));
  if (!dele) throw erro_('midia');
  const blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
}

// Link do posto com cache de 5 min (para as chamadas de minuto em minuto)
function checarLink_(p, k) {
  if (!ID_VALIDO.test(String(p || '')) || !k) throw erro_('link');
  const cfg = doCache_(`cfg_${p}`, 300, () => db_(`procedimentos/config/${p}`));
  if (!cfg || !cfg.chave || cfg.chave !== String(k)) throw erro_('link');
}

// Informes do QRA neste posto nas últimas 24 h, só depois do último "passar" (QTA) dele.
// Volta do mais novo para o mais antigo, sem a mídia (só o tipo e a duração).
function informesDoTurno_(p, qraId) {
  const hoje = diaOperacional_(new Date());
  const limite = Date.now() - 24 * 3600000;
  let lista = [];
  [ontem_(hoje), hoje].forEach(dia => {
    const evs = doCache_(`ev_${dia}_${p}`, 600, () => db_(`procedimentos/eventos/${dia}/${p}`)) || {};
    const resp = doCache_(`resp_${dia}_${p}`, 600, () => db_(`procedimentos/respostas/${dia}/${p}`)) || {};
    Object.keys(evs).forEach(id => {
      const ev = evs[id];
      if (!ev || ev.qraId !== qraId || ev.ts < limite) return;
      const r = resp[id] || {};
      lista.push({
        id, dia, tipo: ev.tipo, ts: ev.ts, texto: ev.texto || '',
        midia: (ev.midia || []).map(m => ({ tipo: m.tipo, seg: m.seg || 0 })),
        curtida: r.curtida || null,
        msgs: Object.keys(r.msgs || {}).map(k => r.msgs[k]).sort((a, b) => a.ts - b.ts),
      });
    });
  });
  lista.sort((a, b) => a.ts - b.ts);
  const qta = lista.map(i => i.tipo).lastIndexOf('passar');
  if (qta >= 0) lista = lista.slice(qta + 1);
  return lista.reverse();
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
  checarLink_(req.p, req.k);
  checarSessao_(req);
  return { ok: true, inv: db_(`procedimentos/inventario/${req.p}`) || {} };
}

// O QRA manda a lista inteira (tipo + objetos); o que mudou vai para o histórico com o nome dele
function inventarioSalvar_(req) {
  checarLink_(req.p, req.k);
  const qra = checarSessao_(req);
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
  checarLink_(req.p, req.k);
  const qra = checarSessao_(req);
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

// PIN de 4 dígitos guardado como SHA-256 de "<qraId>:<pin>". 5 erros = QRA bloqueado 15 min;
// 20 erros no mesmo posto (tentando vários QRAs) = posto bloqueado 15 min. Bloqueio vai para o painel.
function checarPin_(qraId, pin, p) {
  if (!ID_VALIDO.test(String(qraId || ''))) throw erro_('pin');
  const cache = CacheService.getScriptCache();
  const chaveCache = 'pin_' + qraId;
  const chavePosto = 'pinp_' + p;
  const erros = Number(cache.get(chaveCache) || 0);
  const errosPosto = Number(cache.get(chavePosto) || 0);
  if (erros >= PIN_TENTATIVAS || errosPosto >= POSTO_PIN_ERROS) throw erro_('bloqueado');
  const guardado = db_(`procedimentos/pins/${qraId}`);
  if (!guardado) throw erro_('sem_pin');
  if (!/^\d{4}$/.test(String(pin || '')) || sha256_(`${qraId}:${pin}`) !== guardado) {
    cache.put(chaveCache, String(erros + 1), PIN_BLOQUEIO_S);
    cache.put(chavePosto, String(errosPosto + 1), PIN_BLOQUEIO_S);
    if (erros + 1 === PIN_TENTATIVAS) registrarSeguranca_('pin_bloqueado', { p, qraId });
    if (errosPosto + 1 === POSTO_PIN_ERROS) registrarSeguranca_('posto_bloqueado', { p });
    throw erro_('pin');
  }
  cache.remove(chaveCache);
  const q = db_(`qras/${qraId}`);
  if (!q) throw erro_('pin');
  return { id: qraId, nome: String(q.name || qraId), pinHash: guardado };
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
