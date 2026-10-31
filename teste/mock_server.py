# -*- coding: utf-8 -*-
"""
Teste local do App QAP, sem Firebase e sem Google Drive de verdade.

Serve a pasta do app e imita:
  /mock/api  -> o Code.gs (acoes posto, entrar, evento, midia)
  /mock/db   -> o Realtime Database (GET/PUT/PATCH/DELETE ?path=a/b)

Uso:  python teste/mock_server.py [pasta_dos_dados]
Abrir: http://localhost:8765/index.html?mock=1   (painel)
       o link do posto de teste aparece no painel (teste_24h, QRA "João Teste", PIN 1234)
"""
import base64
import hashlib
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DADOS = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(RAIZ, 'teste', '_dados')
PORTA = 8765
TIPOS = {'qti', 'assumir', 'qap', 'ronda', 'pausa_ini', 'pausa_fim', 'passar', 'qru'}


def sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def dia_operacional(ms):
    d = datetime.fromtimestamp(ms / 1000)
    if d.hour < 7:
        d -= timedelta(days=1)
    return d.strftime('%Y-%m-%d')


def agora_ms():
    return int(time.time() * 1000)


def semente():
    hoje = dia_operacional(agora_ms())
    duas_horas = agora_ms() - 2 * 3600 * 1000
    return {
        'posts': {
            'teste_24h': {'id': 'teste_24h', 'name': 'Teste 24h', 'category': 'Segurança Econ', 'escalaType': '24h', 'days': [0, 1, 2, 3, 4, 5, 6]},
            'teste_noturno': {'id': 'teste_noturno', 'name': 'Teste Noturno', 'category': 'Segurança Nurban', 'escalaType': 'noturno', 'days': [0, 1, 2, 3, 4, 5, 6]},
            'teste_limpeza': {'id': 'teste_limpeza', 'name': 'Teste Limpeza', 'category': 'Limpeza', 'escalaType': 'diurno', 'days': [0, 1, 2, 3, 4, 5, 6]},
        },
        'qras': {
            'teste_joao': {'id': 'teste_joao', 'name': 'João Teste', 'postId': 'teste_24h', 'turno': 'diurno_par', 'days': [0, 1, 2, 3, 4, 5, 6]},
            'teste_maria': {'id': 'teste_maria', 'name': 'Maria Teste', 'postId': 'teste_24h', 'turno': 'diurno_impar', 'days': [0, 1, 2, 3, 4, 5, 6]},
            'teste_pedro': {'id': 'teste_pedro', 'name': 'Pedro Teste', 'postId': 'teste_noturno', 'turno': 'noturno_par', 'days': [0, 1, 2, 3, 4, 5, 6]},
        },
        'folgas': {},
        'coberturas': {},
        'procedimentos': {
            'config': {'teste_24h': {'chave': 'teste123', 'ativo': True, 'intervaloMin': 60, 'toleranciaMin': 15}},
            'pins': {'teste_joao': sha('teste_joao:1234')},
            # QAP de 2 h atrás: o posto de teste já começa atrasado
            'eventos': {dia_operacional(duas_horas): {'teste_24h': {'seed1': {
                'tipo': 'qap', 'qraId': 'teste_maria', 'qraNome': 'Maria Teste', 'ts': duas_horas, 'recebidoEm': duas_horas,
                'texto': 'QAP antigo (semente do teste)', 'midia': [{'id': 'semente_foto_0001', 'tipo': 'foto', 'mime': 'image/jpeg', 'kb': 1}]}}}},
        },
        '_hoje': hoje,
    }


DB = semente()
# 1x1 jpeg para a foto da semente
PIXEL = base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==')


def pegar(caminho):
    no = DB
    for p in [x for x in caminho.split('/') if x]:
        if not isinstance(no, dict) or p not in no:
            return None
        no = no[p]
    return no


def pai_de(caminho, criar=True):
    partes = [x for x in caminho.split('/') if x]
    no = DB
    for p in partes[:-1]:
        if p not in no or not isinstance(no[p], dict):
            if not criar:
                return None, partes[-1]
            no[p] = {}
        no = no[p]
    return no, partes[-1]


def gravar(caminho, valor):
    pai, chave = pai_de(caminho)
    if valor is None:
        pai.pop(chave, None)
    else:
        pai[chave] = valor


class Erro(Exception):
    pass


def checar_posto(p, k):
    cfg = pegar(f'procedimentos/config/{p}') or {}
    post = pegar(f'posts/{p}')
    if not post or not k or cfg.get('chave') != k:
        raise Erro('link')
    return post, cfg


def checar_pin(qra_id, pin):
    guardado = pegar(f'procedimentos/pins/{qra_id}')
    if not guardado:
        raise Erro('sem_pin')
    if sha(f'{qra_id}:{pin}') != guardado:
        raise Erro('pin')
    q = pegar(f'qras/{qra_id}')
    return {'id': qra_id, 'nome': q['name']}


def ultimo_qap(p):
    melhor = None
    for dia in (pegar('procedimentos/eventos') or {}).values():
        for ev in (dia.get(p) or {}).values():
            conta = any(m.get('tipo') in ('foto', 'video') for m in ev.get('midia') or []) or ev.get('tipo') == 'pausa_fim'
            if conta and (not melhor or ev['ts'] > melhor['ts']):
                melhor = {'ts': ev['ts'], 'qraNome': ev.get('qraNome'), 'tipo': ev['tipo']}
    return melhor


