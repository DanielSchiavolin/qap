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

// Chamada ao backend. JSON como text/plain: o Apps Script não responde ao "preflight" de CORS.
async function qapApi(body) {
  if (!QAP_CONFIG.apiUrl) throw Object.assign(new Error('config'), { codigo: 'config' });
  let res;
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
