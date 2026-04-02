# Lottobot — Instrucoes para Claude Code

## Projeto
PWA de gerador analitico de loterias brasileiras (8 loterias). Arquivo unico `index.html` com HTML+CSS+JS inline. Firebase Hosting + Firestore + Functions. API: loteriascaixa-api.herokuapp.com.

## Deploy
Sempre apos mudancas, sem perguntar:
```bash
git add . && git commit -m "mensagem" && git push
npx firebase deploy --only hosting
```
O `git push` vai pro GitHub. O `firebase deploy` publica no site. Os dois sao necessarios.

## Versao do SW
Sempre manter sincronizados:
- `index.html` linha ~49: `var V='lottobot-vXX'`
- `service-worker.js` linha ~49: `const CACHE_NAME = 'lottobot-vXX'`
Incrementar ambos a cada deploy.

## Loterias configuradas
lotofacil, megasena, quina, duplasena, diadesorte, supersete, maismilionaria, timemania

## Particularidades
- **Super Sete**: `minNum:0`, `columns:true` — digitos 0-9, geracao por coluna (`genOneColumns`), permite duplicatas. Usar `dNum(n)` para display (digito unico).
- **+Milionaria**: `trevos:{total:6,pick:2}` — seletor de trevos, `getTrevos()`
- **Timemania**: `draw:7, pick:10` — jogador escolhe 10, sorteio tira 7. `getTimeCoracao()`
- **Dia de Sorte**: `meses:[...]` — seletor de mes da sorte, `getMesSorte()`
- **Dupla Sena**: 2 sorteios por concurso, `numeros2` no parseDraw
- `getMinNum()` usa `!== undefined` (nao `||`) porque 0 e falsy
- `getDrawSize()` retorna `draw || pick` para Timemania
- `dNum(n)` exibe digito unico para Super Sete, `pad(n)` para demais

## Anti-Jackpot
IndexedDB `lottobot_jackpots` (versao 4) armazena todos os resultados historicos. `isJackpotDuplicate(nums)` verifica em `gerarJogos()` e `gerarModoIA()`.

## Responsividade
- `100dvh` com fallback `100vh`
- `env(safe-area-inset-top/bottom)` no header, grid rows, nav, colunas
- `@media (display-mode: standalone)` para PWA instalada
- `overscroll-behavior: none`, `touch-action: manipulation`
- `manifest.json`: `orientation: portrait`
- Breakpoints: 1200px (tablet), 768px (mobile), 480px, 380px

## Idioma
Portugues brasileiro (pt-BR). Sem acentos no codigo JS. Acentos permitidos em meta tags HTML.

---

## Setup da maquina — MCP Servers e ferramentas

### MCP Servers necessarios (instalar via Claude Code settings)

1. **context7** — Documentacao de libs/frameworks
   ```
   npx -y @anthropic-ai/context7-mcp@latest
   ```

2. **playwright-official** — Automacao de browser para testes
   ```
   npx @anthropic-ai/mcp-playwright@latest
   ```

3. **accessibility** — Testes de acessibilidade e browser
   ```
   npx @anthropic-ai/mcp-accessibility@latest
   ```

4. **chrome-devtools** — DevTools, Lighthouse, performance
   ```
   npx @anthropic-ai/mcp-chrome-devtools@latest
   ```

5. **memory** — Grafo de memoria persistente
   ```
   npx @anthropic-ai/mcp-memory@latest
   ```

6. **sequential-thinking** — Raciocinio passo a passo
   ```
   npx @anthropic-ai/mcp-sequential-thinking@latest
   ```

7. **security** — Scan de seguranca
   ```
   npx @anthropic-ai/mcp-security@latest
   ```

8. **codacy** — Analise de qualidade de codigo
   ```
   npx @anthropic-ai/mcp-codacy@latest
   ```

### Plugins Claude Code

1. **ensue-auto-memory** — Memoria automatica entre sessoes
   ```
   Plugin: christinetyip/ensue-auto-memory
   ```
   > Nota: O hook `Stop` desse plugin causa erro de JSON validation. Se acontecer, editar `hooks.json` e mudar `"Stop": [...]` para `"Stop": []`.

### Ferramentas cloud conectadas (via claude.ai)
- **Canva** — Design e imagens
- **Gmail** — Email (precisa autenticar)
- **Google Calendar** — Calendario (precisa autenticar)

### Dependencias do projeto
```bash
npm install -g firebase-tools
firebase login
```

### Permissoes recomendadas (.claude/settings.local.json)
```json
{
  "permissions": {
    "allow": [
      "Bash(node -e \":*)"
    ]
  }
}
```
