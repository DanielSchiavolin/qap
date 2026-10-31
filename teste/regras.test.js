// Testes das regras do QAP. Rodar: node teste/regras.test.js (o fuso é fixado em São Paulo)
process.env.TZ = 'America/Sao_Paulo';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = vm.createContext({ console });
['escala.js', 'qap-regras.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }));
const R = vm.runInContext('({ Schedule, estadoQap, falhasQap, turnoDoPosto, diaOperacional })', ctx);

const sched = new R.Schedule();
const posts = {
  mascote: { id: 'mascote', name: 'Mascote', category: 'Segurança Econ', escalaType: 'noturno', days: [0, 1, 2, 3, 4, 5, 6] },
  patriarca: { id: 'patriarca', name: 'Patriarca', category: 'Segurança Econ', escalaType: 'hibrido', days: [0, 1, 2, 3, 4, 5, 6], hibridoSchedule: ['24h', 'noturno', 'noturno', 'noturno', 'noturno', 'noturno', '24h'] },
  loja: { id: 'loja', name: 'Loja', category: 'Segurança Nurban', escalaType: 'diurno', days: [0, 1, 2, 3, 4, 5, 6] },
  augusta: { id: 'augusta', name: 'Augusta', category: 'Segurança Kallas', escalaType: '24h', days: [0, 1, 2, 3, 4, 5, 6], startDate: '2026-11-10' },
};
sched.posts = posts;
const ON = { ativo: true };
const t = s => new Date(s).getTime(); // '2026-11-03T20:00' = hora local de São Paulo
const foto = (s, tipo = 'qap') => ({ tipo, ts: t(s), midia: [{ tipo: 'foto' }] });
let n = 0;
function caso(nome, fn) { fn(); n++; console.log('ok -', nome); }

caso('noturno: sem QAP às 19:30 está ok, às 19:55 vence, às 20:16 atrasado 16 min', () => {
  assert.strictEqual(R.estadoQap(sched, posts.mascote, ON, [], t('2026-11-03T19:30')).situacao, 'ok');
  assert.strictEqual(R.estadoQap(sched, posts.mascote, ON, [], t('2026-11-03T19:55')).situacao, 'vence');
  const e = R.estadoQap(sched, posts.mascote, ON, [], t('2026-11-03T20:16'));
  assert.strictEqual(e.situacao, 'atrasado');
  assert.strictEqual(e.atrasoMin, 16);
});

caso('dentro da tolerância (20:15) ainda não é atraso', () => {
  assert.strictEqual(R.estadoQap(sched, posts.mascote, ON, [], t('2026-11-03T20:15')).situacao, 'vence');
});

caso('QAP com foto às 20:05 empurra o próximo para 21:05', () => {
  const e = R.estadoQap(sched, posts.mascote, ON, [foto('2026-11-03T20:05')], t('2026-11-03T21:00'));
  assert.strictEqual(e.situacao, 'vence');
  assert.strictEqual(e.proximoAte, t('2026-11-03T21:05'));
  assert.strictEqual(R.estadoQap(sched, posts.mascote, ON, [foto('2026-11-03T20:05')], t('2026-11-03T21:21')).situacao, 'atrasado');
});

caso('mensagem sem foto/vídeo não conta como QAP', () => {
  const e = R.estadoQap(sched, posts.mascote, ON, [{ tipo: 'qap', ts: t('2026-11-03T20:05'), midia: [{ tipo: 'audio' }] }], t('2026-11-03T20:30'));
  assert.strictEqual(e.situacao, 'atrasado');
});

caso('3/6: em pausa até 1h; passou de 1h + tolerância = pausa_longa; a volta reinicia', () => {
  const evs = [foto('2026-11-03T22:40'), { tipo: 'pausa_ini', ts: t('2026-11-03T22:50') }];
  assert.strictEqual(R.estadoQap(sched, posts.mascote, ON, evs, t('2026-11-03T23:40')).situacao, 'pausa');
  const longa = R.estadoQap(sched, posts.mascote, ON, evs, t('2026-11-04T00:10'));
  assert.strictEqual(longa.situacao, 'pausa_longa');
  assert.strictEqual(longa.atrasoMin, 20);
  const voltou = evs.concat({ tipo: 'pausa_fim', ts: t('2026-11-03T23:55') });
  const e = R.estadoQap(sched, posts.mascote, ON, voltou, t('2026-11-04T00:10'));
  assert.strictEqual(e.situacao, 'ok');
  assert.strictEqual(e.proximoAte, t('2026-11-04T00:55'));
});

caso('a noite das 03:00 pertence ao dia anterior', () => {
  assert.strictEqual(R.diaOperacional(t('2026-11-04T03:00')), '2026-11-03');
  const turno = R.turnoDoPosto(sched, posts.mascote, t('2026-11-04T03:00'));
  assert.strictEqual(turno.date, '2026-11-03');
  assert.strictEqual(turno.shift, 'noturno');
});

caso('híbrido seg–sex: às 17:30 de segunda já é o noturno (começa 17:00)', () => {
  const turno = R.turnoDoPosto(sched, posts.patriarca, t('2026-11-02T17:30'));
  assert.strictEqual(turno.shift, 'noturno');
  assert.strictEqual(turno.inicio, t('2026-11-02T17:00'));
  assert.strictEqual(R.turnoDoPosto(sched, posts.patriarca, t('2026-11-02T12:00')), null); // segunda não tem diurno
});

caso('posto só diurno às 20:00 está fora de turno; posto que ainda não abriu também', () => {
  assert.strictEqual(R.estadoQap(sched, posts.loja, ON, [], t('2026-11-03T20:00')).situacao, 'fora');
  assert.strictEqual(R.estadoQap(sched, posts.augusta, ON, [], t('2026-11-03T10:00')).situacao, 'fora');
  assert.strictEqual(R.estadoQap(sched, posts.augusta, ON, [], t('2026-11-10T07:30')).situacao, 'ok');
});

caso('posto com cobrança desligada não alerta', () => {
  assert.strictEqual(R.estadoQap(sched, posts.mascote, { ativo: false }, [], t('2026-11-03T23:00')).situacao, 'desligado');
});

caso('perto do fim do turno não cobra QAP que venceria depois das 07:00', () => {
  assert.strictEqual(R.estadoQap(sched, posts.mascote, ON, [foto('2026-11-04T06:10')], t('2026-11-04T06:59')).situacao, 'ok');
});

caso('horas de falha: igual ao fechamento (121 min sem QAP = 1h; 151 = 2h; 3/6 desconta 1h)', () => {
  const ini = t('2026-11-03T19:00');
  assert.strictEqual(R.falhasQap([foto('2026-11-03T21:01')], ini, t('2026-11-03T21:01'), ON).horas, 1);
  assert.strictEqual(R.falhasQap([foto('2026-11-03T21:31')], ini, t('2026-11-03T21:31'), ON).horas, 2);
  const comPausa = [foto('2026-11-03T19:50'), { tipo: 'pausa_ini', ts: t('2026-11-03T20:00') }, foto('2026-11-03T22:10')];
  assert.strictEqual(R.falhasQap(comPausa, ini, t('2026-11-03T22:10'), ON).horas, 0);
  const e = R.estadoQap(sched, posts.mascote, ON, [foto('2026-11-03T21:31')], t('2026-11-03T21:40'));
  assert.strictEqual(e.horasFalha, 2);
});

console.log(`\n${n} casos passaram`);
