# Front Security — App QAP (fase 1)

O QAP sai do grupo de WhatsApp e passa a ser enviado pela URL do posto:
- **QRA** (`qth.html?p=<posto>&k=<chave>`): entra com nome + PIN e envia QAP com **foto ou vídeo de 15 s tirados na hora** (sem galeria), **áudio de até 15 s**, observação e localização. A foto e o vídeo saem com uma faixa com posto, QRA, data/hora do servidor e coordenadas. O QRA não vê mídia de ninguém. Sem internet, o envio fica guardado no celular e sai sozinho depois.
- **Supervisão** (`index.html`, senha da equipe): cada posto em turno com o último QAP e o horário do próximo. Quando atrasa (intervalo + tolerância), o card **pisca**, **toca som** e sai **notificação** no navegador. Também mostra 3/6 que passou de 1h, o feed do dia com foto/vídeo/áudio (com marca d'água de quem está vendo), o link de cada posto e os PINs dos QRAs.

Mesma conta do QAP do fechamento (`../Limpar_WhatsApp/financeiro/falhas_qap.ps1`): QAP a cada 60 min, tolerância de 15 min, cada hora inteira sem QAP = 1h de falha, 3/6 = 1h. Só vale como QAP o envio com foto ou vídeo (ou a volta do 3/6).

## Onde fica cada coisa (tudo grátis)
| Peça | Onde |
|---|---|
| Telas | GitHub Pages (como QTI, Coberturas e Pagamentos) |
| Registros (quem, quando, onde) | Firebase `front-security-coberturas`, nó `procedimentos/` |
| Fotos, vídeos, áudios | Google Drive da conta `schiavolindaniel@gmail.com`, pasta **Front Security - QAP / <posto> / <dia>** (privada) |
| Backend | Google Apps Script na mesma conta (`apps-script/Code.gs`) |

## 1. Backend no Google Apps Script (uma vez)
1. Entre em https://script.google.com com a conta **schiavolindaniel@gmail.com** (a dona do Firebase) → **Novo projeto** → nome `Front Security QAP`.
2. ⚙️ **Configurações do projeto** → marque **"Mostrar arquivo de manifesto appsscript.json no editor"**.
3. No editor: apague o conteúdo de `Código.gs` e cole o de `apps-script/Code.gs`. Abra `appsscript.json` e troque tudo pelo de `apps-script/appsscript.json`. Salve (Ctrl+S).
4. No topo, escolha a função **testarConexao** → **Executar**. O Google pede autorização: **Revisar permissões** → escolha a conta → "O Google não verificou este app" → **Avançado** → **Acessar Front Security QAP (não seguro)** → **Permitir**. É o seu próprio script; ele pede Drive (guardar as mídias) e Firebase (gravar os registros).
   No registro de execução tem que aparecer `Firebase ok: N postos. Pasta no Drive: Front Security - QAP`.
5. **Implantar → Nova implantação** → ⚙️ tipo **App da Web** → *Executar como*: **Eu** · *Quem pode acessar*: **Qualquer pessoa** → **Implantar**. Copie a **URL do app da Web** (termina em `/exec`).
6. Cole essa URL em `config.js`, no `apiUrl`, e publique (ou mande a URL para o Claude fazer isso).

Para atualizar o Code.gs depois: cole o novo código → **Implantar → Gerenciar implantações** → ✏️ → *Versão*: **Nova versão** → **Implantar**. A URL não muda.

**Quanto tempo guardar as mídias:** `limparAntigos()` manda para a lixeira do Drive as pastas de dias com mais de 35 dias (`DIAS_GUARDAR` no Code.gs). Para rodar todo dia: ⏰ **Acionadores → Adicionar acionador** → função `limparAntigos` → *Baseado no tempo* → *Diário*. Sem isso, nada é apagado e o Drive (15 GB, junto com o Gmail) enche em 2 a 3 meses.

## 2. Regras do Firebase (uma vez, depois do passo 1)
Console → Realtime Database → **Regras** do `front-security-coberturas` → cole `../seguranca-firebase/regras-coberturas.json` → **Publicar**.
O nó novo `procedimentos/` só abre para a conta da equipe. A equipe edita config e PINs, mas não consegue apagar nem alterar QAP enviado: só o backend grava eventos.
O backup diário (`../seguranca-firebase/backup-diario.ps1`) já inclui `procedimentos/`. A mídia fica no Drive e não entra nesse backup.

## 3. Começar num posto
1. Abra o painel → toque no posto → **🔗 Criar link** → marque **Cobrar QAP neste posto**.
2. Aba **🔑 PINs dos QRAs** → **Gerar PIN** para cada QRA do posto (e para quem cobre) → passe o PIN só para ele.
3. No posto: **📱 Mandar no WhatsApp** (abre o WhatsApp com o texto pronto; você escolhe o grupo e envia).
4. Deixe o painel aberto no PC/celular da supervisão com **🔔 Ativar notificações** e o som ligado.

Comece por 1 ou 2 postos. A cobrança vem **desligada** em todos, para nenhum posto alarmar antes de usar o app.

## Limites da fase 1 (o que ainda não faz)
- **O alerta só sai com o painel aberto** em algum aparelho da supervisão (aba aberta; pode ficar em segundo plano). Alerta com tudo fechado (Telegram/push) é a fase 2.
- **Print:** navegador não bloqueia print. Nesta fase: o QRA não vê mídia nenhuma, a mídia é privada no Drive e o painel mostra marca d'água com quem está vendo. O bloqueio de verdade só existe no app Android instalado (fase 5).
- Cota grátis do Apps Script: cerca de 20 mil chamadas externas por dia. Cada QAP usa ~5, e cada abertura da tela do QRA ~6. Para ~250 QAPs/dia sobra bastante.
- Vídeo gravado em **WebM** (alguns Android) pode não tocar no **iPhone** da supervisão. MP4 é usado sempre que o celular do QRA permite.
- Raio do posto (QAP feito longe do QTH) e QTI 1h antes ainda não geram alerta: o mapa aparece em cada envio para conferir.

## Publicar uma versão nova
Aumente `APP_VERSION` em `painel.js` **e** em `qth.js` e o `v` do `version.json` (o mesmo valor). As telas abertas se atualizam sozinhas; a do QRA nunca recarrega com envio pendente.
Se mudar a regra de escala no Coberturas, copie de novo as linhas de helpers + `Schedule` para `escala.js`.

## Teste local (sem tocar no Firebase nem no Drive)
```
python teste/mock_server.py
```
Painel: http://localhost:8765/index.html?mock=1. Posto de teste **Teste 24h** (já começa atrasado), QRA **João Teste**, PIN **1234**. Sem câmera, o teste usa uma câmera e um microfone simulados.
Regras do QAP: `node teste/regras.test.js`.
