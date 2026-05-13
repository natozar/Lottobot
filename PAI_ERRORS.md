# Pai — Log de erros

Arquivo de tracking pra Claude. Cada erro novo entra como entrada. Status: 🔴 aberto / 🟡 em progresso / 🟢 corrigido.

Quando o Renato reportar um erro, Claude adiciona aqui com:
- Data
- Contexto (o que estava fazendo)
- Erro exato (texto/screenshot)
- Hipótese
- Status
- Fix (quando resolvido) + commit hash

Erros em runtime também são capturados automaticamente no localStorage `paiErrors` (últimos 20). Badge ⚠️ no canto da tela aparece quando há erros não vistos.

---

## Tabela rápida

| # | Data | Erro | Status | Versão fix |
|---|------|------|--------|------------|
| 1 | 2026-05-10 | SW cache chrome-extension fail | 🟢 fixed | v87 |
| 2 | 2026-05-10 | Card de filtros não aparecia | 🟢 fixed | v89 (estava no app errado) |
| 3 | 2026-05-10 | Banner do card cobrindo PIN | 🟢 fixed | v90 (revert NUCLEAR) |
| 4 | 2026-05-10 | Google login: storage partitioning entre lottobot.com.br ↔ firebaseapp.com | 🟢 fixed | v92 (authDomain = mesmo domain) |
| 5 | 2026-05-10 | FirebaseError: Missing or insufficient permissions | 🔴 aberto | — |
| 6 | 2026-05-10 | PWA start_url apontava pra / | 🟢 fixed | v88 (manifest-pai.json) |
| 7 | 2026-05-10 | Cache HTTP 1h em /pai | 🟢 fixed | v80 (regra explicita firebase.json) |
| 8 | 2026-05-10 | Welcome com 2 opções era fricção pro pai | 🟢 fixed | v92 (pula Welcome — acesso direto) |
| 9 | 2026-05-11 | redirect_uri_mismatch no Google login | 🟢 fixed | v93 (popup-only) |
| 10 | 2026-05-11 | API loteriascaixa retorna array em /lotofacil mas código esperava objeto | 🟢 fixed | v95 (usar /lotofacil/latest + normalizeResp) |
| 11 | 2026-05-11 | SW retornando null no fetch → 'Failed to convert value to Response' | 🟢 fixed | v95 (fallback Response sempre) |
| 12 | 2026-05-13 | REGRESSAO: storage partitioning Google login voltou (fix v92 perdido) | 🟢 fixed | v106 (re-aplicacao authDomain dinamico em index/pai/bets/admin) |
| 13 | 2026-05-13 | Google login nao mostra account chooser — re-loga conta errada automaticamente | 🟢 fixed | v107 (signOut antes de signInWithPopup + prompt:select_account no index) |

---

## Entradas detalhadas

### #1 — SW cache chrome-extension fail · 🟢 v87
**Erro**: `service-worker.js:155 Uncaught (in promise) TypeError: Failed to execute 'put' on 'Cache': Request scheme 'chrome-extension' is unsupported`

**Contexto**: Console no app principal `/`. Extensão do Chrome (provavelmente uBlock, LastPass ou similar) fazia requisição que o SW tentava cachear.

**Causa**: SW chamava `cache.put(request, clone)` sem filtrar scheme. Cache API só aceita http/https.

**Fix** (commit `dc7d37c`): adicionado `if (url.protocol !== 'http:' && url.protocol !== 'https:') return;` no início do fetch handler.

---

### #2 — Card de filtros não aparecia · 🟢 v89
**Erro**: Renato dizendo "não aparece o card" por 10 iterações.

**Contexto**: Construindo card em `paivencedor.html` mas Renato testando no app principal `/`.

**Causa raiz**: Renato estava na página errada. Console mostrava `(index):3060` e `general.js:205` — referências a `index.html`, não `paivencedor.html`. Welcome screen tinha "Entrar no LottoBot" como botão primário verde (levava pra `/`), e "Gerador especial 4 fatores" como secundário outline (era o que tinha o card).

**Fix** (commit `5fb2d4c`): invertidos os botões. "🎯 Gerador especial 4 fatores" virou primary. PWA do /pai instalada agora aponta start_url=/pai via `manifest-pai.json` separado.

**Lição**: confirmar visualmente onde o usuário está antes de iterar. Pedir screenshot/URL bar ao primeiro sintoma.

---

### #3 — Banner do card cobrindo PIN · 🟢 v90
**Erro**: "tela tem banner tampando outras coisas" — Renato no PIN screen via o filtersPanel sobrepondo.

