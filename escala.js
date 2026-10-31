// ============================================================
// Front Security - App QAP: escala dos postos (quem está de serviço em cada turno)
// CÓPIA de ../coberturas/app.js (linhas 36-674: helpers de data/turno + classe Schedule).
// Ao mudar a regra de escala no Coberturas, copie de novo para cá: os dois apps têm que concordar.
// ============================================================

const CATEGORY_ORDER = ['Segurança Econ', 'Segurança Nurban', 'Segurança Kallas', 'Segurança Cursino', 'Limpeza'];
const CATEGORY_ICONS = { 'Segurança Econ': '🛡️', 'Segurança Nurban': '🏢', 'Segurança Kallas': '🔐', 'Segurança Cursino': '📍', 'Limpeza': '🧹' };
const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const SHIFT_LABEL = { diurno: '☀️ Diurno', noturno: '🌙 Noturno', '24h': '🔄 24h' };
// QRA slots (vagas). Each post has a fixed set of slots and each slot holds ONE QRA.
// parity: 12x36 by day of the month (0 = even days, 1 = odd days) · dows: weekdays the slot works
const QRA_TURNOS = {
  diurno: { label: '☀️ Diurno todo dia', short: '☀️', shifts: ['diurno'], parity: null },
  diurno_par: { label: '☀️ Diurno par', short: '☀️P', shifts: ['diurno'], parity: 0 },
  diurno_impar: { label: '☀️ Diurno ímpar', short: '☀️I', shifts: ['diurno'], parity: 1 },
  diurno_semana: { label: '☀️ Diurno seg–sex', short: '☀️S', shifts: ['diurno'], parity: null, dows: [1, 2, 3, 4, 5] },
  diurno_sabado: { label: '☀️ Diurno sábado', short: '☀️Sáb', shifts: ['diurno'], parity: null, dows: [6] },
  diurno_domingo: { label: '☀️ Diurno domingo', short: '☀️Dom', shifts: ['diurno'], parity: null, dows: [0] },
  noturno_par: { label: '🌙 Noturno par', short: '🌙P', shifts: ['noturno'], parity: 0 },
  noturno_impar: { label: '🌙 Noturno ímpar', short: '🌙I', shifts: ['noturno'], parity: 1 },
  // vagas with chosen weekdays (stored in vaga.dows), e.g. Jaguare: Mosca seg/qua/sex, Isaque ter/qui/sáb/dom
  diurno_dias: { label: '☀️ Diurno', short: '☀️D', shifts: ['diurno'], parity: null, custom: true },
  noturno_dias: { label: '🌙 Noturno', short: '🌙D', shifts: ['noturno'], parity: null, custom: true },
  // legacy values, kept so older records still work
  noturno: { label: '🌙 Noturno', short: '🌙', shifts: ['noturno'], parity: null },
  '24h': { label: '🔄 24h', short: '🔄', shifts: ['diurno', 'noturno'], parity: null },
};
// Shift hours. Diurno 07:00–19:00 · Noturno 19:00–07:00 (next day).
// Hybrid posts start the night at 17:00 on weekdays (Mon–Fri); weekends 19:00.
// A night slot belongs to the date it STARTS on. Default alert times: diurno 05:00, noturno 17:00.
const DAY_START = 7 * 60;
const NIGHT_START = 19 * 60;
const HYBRID_WEEKDAY_NIGHT_START = 17 * 60;
const DEFAULT_ALERT = { diurno: '05:00', noturno: '17:00' };
// Weekend vagas of hybrid posts are not fixed: they are filled week by week and free up every Monday
const WEEKLY_TURNOS = ['diurno_sabado', 'diurno_domingo'];
const ALERT_DAYS_AHEAD = 7;   // header badge / card warnings look this far ahead
const AGENDA_DAYS_AHEAD = 30;

// ===== Date & shift helpers (local time, dates as 'YYYY-MM-DD') =====

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

