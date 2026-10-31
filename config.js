// ============================================================
// Front Security - App QAP: configuração (vale para o painel e para a tela do QRA)
// ============================================================

const QAP_CONFIG = {
  // URL do backend: Apps Script > Implantar > App da Web > "URL do app da Web" (termina em /exec).
  // Ver LEIAME.md, seção "Backend no Google Apps Script". Vazio = o app avisa que falta configurar.
  apiUrl: 'https://script.google.com/macros/s/AKfycbzAN2u52ppNYBn8DjcCnDAkznmCqcvdprj-TuP1t9LV-3GiYxNs_t61wYX_KWmDMfQIVw/exec',
  // Mesmo banco do Coberturas e do Pagamentos (postos, QRAs e escala já estão lá)
  firebase: {
    apiKey: 'AIzaSyB2XpLy5atMeLtc-XuOaAtY9m72mK9dZSY',
    authDomain: 'front-security-coberturas.firebaseapp.com',
    databaseURL: 'https://front-security-coberturas-default-rtdb.firebaseio.com',
    projectId: 'front-security-coberturas',
    storageBucket: 'front-security-coberturas.firebasestorage.app',
    messagingSenderId: '820793276708',
    appId: '1:820793276708:web:869d32754c6375cd139bb1'
  }
};

// Teste local (?mock=1): backend e banco falsos de teste/mock_server.py, câmera e microfone
// simulados quando o aparelho não tem. Nunca toca no Firebase nem no Drive de verdade.
const QAP_MOCK = new URLSearchParams(location.search).has('mock')
  && ['localhost', '127.0.0.1'].includes(location.hostname);
if (QAP_MOCK) QAP_CONFIG.apiUrl = '/mock/api';

const QAP_ERROS = {
  link: 'Link do posto inválido ou trocado. Peça o link novo à supervisão.',
  pin: 'PIN incorreto.',
  sem_pin: 'Você ainda não tem PIN. Peça à supervisão para cadastrar.',
  bloqueado: 'Muitas tentativas erradas. Aguarde 15 minutos.',
  sem_imagem: 'Este envio precisa de foto ou vídeo.',
  midia: 'Arquivo de mídia inválido.',
  longo: 'Vídeo ou áudio passou de 15 segundos.',
  grande: 'Arquivo grande demais.',
  tipo: 'Tipo de envio inválido.',
  equipe: 'Sessão da equipe expirou. Entre de novo.',
  interno: 'Erro no servidor. Tente de novo em instantes.',
  config: 'App sem backend configurado (config.js).',
  rede: 'Sem internet.',
  inventario: 'Lista de objetos inválida. Confira as quantidades.',
  checkup: 'A lista de objetos mudou enquanto você conferia. Abra o check-up de novo.',
  acao: 'Função nova ainda não liberada no servidor. Avise a supervisão.',
  resposta: 'Não deu para responder este informe.',
  sessao: 'Sua sessão terminou. Entre de novo com o seu PIN.',
  sem_app: 'Este posto agora só funciona pelo app Front Security QAP.',
  app_invalido: 'App desatualizado ou alterado. Baixe o app de novo pelo link da supervisão.',
  limite: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.',
  pausado: 'O sistema foi pausado pela supervisão. Aguarde ou ligue para a supervisão.',
};

// Objetos de valor do QTH. Tipo do posto -> categorias (as chaves são iguais às do Code.gs).
const INV_TIPOS = {
  stand: { nome: 'Stand', icone: '🏠', categorias: { copa: 'Copa', decorado: 'Decorado', salao: 'Salão', area_externa: 'Área externa' } },
  terreno: { nome: 'Terreno', icone: '🚧', categorias: { terreno: 'Terreno' } }, // terreno não tem subcategoria
};
// Lista pronta para escolher (o QRA também pode digitar outro)
const INV_OBJETOS = [
  'Mesa', 'Cadeira', 'Geladeira', 'Micro-ondas', 'Máquina de café', 'Monitor', 'Computador', 'Teclado', 'Mouse',
  'Cadeira de escritório', 'Holofote', 'Luminária', 'Spot de luz', 'Tablet', 'Book do empreendimento', 'TV',
  'Filtro de água', 'Biruta', 'Almofada', 'Carrinho de mão', 'Maçarico', 'Cadeado',
];