**Contexto**: v85 NUCLEAR moveu `filtersPanel` pra ser filho direto de `<body>` com `position:fixed;top:0;z-index:999999`. Isso afetava TODAS as telas (PIN, Welcome, Loading), não só o Gerador.

**Causa**: `wireUI()` rodava o `document.body.appendChild(panel)` no boot, independente da tela ativa.

**Fix** (commit `d923ff5`): removido o move-to-body. Card volta a viver dentro de `#mainArea`. Quando PIN/Welcome estão visíveis, mainArea tem class `hidden` (display:none) e o card herda isso. Só aparece no Gerador.

---

### #4 — Google login: storage partitioning · 🟢 v92
**Erro EXATO reportado**:
> "Não foi possível processar a solicitação devido à falta do estado inicial. Isso pode ocorrer se o armazenamento de sessão do navegador estiver inacessível ou tiver sido apagado acidentalmente. Alguns cenários específicos são: 1) Uso de SSO SAML iniciado pelo IdP. 2) Uso de signInWithRedirect em um ambiente de navegador com armazenamento particionado."

**Contexto**: Renato tentando logar com conta Google no /pai (v90 botão "Entrar com Google" no PIN screen). Browsers modernos (Safari, Chrome com cookies bloqueados) particionam sessionStorage entre origins.

**Causa raiz**: paivencedor.html servido em `lottobot.com.br`. Firebase config tinha `authDomain: lottobot-8d75e.firebaseapp.com`. Fluxo do signInWithRedirect:
1. Pagina (lottobot.com.br) chama signInWithRedirect → Firebase salva estado em sessionStorage de lottobot.com.br
2. Redirect pra Google OAuth
3. Google redireciona pra lottobot-8d75e.firebaseapp.com/__/auth/handler
4. Handler tenta ler sessionStorage — mas com **storage partitioning ativo**, cada origin tem seu próprio storage
5. sessionStorage de firebaseapp.com está VAZIO (nunca foi escrito)
6. Erro: "falta do estado inicial"

**Fix** (commit pending v92): authDomain agora é dinâmico:
```js
authDomain: location.hostname === 'lottobot.com.br' || location.hostname === 'www.lottobot.com.br'
  ? location.hostname
  : 'lottobot-8d75e.firebaseapp.com'
```

Quando acessado em lottobot.com.br, authDomain é lottobot.com.br. Mesmo origin, sem partitioning, sessionStorage preservado.

**Pré-requisito**: lottobot.com.br precisa estar configurado em Firebase Console > Authentication > Settings > Authorized domains. Como o domain já serve a app via Firebase Hosting, isso deve estar feito automaticamente. Se não estiver, ir em console > Auth > Settings > Authorized domains > Add domain.

**Plus** (commit `83e96a2` ainda válido):
- Desktop: popup (mais robusto)
- Mobile: redirect
- Fallback popup→redirect se bloqueado
- Erros agora visíveis na tela

PIN 0606 funciona sempre como backup independente.

---

### #5 — FirebaseError: Missing or insufficient permissions · 🔴 aberto
**Erro**: `(index):5352 Log error: FirebaseError: Missing or insufficient permissions.`

**Contexto**: Console no app principal `/`. Algum log de uso (`logEvent` ou similar) tentando escrever no Firestore sem permissão.

**Hipótese**: Firestore rules bloqueando escrita anônima. O `logEvent` provavelmente escreve em `logs/` collection sem auth.

**Plano de fix** (próxima sessão):
1. Identificar onde está esse log no index.html
2. Ou autenticar antes do log (`auth.signInAnonymously`)
3. Ou ajustar Firestore rules pra permitir
4. Ou simplesmente fazer o log fail silenciosamente

---

### #6 — PWA start_url apontava pra / · 🟢 v88
**Erro**: Renato instalou PWA do /pai mas ela sempre abria `/index.html` (app principal).

**Causa**: `manifest.json` único pra todo o site, com `start_url: "./index.html"`. PWA instalada de /pai usava o mesmo manifest, então start_url herdado era index.

**Fix** (commit `28cf22d`): criado `manifest-pai.json` separado com `start_url: "/pai"`, `scope: "/pai"`, `id: "/lottobot-pai"`. paivencedor.html linka pra ele. Long-press do ícone vira "Pai 💚" distinta.

---

### #7 — Cache HTTP 1h em /pai · 🟢 v80
**Erro**: Mesmo com firebase.json tendo `paivencedor.html` com Cache-Control no-cache, o servidor respondia `/pai` com `max-age=3600`.