// 12x36 alternation: the team works one day and rests the next, ALWAYS (also from the 31st to
// the 1st). "Par" = the team that worked the even days of October 2026; from then on it simply
// alternates, so it does not depend on the day of the month. 0 = turma par, 1 = turma ímpar
// (stored turma). The NAME shown follows the month's days: see turmaDayParity.
const ALTERNATION_ANCHOR = '2026-10-02';
function dayNumber(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function alternationParity(date) {
  return (((dayNumber(date) - dayNumber(ALTERNATION_ANCHOR)) % 2) + 2) % 2;
}

// A month ending on an odd day (31, or 29 in a leap February) swaps the turmas' day parity on the
// 1st: whoever worked the even days now works the odd ones. First such day 1 in (from, to], or null.
function nextParityFlip(from, to) {
  let d = parseDate(from);
  for (;;) {
    const first = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const str = toDateStr(first);
    if (str > to) return null;
    if (new Date(first.getFullYear(), first.getMonth(), 0).getDate() % 2 === 1) return str;
    d = first;
  }
}

// Monday of the week (Mon→Sun) containing the date
function weekStart(date) {
  const dow = parseDate(date).getDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

// Operational date: before 07:00 we are still in the previous date's night shift
function todayStr() {
  return currentSlot().date;
}

// 'diurno' | 'noturno' | '24h' → the shifts it occupies
function shiftsOf(type) {
  if (type === '24h') return ['diurno', 'noturno'];
  if (type === 'diurno' || type === 'noturno') return [type];
  return [];
}

function currentSlot() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < DAY_START) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { date: toDateStr(y), shift: 'noturno' };
  }
  return { date: toDateStr(now), shift: minutes >= NIGHT_START ? 'noturno' : 'diurno' };
}

function atMinutes(date, minutes) {
  const d = parseDate(date);
  d.setMinutes(minutes);
  return d;
}

function hhmmToMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

// Real start/end of a post's shift on a date (end of a night is 07:00 of the next day)
function shiftWindow(post, date, shift) {
  if (shift === 'diurno') return { start: atMinutes(date, DAY_START), end: atMinutes(date, NIGHT_START) };
  const dow = parseDate(date).getDay();
  const startMin = post && post.escalaType === 'hibrido' && dow >= 1 && dow <= 5 ? HYBRID_WEEKDAY_NIGHT_START : NIGHT_START;
  return { start: atMinutes(date, startMin), end: atMinutes(addDays(date, 1), DAY_START) };
}

function slotEnded(post, date, shift) {
  return new Date() >= shiftWindow(post, date, shift).end;
}

// Alarm window of a shift: from the post's alert time (default 05:00 / 17:00) until the shift ends
function slotAlarmActive(post, date, shift) {
  const fallback = hhmmToMinutes(DEFAULT_ALERT[shift]);
  const alertMin = hhmmToMinutes(shift === 'diurno' ? post.alertTimeDiurno : post.alertTimeNoturno, fallback);
  const now = new Date();
  return now >= atMinutes(date, alertMin) && now < shiftWindow(post, date, shift).end;
}

// "☀️ Diurno par", "☀️ Diurno seg, qua, sex" (chosen days), "☀️ Diurno sábado (24/10)" (weekly)
// Day parity (0 = dias pares, 1 = dias ímpares) a 12x36 turma works in the month of `date`.
// After a month ending on the 31st the October "par" turma works the odd days, so it is shown
// as "ímpar" from then on (only the name changes, the stored turma stays the same).
function turmaDayParity(turma, date) {
  const dom = parseDate(date).getDate();
  return alternationParity(date) === turma ? dom % 2 : 1 - (dom % 2);
}

// Name of a vaga; par/ímpar named by the days it works in the month of `date`
function vagaTurnoLabel(v, withWeek, date = todayStr()) {
  const def = QRA_TURNOS[v.turno];
  if (!def) return v.turno;
  if (def.parity !== null) return `${def.label.replace(/ (par|ímpar)$/, '')} ${turmaDayParity(def.parity, date) === 0 ? 'par' : 'ímpar'}`;
  if (def.custom) return `${def.label} ${(v.dows || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => DAY_NAMES[d].toLowerCase()).join(', ')}`;
  if (withWeek && WEEKLY_TURNOS.includes(v.turno) && v.weekOf) {
    const day = addDays(v.weekOf, v.turno === 'diurno_sabado' ? 5 : 6);
    return `${def.label} (${day.split('-').reverse().slice(0, 2).join('/')})`;
  }
  return def.label;
}