def api(req):
    acao = req.get('acao')
    if acao == 'posto':
        post, cfg = checar_posto(req.get('p'), req.get('k'))
        qras = [{'id': i, 'nome': q['name'], 'doPosto': q.get('postId') == req['p']} for i, q in (pegar('qras') or {}).items()]
        qras.sort(key=lambda q: (not q['doPosto'], q['nome']))
        return {'ok': True, 'agora': agora_ms(), 'posto': {'id': req['p'], 'nome': post['name'], 'categoria': post.get('category', ''),
                'intervaloMin': cfg.get('intervaloMin', 60)}, 'qras': qras, 'ultimo': ultimo_qap(req['p'])}
    if acao == 'entrar':
        checar_posto(req.get('p'), req.get('k'))
        return {'ok': True, 'agora': agora_ms(), 'qra': checar_pin(req.get('qraId'), req.get('pin'))}
    if acao == 'evento':
        checar_posto(req.get('p'), req.get('k'))
        qra = checar_pin(req.get('qraId'), req.get('pin'))
        if req.get('tipo') not in TIPOS:
            raise Erro('tipo')
        midias = req.get('midias') or []
        if req['tipo'] in ('qap', 'assumir') and not any(m.get('tipo') in ('foto', 'video') for m in midias):
            raise Erro('sem_imagem')
        agora = agora_ms()
        cap = req.get('capturadoEm') or agora
        if cap > agora + 120000 or cap < agora - 12 * 3600000:
            cap = agora
        dia = dia_operacional(cap)
        salvas = []
        for i, m in enumerate(midias):
            dados = base64.b64decode(m.get('b64') or '')
            if not dados:
                raise Erro('midia')
            if m['tipo'] != 'foto' and float(m.get('seg') or 0) > 16:
                raise Erro('longo')
            fid = uuid.uuid4().hex
            os.makedirs(DADOS, exist_ok=True)
            with open(os.path.join(DADOS, fid), 'wb') as f:
                f.write(dados)
            with open(os.path.join(DADOS, fid + '.mime'), 'w') as f:
                f.write(m['mime'].split(';')[0])
            item = {'id': fid, 'tipo': m['tipo'], 'mime': m['mime'].split(';')[0], 'kb': round(len(dados) / 1024)}
            if m['tipo'] != 'foto':
                item['seg'] = round(float(m.get('seg') or 0), 1)
            salvas.append(item)
        ev = {'tipo': req['tipo'], 'qraId': qra['id'], 'qraNome': qra['nome'], 'ts': cap, 'recebidoEm': agora,
              'texto': str(req.get('texto') or '')[:500], 'midia': salvas}
        for k in ('lat', 'lng', 'prec'):
            if isinstance(req.get(k), (int, float)):
                ev[k] = req[k]
        if req.get('semLocal'):
            ev['semLocal'] = req['semLocal']
        eid = 'm' + uuid.uuid4().hex[:12]
        gravar(f'procedimentos/eventos/{dia}/{req["p"]}/{eid}', ev)
        return {'ok': True, 'id': eid, 'ts': cap, 'dia': dia}
    if acao == 'midia':
        if req.get('token') != 'mock':
            raise Erro('equipe')
        fid = req.get('id') or ''
        if fid.startswith('semente_'):
            return {'ok': True, 'mime': 'image/jpeg', 'b64': base64.b64encode(PIXEL).decode()}
        caminho = os.path.join(DADOS, os.path.basename(fid))
        if not os.path.exists(caminho):
            raise Erro('midia')
        with open(caminho, 'rb') as f, open(caminho + '.mime') as fm:
            return {'ok': True, 'mime': fm.read(), 'b64': base64.b64encode(f.read()).decode()}
    raise Erro('acao')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=RAIZ, **kw)

    def log_message(self, fmt, *args):
        if '/mock/db' not in (str(args[0]) if args else ''):
            sys.stderr.write('%s\n' % (fmt % args))

    def responder(self, obj, status=200):
        corpo = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def corpo(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n).decode('utf-8') if n else ''

    def caminho_db(self):
        return (parse_qs(urlparse(self.path).query).get('path') or [''])[0]

    def do_GET(self):
        if self.path.startswith('/mock/db'):
            return self.responder(pegar(self.caminho_db()))
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/mock/api'):
            try:
                return self.responder(api(json.loads(self.corpo() or '{}')))
            except Erro as e:
                return self.responder({'ok': False, 'erro': str(e)})
        self.send_error(404)

    def do_PUT(self):
        gravar(self.caminho_db(), json.loads(self.corpo() or 'null'))
        self.responder({'ok': True})

    def do_PATCH(self):
        atual = pegar(self.caminho_db())
        novo = json.loads(self.corpo() or '{}')
        if not isinstance(atual, dict):
            atual = {}
        atual.update(novo)
        gravar(self.caminho_db(), atual)
        self.responder({'ok': True})

    def do_DELETE(self):
        gravar(self.caminho_db(), None)
        self.responder({'ok': True})


if __name__ == '__main__':
    print(f'App QAP (teste) em http://localhost:{PORTA}/index.html?mock=1  | dados: {DADOS}')
    ThreadingHTTPServer(('127.0.0.1', PORTA), Handler).serve_forever()
