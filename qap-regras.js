// ============================================================
// Front Security - App QAP: regras do QAP (puras, sem DOM; testadas em teste/regras.test.js)
// Mesma conta do ../Limpar_WhatsApp/financeiro/falhas_qap.ps1: QAP a cada `intervaloMin`,
// tolerância de `toleranciaMin`, cada hora inteira sem QAP = 1h de falha, 3/6 = 1h de pausa.
// Depende de escala.js (shiftWindow, Schedule, addDays, toDateStr...).
// ============================================================

const QAP_PADRAO = { ativo: false, intervaloMin: 60, toleranciaMin: 15, pausaMin: 60 };
const QAP_AVISO_MIN = 10; // card fica amarelo quando faltam 10 min para o próximo QAP

const QAP_TIPOS = {
  qti: { icone: '📻', nome: 'QTI (a caminho)' },
  assumir: { icone: '✅', nome: 'Assumiu o posto' },
  qap: { icone: '📸', nome: 'QAP' },
  ronda: { icone: '🔦', nome: 'Ronda' },
  pausa_ini: { icone: '🍽️', nome: 'Saída para o 3/6' },
  pausa_fim: { icone: '↩️', nome: 'Volta do 3/6' },
  passar: { icone: '🔄', nome: 'Passou o posto' },
  qru: { icone: '🚨', nome: 'Ocorrência (QRU)' },
};

function qapConfig(cfg) {
  return Object.assign({}, QAP_PADRAO, cfg || {});
}

// Dia operacional de um instante: antes das 07:00 ainda é a noite do dia anterior
function diaOperacional(ms) {
  const d = new Date(ms);
  if (d.getHours() * 60 + d.getMinutes() < DAY_START) d.setDate(d.getDate() - 1);
  return toDateStr(d);
}

// Foto ou vídeo ao vivo = QAP. A volta do 3/6 também reinicia a contagem.
function temImagem(ev) {
  return (ev.midia || []).some(m => m.tipo === 'foto' || m.tipo === 'video');
}
function contaComoQap(ev) {
  return temImagem(ev) || ev.tipo === 'pausa_fim';
}

// Turno do posto que contém o instante (null = posto fora de turno). Híbrido seg–sex: a noite
// começa 17:00 e se sobrepõe ao fim do diurno; nesse caso vale a noite.
function turnoDoPosto(sched, post, ms) {
  const hoje = diaOperacional(ms);
  const candidatos = [
    { date: hoje, shift: 'noturno' },
    { date: hoje, shift: 'diurno' },
    { date: addDays(hoje, -1), shift: 'noturno' },
  ];
  for (const c of candidatos) {
    if (!sched.postWorks(post, c.date, c.shift)) continue;
    const w = shiftWindow(post, c.date, c.shift);
    if (ms >= w.start.getTime() && ms < w.end.getTime()) {
      return { date: c.date, shift: c.shift, inicio: w.start.getTime(), fim: w.end.getTime() };
    }
  }
  return null;
}

// Buracos sem QAP entre `inicio` e `ate` (mesma regra do fechamento). eventos em ordem de ts.
function falhasQap(eventos, inicio, ate, cfg) {
  const c = qapConfig(cfg);
  const pontos = [{ ts: inicio, pausa: false }];
  eventos.forEach(ev => {
    if (ev.ts < inicio || ev.ts > ate) return;
    if (ev.tipo === 'pausa_ini') pontos.push({ ts: ev.ts, pausa: true });
    else if (contaComoQap(ev)) pontos.push({ ts: ev.ts, pausa: false });
  });
  pontos.push({ ts: ate, pausa: false });
  const buracos = [];
  for (let i = 1; i < pontos.length; i++) {
    const min = Math.floor((pontos[i].ts - pontos[i - 1].ts) / 60000) - (pontos[i - 1].pausa ? c.pausaMin : 0);
    if (min <= c.intervaloMin + c.toleranciaMin) continue;
    buracos.push({ desde: pontos[i - 1].ts, ate: pontos[i].ts, min, horas: Math.floor((min - c.toleranciaMin) / c.intervaloMin) });
  }
  return { buracos, horas: buracos.reduce((s, b) => s + b.horas, 0) };
}

// Situação do QAP de um posto agora.
// situacao: fora (sem turno) · desligado (não cobra) · ok · vence (≤10 min) · atrasado ·
//           pausa (em 3/6) · pausa_longa (3/6 passou do limite)
function estadoQap(sched, post, cfgBruta, eventosPosto, agora) {
  const cfg = qapConfig(cfgBruta);
  const evs = (eventosPosto || []).slice().sort((a, b) => a.ts - b.ts);
  const turno = turnoDoPosto(sched, post, agora);
  const ultimo = evs.filter(e => e.ts <= agora).pop() || null;
  const ultimoQap = evs.filter(e => e.ts <= agora && contaComoQap(e)).pop() || null;
  const base = { turno, ultimo, ultimoQap, proximoAte: null, atrasoMin: 0, horasFalha: 0, cfg };
  if (!turno) return Object.assign(base, { situacao: 'fora' });
  if (!cfg.ativo || !(cfg.intervaloMin > 0)) return Object.assign(base, { situacao: 'desligado' });

  const doTurno = evs.filter(e => e.ts >= turno.inicio && e.ts <= agora);
  base.horasFalha = falhasQap(doTurno, turno.inicio, agora, cfg).horas;

  // em 3/6: saída sem volta (nem QAP) depois dela
  const iniPausa = doTurno.filter(e => e.tipo === 'pausa_ini').pop();
  if (iniPausa && !doTurno.some(e => e.ts > iniPausa.ts && contaComoQap(e))) {
    const volta = iniPausa.ts + cfg.pausaMin * 60000;
    base.proximoAte = volta;
    if (agora > volta + cfg.toleranciaMin * 60000) {
      return Object.assign(base, { situacao: 'pausa_longa', atrasoMin: Math.floor((agora - volta) / 60000) });
    }
    return Object.assign(base, { situacao: 'pausa' });
  }

  const desde = Math.max(turno.inicio, ultimoQap && ultimoQap.ts >= turno.inicio ? ultimoQap.ts : 0);
  const proximo = desde + cfg.intervaloMin * 60000;
  base.proximoAte = proximo;
  if (proximo >= turno.fim) return Object.assign(base, { situacao: 'ok' });
  if (agora > proximo + cfg.toleranciaMin * 60000) {
    return Object.assign(base, { situacao: 'atrasado', atrasoMin: Math.floor((agora - proximo) / 60000) });
  }
  if (agora > proximo - QAP_AVISO_MIN * 60000) return Object.assign(base, { situacao: 'vence' });
  return Object.assign(base, { situacao: 'ok' });
}

// Eventos de um posto vindos de eventos/<dia>/<postId>/<id> (vários dias) em lista com id
function eventosDoPosto(eventosPorDia, postId) {
  const out = [];
  Object.keys(eventosPorDia || {}).forEach(dia => {
    const doPosto = (eventosPorDia[dia] || {})[postId] || {};
    Object.keys(doPosto).forEach(id => out.push(Object.assign({ id, dia }, doPosto[id])));
  });
  return out.sort((a, b) => a.ts - b.ts);
}

if (typeof module !== 'undefined') {
  module.exports = { QAP_PADRAO, QAP_TIPOS, qapConfig, diaOperacional, contaComoQap, temImagem, turnoDoPosto, falhasQap, estadoQap, eventosDoPosto };
}
