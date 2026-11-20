// Testa a tela de senha (auth-gate.js) com Firebase e página de mentira.
// Uso: node teste/auth-gate.test.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const EQUIPE = 'schiavolindaniel@gmail.com';

// salvo: login que já estava guardado no aparelho quando a página abre
function montar(salvo) {
  const el = () => ({
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { this[`on${t}`] = f; },
    querySelector(s) { this._f = this._f || {}; this._f[s] = this._f[s] || el(); return this._f[s]; },
    appendChild() {}, focus() {}, hidden: true, value: '',
  });
  const estado = { user: salvo ? { email: salvo } : null, saiu: 0, persistencia: 'LOCAL', recarregou: 0, ouvinte: null };
  const auth = {
    setPersistence(p) { estado.persistencia = p; return Promise.resolve(); },
    onAuthStateChanged(f) { estado.ouvinte = f; Promise.resolve().then(() => f(estado.user)); },
    signOut() { estado.saiu++; estado.user = null; return Promise.resolve().then(() => estado.ouvinte(null)); },
    signInWithEmailAndPassword(email, senha) {
      if (senha !== 'certa') return Promise.reject({ code: 'auth/wrong-password' });
      estado.user = { email };
      return Promise.resolve().then(() => estado.ouvinte(estado.user));
    },
  };
  const firebase = { apps: [], initializeApp() { firebase.apps.push(1); }, auth: Object.assign(() => auth, { Auth: { Persistence: { NONE: 'NONE' } } }) };
  let overlay = null;
  const document = { head: el(), body: { appendChild(o) { overlay = o; } }, createElement: () => el() };
  const ctx = vm.createContext({ firebase, document, location: { reload() { estado.recarregou++; } }, setTimeout: () => {}, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'auth-gate.js'), 'utf8'), ctx);
  const digitar = async senha => {
    overlay.querySelector('input[type=password]').value = senha;
    await overlay.querySelector('form').onsubmit({ preventDefault() {} });
  };
  return { gate: ctx.window.AuthGate, estado, digitar, aberta: () => !!overlay && overlay.classList.contains('active'), voltar: () => overlay.querySelector('.ag-voltar') };
}

const espera = () => new Promise(r => setImmediate(r));
let falhas = 0;
function caso(nome, cond) {
  console.log(`${cond ? 'ok  ' : 'FALHOU'}  ${nome}`);
  if (!cond) falhas++;
}

(async () => {
  // navegador da supervisão, como sempre foi
  let t = montar(EQUIPE), entrou = false;
  t.gate.start({}).then(() => { entrou = true; });
  await espera();
  caso('sem opções: login salvo entra direto (como antes)', entrou && !t.aberta());

  t = montar(null); entrou = false;
  t.gate.start({}).then(() => { entrou = true; });
  await espera();
  caso('sem opções e sem login: pede a senha', !entrou && t.aberta());

  // botão Supervisão do app aberto no navegador (index.html?entrar=1)
  t = montar(EQUIPE); entrou = false;
  t.gate.start({}, { sempre: true, voltar: 'app.html' }).then(() => { entrou = true; });
  await espera();
  caso('sempre: login salvo NÃO entra direto, pede a senha', !entrou && t.aberta());
  caso('sempre (navegador): não apaga o login dos outros apps', t.estado.saiu === 0 && t.estado.persistencia === 'LOCAL');
  caso('tela de senha tem o botão Voltar para o app', t.voltar().href === 'app.html' && t.voltar().hidden === false);
  await t.digitar('errada'); await espera();
  caso('sempre: senha errada não entra', !entrou && t.aberta());
  await t.digitar('certa'); await espera();
  caso('sempre: senha certa entra', entrou && !t.aberta());

  // dentro do app Android (celular do posto)
  t = montar(EQUIPE); entrou = false;
  t.gate.start({}, { sempre: true, naoGuardar: true, voltar: 'app.html' }).then(() => { entrou = true; });
  await espera();
  caso('app: login que estava salvo é apagado e a senha é pedida', !entrou && t.aberta() && t.estado.saiu === 1);
  caso('app: o login novo não fica salvo no aparelho', t.estado.persistencia === 'NONE');
  await t.digitar('certa'); await espera();
  caso('app: senha certa entra', entrou && !t.aberta());
  await t.gate.signOut(); await espera();
  caso('Sair com o painel aberto volta para a tela de senha (recarrega)', t.estado.recarregou === 1);

  // conta que não é a da equipe
  t = montar('outra@conta.com'); entrou = false;
  t.gate.start({}).then(() => { entrou = true; });
  await espera();
  caso('conta que não é da equipe é tirada e pede a senha', !entrou && t.aberta() && t.estado.saiu === 1);

  console.log(falhas ? `\n${falhas} caso(s) falharam` : '\nTodos os casos passaram');
  process.exit(falhas ? 1 : 0);
})();