// "☀️ 07h–19h · 🌙 19h–07h" — hybrids show the 17h weekday entry
function postHoursLabel(post) {
  const sched = post.hibridoSchedule || [];
  const isNight = t => t === 'noturno' || t === '24h';
  const isDay = t => t === 'diurno' || t === '24h';
  let day = false, nightWeek = false, nightWeekend = false;
  if (post.escalaType === 'hibrido') {
    day = sched.some(isDay);
    nightWeek = [1, 2, 3, 4, 5].some(d => isNight(sched[d]));
    nightWeekend = [0, 6].some(d => isNight(sched[d]));
  } else {
    day = post.escalaType === 'diurno' || post.escalaType === '24h';
    nightWeekend = nightWeek = post.escalaType === 'noturno' || post.escalaType === '24h';
  }
  const parts = [];
  if (day) parts.push('☀️ 07h–19h');
  if (post.escalaType === 'hibrido' && nightWeek && nightWeekend) parts.push('🌙 seg–sex 17h–07h · sáb/dom 19h–07h');
  else if (post.escalaType === 'hibrido' && nightWeek) parts.push('🌙 17h–07h');
  else if (nightWeek || nightWeekend) parts.push('🌙 19h–07h');
  return parts.join(' · ');
}

function prevSlot(date, shift) {
  return shift === 'noturno' ? { date, shift: 'diurno' } : { date: addDays(date, -1), shift: 'noturno' };
}

function nextSlot(date, shift) {
  return shift === 'diurno' ? { date, shift: 'noturno' } : { date: addDays(date, 1), shift: 'diurno' };
}

function dateLabel(date) {
  const today = todayStr();
  if (date === today) return 'Hoje';
  if (date === addDays(today, 1)) return 'Amanhã';
  if (date === addDays(today, -1)) return 'Ontem';
  const d = parseDate(date);
  return `${DAY_NAMES[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function slotLabel(date, shift) {
  return `${dateLabel(date)} ${SHIFT_LABEL[shift] || shift}`;
}

function normalizeText(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makeId(name) {
  return normalizeText(name).replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30) + '_' + Date.now();
}

// Google Calendar "new event" link (all-day event on `date`)
function gcalUrl(title, date, details) {
  const start = date.replace(/-/g, '');
  const end = addDays(date, 1).replace(/-/g, '');
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${start}/${end}`, details: details || '' });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ============================================================
// Pure schedule logic (no DOM) — easy to test in isolation
// ============================================================

class Schedule {
  constructor() {
    this.posts = {};
    this.qras = {};
    this.folgas = {};
    this.coberturas = {};
  }

  // Shift a post works on `date`: 'diurno' | 'noturno' | '24h' | 'folga'
  postShiftOn(post, date) {
    if (!post) return 'folga';
    // new post not open yet: no shifts, so no alerts or escala clashes before that date
    if (post.startDate && date < post.startDate) return 'folga';
    const dow = parseDate(date).getDay();
    if (post.escalaType === 'hibrido') {
      return (post.hibridoSchedule && post.hibridoSchedule[dow]) || 'folga';
    }
    const days = Array.isArray(post.days) ? post.days : [0, 1, 2, 3, 4, 5, 6];
    return days.includes(dow) ? post.escalaType : 'folga';
  }

  postWorks(post, date, shift) {
    return shiftsOf(this.postShiftOn(post, date)).includes(shift);
  }

  // Slots (vagas) of a post, derived from its escala
  postSlots(post) {
    if (!post) return [];
    if (post.escalaType === '24h') return ['diurno_par', 'diurno_impar', 'noturno_par', 'noturno_impar'];
    if (post.escalaType === 'noturno') return ['noturno_par', 'noturno_impar'];
    if (post.escalaType === 'diurno') return ['diurno', 'diurno_par', 'diurno_impar'];
    const sched = post.hibridoSchedule || [];
    const hasDay = dow => sched[dow] === 'diurno' || sched[dow] === '24h';
    const slots = [];
    if ([1, 2, 3, 4, 5].some(hasDay)) slots.push('diurno_semana');
    if (hasDay(6)) slots.push('diurno_sabado');
    if (hasDay(0)) slots.push('diurno_domingo');
    if (sched.some(t => t === 'noturno' || t === '24h')) slots.push('noturno_par', 'noturno_impar');
    return slots;
  }

  // ----- Vagas -----
  // A vaga is { postId, turno, weekOf?, dows? }. Its key identifies it inside a post:
  // the turno, or "turno:days" for vagas with chosen weekdays (e.g. "diurno_dias:135").
  vagaKey(v) {
    const def = QRA_TURNOS[v.turno];
    return def && def.custom ? `${v.turno}:${(v.dows || []).join('')}` : v.turno;
  }