// "Máquina de café" -> "maquina_de_cafe" (chave do objeto no banco)
function invChave(nome) {
  return String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function invNomeCategoria(tipo, cat) {
  return ((INV_TIPOS[tipo] || {}).categorias || {})[cat] || cat;
}

// ===== App instalado (Android) =====
// Dentro do app, o plugin nativo "Seguranca" bloqueia print/gravação (FLAG_SECURE), avisa quando
// alguém tenta e assina cada pedido com o segredo do app. No navegador nada disso existe.
const QAP_APK_URL = 'https://github.com/DanielSchiavolin/qap-app/releases/latest/download/front-security-qap.apk';
const QAP_NATIVO = (() => {
  try { return !!(window.Capacitor && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.Seguranca); } catch (e) { return false; }
})();
// Teste local (?mock=1&app=1): finge ser o app, assinando com o segredo do mock_server.py
const QAP_APP_FALSO = QAP_MOCK && new URLSearchParams(location.search).get('app') === '1';
let qapOffsetRelogio = 0; // relógio do servidor - relógio do celular (a tela do QRA atualiza)

async function hmacHex(chave, texto) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(chave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Assinatura do pedido: o servidor confere "<ts>.<n>.<acao>.<posto>.<aparelho>"
async function assinarApp(body) {
  const ts = Date.now() + qapOffsetRelogio;
  if (QAP_NATIVO) return Capacitor.Plugins.Seguranca.assinar({ acao: body.acao, p: body.p || '', ts });
  if (!QAP_APP_FALSO) return null;
  let disp = '';
  try { disp = localStorage.getItem('qapDispFalso') || ''; } catch (e) {}
  if (!disp) { disp = `falso_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; try { localStorage.setItem('qapDispFalso', disp); } catch (e) {} }
  const n = crypto.randomUUID().replace(/-/g, '');
  return { ts, n, disp, v: 1, ass: await hmacHex('segredo-de-teste', `${ts}.${n}.${body.acao}.${body.p || ''}.${disp}`) };
}

// Avisos de print/gravação vindos do app (ou simulados no teste: qapSimularPrint())
function qapOuvirSeguranca(cb) {
  if (QAP_NATIVO) {
    Capacitor.Plugins.Seguranca.addListener('print', () => cb('print', {}));
    Capacitor.Plugins.Seguranca.addListener('gravacao', d => cb('gravacao', d || {}));
  } else if (QAP_APP_FALSO) {
    window.qapSimularPrint = () => cb('print', {});
    window.qapSimularGravacao = gravando => cb('gravacao', { gravando });
  }
}

// Chamada ao backend. JSON como text/plain: o Apps Script não responde ao "preflight" de CORS.
// Dentro do app, cada pedido sai assinado (na hora do envio, também para o que estava na fila).
async function qapApi(body) {
  if (!QAP_CONFIG.apiUrl) throw Object.assign(new Error('config'), { codigo: 'config' });
  let res;
  try {
    const app = await assinarApp(body);
    if (app) body = Object.assign({}, body, { app });
  } catch (e) {
    throw Object.assign(new Error('app_invalido'), { codigo: 'app_invalido' });
  }
  try {
    res = await fetch(QAP_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
  } catch (e) {
    throw Object.assign(new Error('rede'), { codigo: 'rede' });
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* resposta não-JSON = erro do servidor */ }
  if (!data) throw Object.assign(new Error('interno'), { codigo: 'interno' });
  if (!data.ok) throw Object.assign(new Error(data.erro || 'interno'), { codigo: data.erro || 'interno' });
  return data;
}

function qapErroTexto(err) {
  return QAP_ERROS[err && err.codigo] || QAP_ERROS.interno;
}

// SHA-256 em hex (PIN guardado como sha256("<qraId>:<pin>"), igual ao Code.gs)
async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function horaCurta(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dataHora(ms) {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${horaCurta(ms)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// Versão nova publicada: baixa os arquivos de novo (sem a cópia guardada do navegador) e recarrega.
// Só tenta uma vez a cada 2 min por versão, para nunca ficar recarregando sem parar.
// Devolve false quando já tentou há pouco.
function recarregarParaVersao(v, arquivos) {
  const chave = 'qapRecarregou';
  try {
    const ultima = JSON.parse(sessionStorage.getItem(chave) || 'null');
    if (ultima && ultima.v === v && Date.now() - ultima.em < 120000) return false;
    sessionStorage.setItem(chave, JSON.stringify({ v, em: Date.now() }));
  } catch (e) { /* sem sessionStorage: segue */ }
  Promise.all(arquivos.map(f => fetch(f, { cache: 'reload' }).catch(() => null)))
    .then(() => setTimeout(() => location.reload(), 800));
  return true;
}

// ===== Microfone e gravação (tela do QRA e painel) =====

const MAX_SEG_MIDIA = 15; // vídeo e áudio: no máximo 15 s

function escolherMime(opcoes) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return opcoes.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

async function abrirMicrofone() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (e) {
    if (QAP_MOCK) return microfoneFalso();
    throw e;
  }
}

// Só no teste local (?mock=1) quando o aparelho não tem microfone
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
        const seg = Math.min(MAX_SEG_MIDIA, (Date.now() - this.inicio) / 1000);
        res({ blob: new Blob(this.chunks, { type: (this.rec.mimeType || mime || '').split(';')[0] }), seg });
      };
    });
    this.inicio = Date.now();
    this.rec.start(1000);
    onTick(MAX_SEG_MIDIA);
    this.timer = setInterval(() => {
      const resta = MAX_SEG_MIDIA - Math.floor((Date.now() - this.inicio) / 1000);
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
