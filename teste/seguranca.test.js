// Testa as camadas de segurança do apps-script/Code.gs com Google e Firebase de mentira.
// Uso: node teste/seguranca.test.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function montar() {
  const banco = {
    procedimentos: {
      config: { teste_24h: { chave: 'teste123', ativo: true } },
      pins: { teste_joao: crypto.createHash('sha256').update('teste_joao:1234').digest('hex') },
      sistema: {},
    },
    posts: { teste_24h: { name: 'Teste 24h' } },
    qras: { teste_joao: { name: 'João Teste' } },
  };
  const pegar = c => c.split('/').filter(Boolean).reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), banco);
  const gravar = (c, v) => {
    const partes = c.split('/').filter(Boolean);
    let n = banco;
    partes.slice(0, -1).forEach(k => { n[k] = n[k] && typeof n[k] === 'object' ? n[k] : {}; n = n[k]; });
    if (v === null) delete n[partes[partes.length - 1]]; else n[partes[partes.length - 1]] = v;
  };
  const cache = new Map();
  const props = new Map();
  const bytes = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  let pushes = 0;
  const ctx = vm.createContext({
    console,
    Utilities: {
      computeHmacSha256Signature: (t, k) => bytes(crypto.createHmac('sha256', k).update(t).digest()),
      computeDigest: (a, s) => bytes(crypto.createHash('sha256').update(s).digest()),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => {
        const x = new Date(d.getTime() - 3 * 3600e3), p = n => String(n).padStart(2, '0');
        return f === 'H' ? String(x.getUTCHours()) : `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`;
      },
    },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
    ContentService: { createTextOutput: t => ({ setMimeType: () => JSON.parse(t) }), MimeType: { JSON: 1 } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  // relógio do servidor adiantável pelo teste (ctx.__desvio em ms)
  vm.runInContext('(() => { const r = Date.now; Date.now = () => r() + (globalThis.__desvio || 0); })()', ctx);
  // Firebase e Drive de mentira
  ctx.db_ = (c, metodo, corpo) => {
    if (!metodo || metodo === 'get') return pegar(c) === undefined ? null : JSON.parse(JSON.stringify(pegar(c)));
    if (metodo === 'post') { const id = `x${++pushes}`; gravar(`${c}/${id}`, corpo); return { name: id }; }
    if (metodo === 'patch') { gravar(c, Object.assign({}, pegar(c) || {}, corpo)); return corpo; }
    if (metodo === 'delete') { gravar(c, null); return null; }
    gravar(c, corpo); return corpo;
  };
  ctx.pastaDoDia_ = () => ({});
  ctx.ultimoQap_ = () => null;
  const chamar = req => ctx.doPost({ postData: { contents: JSON.stringify(req), length: 100 } });
  const assinar = (req, extra) => {
    const segredo = ctx.segredoApp_();
    const a = Object.assign({ ts: Date.now(), n: crypto.randomUUID().replace(/-/g, ''), disp: 'aparelho_teste_01', v: 1 }, extra);
    a.ass = crypto.createHmac('sha256', segredo).update(`${a.ts}.${a.n}.${req.acao}.${req.p}.${a.disp}`).digest('hex');
    return Object.assign({}, req, { app: a });
  };
  return { banco, chamar, assinar, ctx, cache };
}

let falhas = 0;
function caso(nome, cond) {
  console.log(`${cond ? 'ok  ' : 'FALHOU'}  ${nome}`);
  if (!cond) falhas++;
}

const t = montar();
const base = { p: 'teste_24h', k: 'teste123' };

// navegador sem app, "Exigir app" desligado: passa
let r = t.chamar(Object.assign({ acao: 'entrar', qraId: 'teste_joao', pin: '1234' }, base));
caso('entrar devolve sessão e não precisa do app com Exigir app desligado', r.ok && /^teste_joao\.teste_24h\./.test(r.sessao));
const sessao = r.sessao;
caso('PIN não vai na resposta', !JSON.stringify(r).includes('1234'));
caso('sessão não leva pedaço do hash do PIN (daria para achar o PIN)', !sessao.includes(t.banco.procedimentos.pins.teste_joao.slice(0, 8)));
const criada = Number(sessao.split('.')[2]);

r = t.chamar(Object.assign({ acao: 'mensagens', sessao }, base));
caso('sessão vale para as outras ações', r.ok && Array.isArray(r.informes));
r = t.chamar(Object.assign({ acao: 'mensagens', sessao: sessao.replace(/.$/, c => (c === 'a' ? 'b' : 'a')) }, base));
caso('sessão adulterada é recusada', r.erro === 'sessao');
r = t.chamar(Object.assign({ acao: 'mensagens', sessao }, base, { p: 'outro_posto' }));
caso('sessão de um posto não vale em outro', r.erro === 'link' || r.erro === 'sessao');

// Exigir app ligado
t.banco.procedimentos.sistema.exigirApp = true;
t.cache.delete('sistema');
r = t.chamar(Object.assign({ acao: 'mensagens', sessao }, base));
caso('Exigir app: navegador recebe sem_app', r.erro === 'sem_app');
caso('Exigir app: tentativa pelo navegador vai para o registro', JSON.stringify(t.banco.procedimentos.seguranca || {}).includes('sem_app'));
const assinado = t.assinar(Object.assign({ acao: 'mensagens', sessao }, base));
r = t.chamar(assinado);
caso('Exigir app: app assinado passa', r.ok);
r = t.chamar(assinado);
caso('mesmo pedido repetido (replay) é recusado', r.erro === 'app_invalido');
r = t.chamar(t.assinar(Object.assign({ acao: 'mensagens', sessao }, base), { ts: Date.now() - 7 * 3600e3 }));
caso('assinatura velha (7 h) é recusada', r.erro === 'app_invalido');
const errada = t.assinar(Object.assign({ acao: 'mensagens', sessao }, base));
errada.acao = 'inventario';
r = t.chamar(errada);
caso('assinatura de outra ação é recusada', r.erro === 'app_invalido');

// QTA encerra a sessão
r = t.chamar(t.assinar(Object.assign({ acao: 'evento', sessao, tipo: 'passar', texto: 'QTA' }, base)));
caso('QTA (passar) enviado', r.ok);
r = t.chamar(t.assinar(Object.assign({ acao: 'mensagens', sessao }, base)));
caso('depois do QTA a sessão antiga não vale mais', r.erro === 'sessao');
r = t.chamar(t.assinar(Object.assign({ acao: 'evento', sessao, tipo: 'ronda', capturadoEm: criada + 1 }, base)));
caso('ronda capturada antes do QTA (fila offline) ainda entra com a sessão antiga', r.ok);
r = t.chamar(t.assinar(Object.assign({ acao: 'evento', sessao, tipo: 'ronda', capturadoEm: Date.now() + 1000 }, base)));
caso('envio capturado depois do QTA é recusado', r.erro === 'sessao');

// PIN errado: bloqueio do QRA e do posto
for (let i = 0; i < 5; i++) t.chamar(t.assinar(Object.assign({ acao: 'entrar', qraId: 'teste_joao', pin: '0000' }, base)));
r = t.chamar(t.assinar(Object.assign({ acao: 'entrar', qraId: 'teste_joao', pin: '1234' }, base)));
caso('5 PINs errados bloqueiam o QRA (nem o certo entra)', r.erro === 'bloqueado');
caso('bloqueio de PIN vai para o registro', JSON.stringify(t.banco.procedimentos.seguranca).includes('pin_bloqueado'));

// 20 PINs errados num aparelho (espalhados em vários QRAs) travam só esse aparelho no posto
for (let i = 1; i <= 6; i++) {
  t.banco.qras[`q${i}`] = { name: `QRA ${i}` };
  t.banco.procedimentos.pins[`q${i}`] = crypto.createHash('sha256').update(`q${i}:4321`).digest('hex');
}
for (let i = 0; i < 20; i++) t.chamar(t.assinar(Object.assign({ acao: 'entrar', qraId: `q${(i % 5) + 1}`, pin: '0000' }, base), { disp: 'atacante_0001' }));
r = t.chamar(t.assinar(Object.assign({ acao: 'entrar', qraId: 'q6', pin: '4321' }, base), { disp: 'atacante_0001' }));
caso('20 PINs errados no mesmo aparelho travam esse aparelho', r.erro === 'bloqueado');
caso('trava do aparelho vai para o registro', JSON.stringify(t.banco.procedimentos.seguranca).includes('posto_bloqueado'));
r = t.chamar(t.assinar(Object.assign({ acao: 'entrar', qraId: 'q6', pin: '4321' }, base), { disp: 'honesto_00001' }));
caso('outro celular do posto continua entrando com o PIN certo', r.ok);

// alerta de print vindo do app
r = t.chamar(t.assinar(Object.assign({ acao: 'alerta_seguranca', tipo: 'print', tela: 'qap' }, base)));
caso('alerta de print do app é registrado', r.ok && JSON.stringify(t.banco.procedimentos.seguranca).includes('"print"'));

// pausar tudo
t.banco.procedimentos.sistema.pausado = true;
t.cache.delete('sistema');
r = t.chamar(t.assinar(Object.assign({ acao: 'posto' }, base)));
caso('Pausar tudo recusa a tela do QRA', r.erro === 'pausado');

// limite de pedidos
t.banco.procedimentos.sistema.pausado = false;
t.cache.delete('sistema');
// começa 1 s depois do início de uma janela de 10 min (o teste não cai na virada)
const agoraReal = Date.now();
t.ctx.__desvio = Math.ceil(agoraReal / 600000) * 600000 + 1000 - agoraReal;
let ultimo;
for (let i = 0; i < 310; i++) ultimo = t.chamar(t.assinar(Object.assign({ acao: 'mensagens', sessao: 'x' }, base)));
caso('passou de 300 pedidos em 10 min no posto: limite', ultimo.erro === 'limite');
t.ctx.__desvio += 600000;
r = t.chamar(t.assinar(Object.assign({ acao: 'mensagens', sessao: 'x' }, base)));
caso('na janela seguinte o posto volta a funcionar (mesmo sem parar de pedir)', r.erro !== 'limite');
t.ctx.__desvio = 0;

// pedido gigante e lixo
r = t.ctx.doPost({ postData: { contents: '{}', length: 50 * 1024 * 1024 } });
caso('pedido maior que 45 MB é recusado sem ler', r.erro === 'grande');
r = t.ctx.doPost({ postData: { contents: 'isso não é json', length: 10 } });
caso('lixo no corpo é recusado', r.erro === 'acao');
r = t.chamar({ acao: 'sistema', exigirApp: false });
caso('ação do painel sem login da equipe é recusada', r.erro === 'equipe');

console.log(falhas ? `\n${falhas} caso(s) falharam` : '\nTodos os casos passaram');
process.exit(falhas ? 1 : 0);