  parseVagaKey(postId, key) {
    const [turno, days] = String(key).split(':');
    const v = { postId, turno };
    if (days !== undefined) v.dows = days.split('').filter(Boolean).map(Number);
    return v;
  }

  // Every stored vaga of a QRA (main postId/turno + extra), including expired weekly ones
  allVagas(qra) {
    if (!qra) return [];
    const norm = (src, x) => {
      const v = { postId: x.postId, turno: x.turno, weekOf: x.weekOf || '' };
      if (Array.isArray(x.dows) && x.dows.length) v.dows = x.dows.map(Number);
      return v;
    };
    const vagas = [];
    if (qra.postId && qra.turno) vagas.push(norm(qra, qra));
    (Array.isArray(qra.extra) ? qra.extra : []).forEach(x => { if (x && x.postId && x.turno) vagas.push(norm(qra, x)); });
    return vagas;
  }

  // Weekly vagas (weekend of hybrids) belong to one week; expired ones are ignored
  vagaCurrent(v) {
    return !WEEKLY_TURNOS.includes(v.turno) || (v.weekOf && v.weekOf >= weekStart(todayStr()));
  }

  // All vagas of a QRA still in force (main + extra = escala dupla)
  qraVagas(qra) {
    return this.allVagas(qra).filter(v => this.vagaCurrent(v));
  }

  isDupla(qra) {
    return this.qraVagas(qra).length > 1;
  }

  // Date whose month names the par/ímpar vagas of a post: today, or its opening day if later
  labelDate(postId) {
    const post = this.posts[postId];
    const today = todayStr();
    return post && post.startDate && post.startDate > today ? post.startDate : today;
  }

  // Week whose weekend is the next one not over yet (weekly vagas are filled for it)
  targetWeekOf(post) {
    const w = weekStart(todayStr());
    return slotEnded(post, addDays(w, 6), 'diurno') ? addDays(w, 7) : w;
  }

  // QRA holding a vaga of a post. For weekly vagas: the holder for `week` (default: next weekend)
  slotHolder(postId, key, week) {
    const turno = String(key).split(':')[0];
    const weekly = WEEKLY_TURNOS.includes(turno);
    const wk = weekly ? (week || this.targetWeekOf(this.posts[postId])) : null;
    return Object.values(this.qras).find(q => this.qraVagas(q)
      .some(v => v.postId === postId && this.vagaKey(v) === key && (!weekly || v.weekOf === wk))) || null;
  }

  qraShifts(qra) {
    return [...new Set(this.qraVagas(qra).flatMap(v => (QRA_TURNOS[v.turno] || { shifts: [] }).shifts))];
  }

  // A vaga works this shift on this date: post operates, turno covers it (par/ímpar, weekdays,
  // chosen days) and, for weekly vagas that carry a week, that date is in that week
  vagaScheduled(vaga, date, shift) {
    const def = QRA_TURNOS[vaga.turno];
    if (!def || !def.shifts.includes(shift)) return false;
    const d = parseDate(date);
    if (def.parity !== null && alternationParity(date) !== def.parity) return false;
    if (def.dows && !def.dows.includes(d.getDay())) return false;
    if (def.custom && !(vaga.dows || []).includes(d.getDay())) return false;
    if (WEEKLY_TURNOS.includes(vaga.turno) && vaga.weekOf && vaga.weekOf !== weekStart(date)) return false;
    return this.postWorks(this.posts[vaga.postId], date, shift);
  }