**Causa**: Firebase Hosting aplica headers baseado na URL da REQUISIÇÃO, não no destino do rewrite. Regra pra "paivencedor.html" não matchava com requisições a `/pai`. Default era 1h.

**Fix** (commit `44312fa`): adicionada regra explícita pra `source: "/pai"` com `Cache-Control: no-cache, no-store, must-revalidate` + Pragma + Expires.

---

### #12 — REGRESSAO authDomain (storage partitioning Google login) · 🟢 v106
**Erro EXATO reportado** (re-aparecimento do #4):
> "Não foi possível processar a solicitação devido à falta do estado inicial. Isso pode ocorrer se o armazenamento de sessão do navegador estiver inacessível ou tiver sido apagado acidentalmente."

**Contexto**: Renato 2026-05-13 tentando Google login no /pai.

**Causa**: O fix v92 (authDomain dinamico = location.hostname) foi perdido em algum commit posterior. Os 4 arquivos (index/paivencedor/bets/admin) voltaram pra `authDomain: "lottobot-8d75e.firebaseapp.com"` hardcoded. O popup do Google login carrega o handler em firebaseapp.com como third-party — sessionStorage e particionado por Chrome 115+ — handler nao acha o initial state.

**Fix** (v106): re-aplicado em index.html, paivencedor.html, bets.html, admin.html:
```js
authDomain:(function(){var h=location.hostname;return (h==='lottobot.com.br'||h==='www.lottobot.com.br'||/\.web\.app$/.test(h)||/\.firebaseapp\.com$/.test(h))?h:'lottobot-8d75e.firebaseapp.com'})()
```

Quando servido em lottobot.com.br, authDomain = lottobot.com.br. /__/auth/handler ja eh servido nesse dominio pelo Firebase Hosting (confirmado: GET retorna 200). Mesma origem do parent = sem partitioning = state preservado.

**Prevencao**: nao copiar/colar `authDomain:"lottobot-8d75e.firebaseapp.com"` em novos arquivos. Sempre usar a IIFE dinamica. Considerar mover pra um helper compartilhado.

---

### #13 — Google chooser nao aparece, re-loga conta errada · 🟢 v107
**Erro reportado**: "Ele nao deixa eu escolher qual e-mail quero usar."

**Contexto**: Renato 2026-05-13 em /pai. v106 corrigiu o storage partitioning,
o popup do Google agora abre. Mas quando ele clica "Entrar com Google", o
chooser de contas nao aparece — Google re-loga automaticamente a conta
errada (provavelmente conta nao-admin que ele tinha tentado antes).

**Causa raiz**: dois fatores combinados:
1. Firebase tem sessao persistida (`firebase.auth().currentUser` set) da
   tentativa anterior — onAuthStateChanged dispara imediatamente
2. Google OAuth, mesmo com prompt:select_account, as vezes pula o chooser
   quando ja ha consentimento recente e currentUser ativo

**Fix v107**: em paivencedor.html `handleGoogleLogin` E em index.html
`loginGoogle`:
- `firebase.auth().signOut()` ANTES de `signInWithPopup` (se houver currentUser)
- `prompt: 'select_account'` no provider (paivencedor ja tinha; index NAO)
- index tinha so signInWithPopup nu, sem prompt nem signOut

Sem signOut, Google OAuth ve que o usuario ja tem sessao Firebase+grant
recente e silenciosamente re-autentica a mesma conta, ignorando o prompt.
Com signOut, Firebase fica clean → Google reabre o chooser → user escolhe.

---

## Como ler este arquivo na próxima sessão

1. Olhar a tabela rápida pra ver erros abertos (🔴)
2. Ler entradas detalhadas dos erros 🔴 e 🟡
3. Verificar localStorage `paiErrors` no browser do Renato (via DevTools)
4. Priorizar fix por impacto e idade
5. Atualizar status conforme resolvido

## Como capturar novos erros

O paivencedor.html captura automaticamente:
- `window.onerror` — erros sincronos
- `window.onunhandledrejection` — promises rejeitadas

Stored em `localStorage['paiErrors']` (JSON array, últimos 20). Cada entrada:
```json
{
  "t": "2026-05-10T23:45:12.123Z",
  "msg": "Cannot read property 'x' of null",
  "src": "paivencedor.html:1234",
  "stack": "...",
  "url": "/pai",
  "ua": "Mozilla/5.0..."
}
```

Renato pode tocar no badge ⚠️ (canto inferior esquerdo) pra ver os erros. Botão "📋 Copiar tudo" copia o JSON pra clipboard, ele cola aqui.