  // Vagas of the QRA on duty at that date/shift (optionally only at one post), ignoring folgas
  qraVagasOn(qra, date, shift, postId) {
    if (!qra) return [];
    const days = Array.isArray(qra.days) ? qra.days : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(parseDate(date).getDay())) return [];
    return this.qraVagas(qra).filter(v => (!postId || v.postId === postId) && this.vagaScheduled(v, date, shift));
  }

  // Titular duty ignoring folgas (reserves have no vaga, so never)
  qraScheduled(qra, date, shift, postId) {
    return this.qraVagasOn(qra, date, shift, postId).length > 0;
  }

  // Dates/shifts (next `days` days) where two vagas both work
  vagasOverlap(a, b, days = 28) {
    const hits = [];
    const start = todayStr();
    for (let i = 0; i < days; i++) {
      const date = addDays(start, i);
      ['diurno', 'noturno'].forEach(shift => {
        if (this.vagaScheduled(a, date, shift) && this.vagaScheduled(b, date, shift)) hits.push({ date, shift });
      });
    }
    return hits;
  }

  // Other QRAs whose vagas in the same post work at the same time as `vaga` (two people
  // in one shift). E.g. "Diurno todo dia" vs "Diurno par", or chosen days vs par/ímpar.
  overlapHolders(vaga, ignoreQraId) {
    const out = [];
    Object.values(this.qras).forEach(q => {
      if (q.id === ignoreQraId) return;
      this.qraVagas(q).filter(v => v.postId === vaga.postId && this.vagaKey(v) !== this.vagaKey(vaga)).forEach(v => {
        const hits = this.vagasOverlap(vaga, v);
        if (hits.length) out.push({ qra: q, vaga: v, hits });
      });
    });
    return out;
  }

  // Time conflicts of adding `vaga` to a QRA who already has other vagas (next `days` days):
  // choques = same shift on the same day · dobras = shift right before/after one of his shifts
  // A plantão of his own vaga he really has to work: not on folga and not covered by someone else
  vagaBusy(qra, v, date, shift, out) {
    if (!this.vagaScheduled(v, date, shift)) return false;
    if (this.folgaOf(qra.id, date)) return false;
    const cov = this.releaseCover(qra, v, date, shift);
    if (cov) {
      if (out && !out.released.some(r => r.date === date && r.shift === shift && r.vaga.postId === v.postId)) out.released.push({ date, shift, vaga: v, by: cov.qraName });
      return false;
    }
    return true;
  }

  vagaConflicts(qra, vaga, days = 28) {
    const existing = this.qraVagas(qra);
    const out = { choques: [], dobras: [], released: [] };
    const start = todayStr();
    for (let i = 0; i < days; i++) {
      const date = addDays(start, i);
      (QRA_TURNOS[vaga.turno] || { shifts: [] }).shifts.forEach(shift => {
        if (!this.vagaScheduled(vaga, date, shift)) return;
        existing.forEach(v => {
          // plantões of his other vagas that are covered (or on folga) do not clash
          if (this.vagaBusy(qra, v, date, shift, out)) out.choques.push({ date, shift, vaga: v });
          const before = prevSlot(date, shift);
          const after = nextSlot(date, shift);
          if (this.vagaBusy(qra, v, before.date, before.shift, out)) out.dobras.push({ date, shift, vaga: v, side: 'anterior', at: before });
          if (this.vagaBusy(qra, v, after.date, after.shift, out)) out.dobras.push({ date, shift, vaga: v, side: 'posterior', at: after });
        });
      });
    }
    return out;
  }

  folgaOf(qraId, date) {
    return Object.values(this.folgas).find(f => f.qraId === qraId && f.date === date) || null;
  }

  // Registered QRA matching a typed name (so temporary names still get conflict checks)
  qraByName(name) {
    const n = normalizeText(name);
    if (!n) return null;
    return Object.values(this.qras).find(q => normalizeText(q.name) === n) || null;
  }

  // person = { qraId?, name }. Returns the duties of that person in the slot.
  // Cobertura (by someone else) already placed on a QRA's own vaga at that date/shift
  // A cobertura releases a titular only if it is for HIS vaga (or his folga); an old cobertura
  // without vaga info counts only when he is the single titular of that post/shift
  releaseCover(qra, vaga, date, shift, excludeCobId) {
    const post = this.posts[vaga.postId];
    return Object.values(this.coberturas).find(c => {
      if (c.pending || c.id === excludeCobId || c.postId !== vaga.postId || c.date !== date
        || !shiftsOf(c.turno).includes(shift) || c.qraId === qra.id) return false;
      if (c.vaga) return c.vaga === this.vagaKey(vaga);
      if (c.folgaId && this.folgas[c.folgaId]) return this.folgas[c.folgaId].qraId === qra.id;
      return post ? Object.values(this.qras).filter(q => this.qraScheduled(q, date, shift, post.id)).length === 1 : false;
    }) || null;
  }

  empenhosAt(person, date, shift, excludeCobId) {
    const result = [];
    const qra = person.qraId ? this.qras[person.qraId] : this.qraByName(person.name);
    const qraId = qra ? qra.id : null;
    const name = normalizeText(qra ? qra.name : person.name);

    if (qra && !this.folgaOf(qra.id, date)) {
      // His own shift already covered by someone else = he is released from it, not a clash
      this.qraVagasOn(qra, date, shift).forEach(v => {
        if (!this.releaseCover(qra, v, date, shift, excludeCobId)) result.push({ kind: 'fixo', postId: v.postId, date, shift });
      });
    }
    Object.values(this.coberturas).forEach(c => {
      if (c.pending || c.id === excludeCobId || c.date !== date || !shiftsOf(c.turno).includes(shift)) return;
      const samePerson = (qraId && c.qraId === qraId) || (name && normalizeText(c.qraName) === name);
      if (samePerson) result.push({ kind: 'cobertura', postId: c.postId, date, shift, cobId: c.id });
    });
    return result;
  }

  // Validate a cobertura before saving.
  // conflicts = same shift already taken · warnings = double shift / post closed · infos = context
  checkCobertura({ postId, date, turno, person, excludeCobId }) {
    const out = { conflicts: [], warnings: [], infos: [] };
    const post = this.posts[postId];
    const shifts = shiftsOf(turno);
    if (!post || !date || shifts.length === 0 || !(person.qraId || normalizeText(person.name))) return out;

    shifts.forEach(s => {
      if (!this.postWorks(post, date, s)) {
        out.warnings.push(`O posto ${post.name} não opera em ${slotLabel(date, s)}.`);
      }
    });

    const describe = e => {
      const p = this.posts[e.postId];
      const where = p ? `${p.name} (${p.category})` : 'posto removido';
      return `${slotLabel(e.date, e.shift)} em ${where} — ${e.kind === 'fixo' ? 'titular' : 'cobertura'}`;
    };

    shifts.forEach(s => {
      this.empenhosAt(person, date, s, excludeCobId).forEach(e => {
        if (e.postId === postId && e.kind === 'fixo') {
          out.conflicts.push(`Já é titular deste posto em ${slotLabel(date, s)}.`);
        } else {
          out.conflicts.push(`Choque: já está empenhado em ${describe(e)}.`);
        }
      });
    });

    const before = prevSlot(date, shifts[0]);
    const after = nextSlot(date, shifts[shifts.length - 1]);
    this.empenhosAt(person, before.date, before.shift, excludeCobId).forEach(e => {
      out.warnings.push(`Dobra: empenhado no turno ANTERIOR — ${describe(e)}.`);
    });
    this.empenhosAt(person, after.date, after.shift, excludeCobId).forEach(e => {
      out.warnings.push(`Dobra: empenhado no turno POSTERIOR — ${describe(e)}.`);
    });

    const qra = person.qraId ? this.qras[person.qraId] : this.qraByName(person.name);
    if (qra) {
      shifts.forEach(s => this.qraVagasOn(qra, date, s).forEach(v => {
        const cov = this.releaseCover(qra, v, date, s, excludeCobId);
        const p = this.posts[v.postId];
        if (cov) out.infos.push(`O plantão dele (${p ? p.name : '?'} ${slotLabel(date, s)}) já está coberto por ${cov.qraName || 'alguém'} — está liberado.`);
        else if (!this.folgaOf(qra.id, date)) out.infos.push(`Para liberar, primeiro lance uma cobertura no plantão dele: ${p ? p.name : '?'} ${slotLabel(date, s)}.`);
      }));
    }
    if (qra && this.folgaOf(qra.id, date)) {
      out.infos.push(`${qra.name} está de folga neste dia (por isso está livre no posto dele).`);
    }
    if (!person.qraId && qra) {
      out.infos.push(`O nome digitado corresponde ao QRA cadastrado ${qra.name} — empenhos dele foram verificados.`);
    }
    return out;
  }

  // Coverage of one post slot
  slotStatus(post, date, shift) {
    const titulares = Object.values(this.qras).filter(q => this.qraScheduled(q, date, shift, post.id));
    const ausentes = titulares.filter(q => this.folgaOf(q.id, date));
    const presentes = titulares.filter(q => !this.folgaOf(q.id, date));
    const all = Object.values(this.coberturas).filter(c => c.postId === post.id && c.date === date && shiftsOf(c.turno).includes(shift));
    // A request without a QRA yet ("a definir") does not cover anything: it only raises the alert
    const coberturas = all.filter(c => !c.pending);
    const pedidos = all.filter(c => c.pending);
    return { titulares, ausentes, presentes, coberturas, pedidos, descoberto: Math.max(0, ausentes.length - coberturas.length) };
  }

  // Vagas of a post that work on a given date: [{ slot, shift, holder }]
  postVagaKeys(post) {
    const keys = [...this.postSlots(post)];
    Object.values(this.qras).forEach(q => this.qraVagas(q).forEach(v => {
      if (v.postId === post.id && !keys.includes(this.vagaKey(v))) keys.push(this.vagaKey(v));
    }));
    return keys;
  }

  // Vagas working on a date: [{ slot (key), shift, holder }] — holder of weekly vagas = that week's
  activeSlotsOn(post, date) {
    return this.postVagaKeys(post).flatMap(key => {
      const v = this.parseVagaKey(post.id, key);
      return (QRA_TURNOS[v.turno] || { shifts: [] }).shifts
        .filter(shift => this.vagaScheduled(v, date, shift))
        .map(shift => ({ slot: key, shift, holder: this.slotHolder(post.id, key, weekStart(date)) }));
    });
  }

  // Coberturas (with a QRA) placed on one vaga of a post, not over yet, soonest first.
  // Old coberturas without vaga info count when the vaga works that date/shift.
  vagaCoberturas(post, vaga) {
    const key = this.vagaKey(vaga);
    const from = addDays(todayStr(), -1);
    return Object.values(this.coberturas)
      .filter(c => !c.pending && c.postId === post.id && c.date >= from)
      .flatMap(c => shiftsOf(c.turno).map(shift => ({ cob: c, date: c.date, shift })))
      .filter(({ cob, date, shift }) => !slotEnded(post, date, shift)
        && (cob.vaga ? cob.vaga === key : this.vagaScheduled(vaga, date, shift)))
      .sort((a, b) => (a.date + a.shift).localeCompare(b.date + b.shift));
  }

  // Coverage requests still waiting for a QRA, from the current slot on (any date ahead)
  pendingRequests() {
    const cur = currentSlot();
    const list = [];
    Object.values(this.coberturas).filter(c => c.pending && c.date >= addDays(cur.date, -1)).forEach(c => {
      const post = this.posts[c.postId];
      if (!post) return;
      shiftsOf(c.turno).forEach(shift => {
        if (slotEnded(post, c.date, shift)) return;
        list.push({ post, date: c.date, shift, status: this.slotStatus(post, c.date, shift), cob: c, kind: 'pedido' });
      });
    });
    return list;
  }

  // Uncovered folga slots from the current slot up to `days` ahead
  uncoveredSlots(days) {
    const list = [];
    const cur = currentSlot();
    for (let i = -1; i <= days; i++) {
      const date = addDays(cur.date, i);
      Object.values(this.posts).forEach(post => {
        shiftsOf(this.postShiftOn(post, date)).forEach(shift => {
          if (slotEnded(post, date, shift)) return; // already over
          const st = this.slotStatus(post, date, shift);
          if (st.descoberto > 0) list.push({ post, date, shift, status: st, kind: 'folga' });
        });
      });
    }
    return list;
  }

  // Saturday and Sunday of the current week (weeks run Monday → Sunday)
  weekendDates(today = todayStr()) {
    const dow = parseDate(today).getDay();
    const sat = addDays(today, dow === 0 ? -1 : 6 - dow);
    return [sat, addDays(sat, 1)];
  }

  // From Monday on, every weekend shift of a hybrid post with nobody on duty
  // (no present titular and no cobertura) stays pending until it is filled
  weekendPendingSlots() {
    const cur = currentSlot();
    const list = [];
    this.weekendDates(cur.date).forEach(date => {
      if (date < addDays(cur.date, -1)) return;
      Object.values(this.posts).filter(p => p.escalaType === 'hibrido').forEach(post => {
        shiftsOf(this.postShiftOn(post, date)).forEach(shift => {
          if (slotEnded(post, date, shift)) return;
          const st = this.slotStatus(post, date, shift);
          if (st.presentes.length === 0 && st.coberturas.length === 0) list.push({ post, date, shift, status: st, kind: 'fds' });
        });
      });
    });
    return list;
  }

  // First duty from the current slot onwards
  nextEmpenho(qra, maxDays = 30) {
    let slot = currentSlot();
    for (let i = 0; i < maxDays * 2; i++) {
      const emp = this.empenhosAt({ qraId: qra.id }, slot.date, slot.shift);
      if (emp.length > 0) return emp[0];
      slot = nextSlot(slot.date, slot.shift);
    }
    return null;
  }
}
