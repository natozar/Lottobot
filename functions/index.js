const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

const API_BASE = "https://loteriascaixa-api.herokuapp.com/api";

// ══════════════════════════════════════════════
// MAPA DE LOTERIAS
// ══════════════════════════════════════════════
const LOTERIAS = {
  'lotofacil':       { api: 'lotofacil',       nome: 'Lotofacil',       nomeFull: 'Lotofácil',       numeros: 25, pick: 15 },
  'mega-sena':       { api: 'megasena',        nome: 'Mega-Sena',       nomeFull: 'Mega-Sena',       numeros: 60, pick: 6 },
  'quina':           { api: 'quina',            nome: 'Quina',            nomeFull: 'Quina',            numeros: 80, pick: 5 },
  'dupla-sena':      { api: 'duplasena',        nome: 'Dupla Sena',      nomeFull: 'Dupla Sena',      numeros: 50, pick: 6 },
  'dia-de-sorte':    { api: 'diadesorte',       nome: 'Dia de Sorte',    nomeFull: 'Dia de Sorte',    numeros: 31, pick: 7 },
  'super-sete':      { api: 'supersete',        nome: 'Super Sete',      nomeFull: 'Super Sete',      numeros: 10, pick: 7 },
  'mais-milionaria': { api: 'maismilionaria',   nome: '+Milionaria',     nomeFull: '+Milionária',     numeros: 50, pick: 6 },
  'timemania':       { api: 'timemania',        nome: 'Timemania',       nomeFull: 'Timemania',       numeros: 80, pick: 10 }
};

// Mapa inverso: slug API → slug URL
const API_TO_URL_SLUG = {
  lotofacil: 'lotofacil',
  megasena: 'mega-sena',
  quina: 'quina',
  duplasena: 'dupla-sena',
  diadesorte: 'dia-de-sorte',
  supersete: 'super-sete',
  maismilionaria: 'mais-milionaria',
  timemania: 'timemania'
};

// ══════════════════════════════════════════════
// HELPERS — Fetch de dados da API
// ══════════════════════════════════════════════
async function fetchLatest(apiSlug) {
  const resp = await fetch(`${API_BASE}/${apiSlug}/latest`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) throw new Error(`API ${apiSlug}: ${resp.status}`);
  return resp.json();
}

async function fetchConcurso(apiSlug, numero) {
  const resp = await fetch(`${API_BASE}/${apiSlug}/${numero}`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) throw new Error(`API ${apiSlug}/${numero}: ${resp.status}`);
  return resp.json();
}

async function fetchHistorico(apiSlug, quantidade) {
  const latest = await fetchLatest(apiSlug);
  const concursoAtual = latest.concurso || latest.numero;
  const resultados = [latest];

  const promises = [];
  for (let i = 1; i < quantidade; i++) {
    promises.push(
      fetch(`${API_BASE}/${apiSlug}/${concursoAtual - i}`, {
        signal: AbortSignal.timeout(8000)
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    );
  }
  const extras = await Promise.all(promises);
  extras.forEach(r => { if (r) resultados.push(r); });

  return resultados;
}

// ══════════════════════════════════════════════
// HELPERS — Estatisticas
// ══════════════════════════════════════════════
function calcularEstatisticas(resultados, totalNumeros) {
  const freq = {};
  const minNum = totalNumeros === 10 ? 0 : 1;
  for (let i = minNum; i <= totalNumeros; i++) freq[i] = 0;

  resultados.forEach(r => {
    const nums = r.listaDezenas || r.dezenas || r.numeros || [];
    nums.forEach(n => { freq[Number(n)] = (freq[Number(n)] || 0) + 1; });
  });

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const quentes = sorted.slice(0, 10);
  const frios = sorted.slice(-10).reverse();

  const ultimoSorteio = resultados[0];
  const numsUltimo = new Set(
    (ultimoSorteio.listaDezenas || ultimoSorteio.dezenas || ultimoSorteio.numeros || []).map(Number)
  );

  return { freq, quentes, frios, numsUltimo, totalConcursos: resultados.length };
}

// ══════════════════════════════════════════════
// HELPERS — Blog (Firestore)
// ══════════════════════════════════════════════
async function buscarArtigosBlog(loteriaSlug, limite) {
  let query = db.collection('blog_posts')
    .orderBy('dataPublicacao', 'desc')
    .limit(limite);

  if (loteriaSlug) {
    query = query.where('loteria', '==', loteriaSlug);
  }

  const snap = await query.get();
  return snap.docs.map(d => d.data());
}

async function gerarArtigoBlog(drawData, loteriaSlug) {
  const loteria = LOTERIAS[loteriaSlug];
  if (!loteria) return;

  const concurso = drawData.concurso || drawData.numero;
  const numeros = (drawData.listaDezenas || drawData.dezenas || drawData.numeros || []).map(Number);
  const data = drawData.dataApuracao || drawData.data || '';

  let stats;
  try {
    const resultados = await fetchHistorico(loteria.api, 50);
    stats = calcularEstatisticas(resultados, loteria.numeros);
  } catch (e) {
    console.error(`Blog stats error for ${loteriaSlug}:`, e.message);
    stats = { quentes: [], frios: [], numsUltimo: new Set(), totalConcursos: 0 };
  }

  const pares = numeros.filter(n => n % 2 === 0).length;
  const impares = numeros.filter(n => n % 2 !== 0).length;
  const soma = numeros.reduce((a, b) => a + b, 0);
  const repetidos = numeros.filter(n => stats.numsUltimo.has(n)).length;

  const slug = `resultado-${loteriaSlug}-concurso-${concurso}`;
  const titulo = `Resultado ${loteria.nomeFull} Concurso ${concurso} — Analise Completa`;

  const conteudo = `
    <h1>${titulo}</h1>
    <p class="meta">Publicado em ${data} &middot; Atualizado automaticamente</p>

    <h2>Numeros Sorteados</h2>
    <div class="numeros-grid">
      ${numeros.map(n => `<span class="numero">${String(n).padStart(2,'0')}</span>`).join(' ')}
    </div>

    <h2>Analise do Concurso</h2>
    <ul>
      <li><strong>Soma dos numeros:</strong> ${soma}</li>
      <li><strong>Pares:</strong> ${pares} &middot; <strong>Impares:</strong> ${impares}</li>
      <li><strong>Numeros que repetiram do concurso anterior:</strong> ${repetidos} de ${numeros.length}</li>
    </ul>

    ${stats.totalConcursos > 0 ? `
    <h2>Numeros Quentes (mais frequentes nos ultimos ${stats.totalConcursos} concursos)</h2>
    <p>${stats.quentes.slice(0,10).map(([n,f]) => `<strong>${String(n).padStart(2,'0')}</strong> (${f}x)`).join(', ')}</p>

    <h2>Numeros Frios (menos frequentes)</h2>
    <p>${stats.frios.slice(0,10).map(([n,f]) => `<strong>${String(n).padStart(2,'0')}</strong> (${f}x)`).join(', ')}</p>
    ` : ''}

    <h2>Dica para o Proximo Concurso</h2>
    <p>Use o <a href="/">Lottobot</a> para gerar combinacoes inteligentes com filtros de paridade, soma, Fibonacci, espelho e mais. A IA analisa os padroes dos ultimos concursos para otimizar suas chances.</p>

    <div class="cta-box">
      <a href="/" class="cta-btn">Gerar Meus Numeros — Gratis</a>
    </div>
  `;

  await db.collection('blog_posts').doc(slug).set({
    slug,
    titulo,
    loteria: loteriaSlug,
    concurso,
    conteudo,
    data,
    dataPublicacao: admin.firestore.FieldValue.serverTimestamp(),
    metaDescription: `Resultado do concurso ${concurso} da ${loteria.nomeFull}: ${numeros.join(', ')}. Analise de frequencia, numeros quentes e frios. Gere combinacoes inteligentes no Lottobot.`,
    tags: [loteriaSlug, 'resultado', 'analise', `concurso-${concurso}`],
    numeros
  });

  console.log(`Blog post created: ${slug}`);
}

// ══════════════════════════════════════════════
// SSR TEMPLATES — CSS compartilhado
// ══════════════════════════════════════════════
const SSR_CSS = `
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',system-ui,-apple-system,sans-serif; background:#09090b; color:#fafafa; line-height:1.6; }
    .container { max-width:800px; margin:0 auto; padding:20px; }
    .nav-loterias { display:flex; gap:8px; overflow-x:auto; padding:12px 0; border-bottom:1px solid rgba(255,255,255,0.06); margin-bottom:24px; -webkit-overflow-scrolling:touch; }
    .nav-loterias a { color:#a1a1aa; text-decoration:none; padding:6px 14px; border-radius:8px; font-size:14px; white-space:nowrap; background:#18181b; transition:all .2s; }
    .nav-loterias a:hover, .nav-loterias a.active { color:#fafafa; background:#4a7c59; }
    .breadcrumbs { font-size:13px; color:#8a8a94; margin-bottom:16px; }
    .breadcrumbs a { color:#a1a1aa; text-decoration:none; }
    .breadcrumbs a:hover { color:#fafafa; }
    .resultado-card { background:#111113; border-radius:16px; padding:24px; margin-bottom:24px; border:1px solid rgba(255,255,255,0.06); }
    .resultado-card h1 { font-size:24px; margin-bottom:8px; }
    .resultado-card .concurso-info { color:#a1a1aa; font-size:14px; margin-bottom:16px; }
    .numeros-grid { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
    .numero { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; background:#4a7c59; color:#fff; }
    .acumulou { background:linear-gradient(135deg,#d4a853,#b8912e); padding:12px 20px; border-radius:12px; text-align:center; margin:16px 0; font-weight:600; font-size:18px; }
    .premiacoes { margin:16px 0; }
    .premiacoes table { width:100%; border-collapse:collapse; }
    .premiacoes th, .premiacoes td { padding:8px 12px; text-align:left; border-bottom:1px solid rgba(255,255,255,0.06); font-size:14px; }
    .premiacoes th { color:#a1a1aa; font-weight:500; }
    .stats-section { background:#111113; border-radius:16px; padding:24px; margin-bottom:24px; border:1px solid rgba(255,255,255,0.06); }
    .stats-section h2 { font-size:20px; margin-bottom:16px; }
    .nums-row { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
    .num-quente { background:rgba(239,68,68,0.2); color:#ef4444; padding:4px 10px; border-radius:6px; font-size:14px; font-weight:600; }
    .num-frio { background:rgba(59,130,246,0.2); color:#3b82f6; padding:4px 10px; border-radius:6px; font-size:14px; font-weight:600; }
    .cta-box { background:linear-gradient(135deg,#4a7c59,#3a6347); border-radius:16px; padding:32px; text-align:center; margin:32px 0; }
    .cta-box h2 { font-size:22px; margin-bottom:8px; }
    .cta-box p { color:rgba(255,255,255,0.8); margin-bottom:16px; }
    .cta-btn { display:inline-block; background:#fff; color:#09090b; padding:14px 32px; border-radius:12px; font-weight:700; font-size:16px; text-decoration:none; }
    .cta-btn:hover { background:#f0f0f0; }
    .blog-links { margin:24px 0; }
    .blog-links h3 { font-size:18px; margin-bottom:12px; }
    .blog-links a { display:block; color:#a1a1aa; text-decoration:none; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.04); }
    .blog-links a:hover { color:#4a7c59; }
    footer { text-align:center; color:#8a8a94; font-size:13px; padding:32px 0; border-top:1px solid rgba(255,255,255,0.06); margin-top:32px; }
    footer a { color:#a1a1aa; text-decoration:none; }
    footer a:hover { color:#fafafa; }
    .meta { color:#a1a1aa; font-size:14px; margin-bottom:16px; }
    .blog-article { background:#111113; border-radius:12px; padding:20px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.06); }
    .blog-article a { color:#fafafa; text-decoration:none; font-size:18px; font-weight:600; }
    .blog-article a:hover { color:#4a7c59; }
    .blog-article p { color:#a1a1aa; font-size:14px; margin-top:4px; }
    .freq-bar { display:flex; align-items:center; gap:8px; margin:4px 0; }
    .freq-bar .bar { height:20px; background:#4a7c59; border-radius:4px; min-width:4px; }
    .freq-bar .label { font-size:13px; color:#a1a1aa; min-width:40px; }
    .freq-bar .count { font-size:13px; color:#fafafa; }
    ul { margin:12px 0 12px 20px; }
    li { margin:4px 0; }
    @media(max-width:600px) {
      .numero { width:38px; height:38px; font-size:14px; }
      .resultado-card h1 { font-size:20px; }
      .cta-box { padding:24px 16px; }
    }
`;

function renderNav(activeSlug) {
  return `<nav class="nav-loterias">
    ${Object.entries(LOTERIAS).map(([slug, l]) =>
      `<a href="/${slug}"${slug === activeSlug ? ' class="active"' : ''}>${l.nomeFull}</a>`
    ).join('')}
  </nav>`;
}

function renderFooter() {
  const year = new Date().getFullYear();
  return `<footer>
    <p>&copy; ${year} Lottobot &mdash; Gerador Analitico de Loterias</p>
    <p style="margin-top:8px;">
      <a href="/">App</a> &middot;
      <a href="/blog">Blog</a> &middot;
      <a href="/lotofacil">Lotofacil</a> &middot;
      <a href="/mega-sena">Mega-Sena</a> &middot;
      <a href="/quina">Quina</a> &middot;
      <a href="/dupla-sena">Dupla Sena</a> &middot;
      <a href="/dia-de-sorte">Dia de Sorte</a> &middot;
      <a href="/super-sete">Super Sete</a> &middot;
      <a href="/mais-milionaria">+Milionaria</a> &middot;
      <a href="/timemania">Timemania</a>
    </p>
    <p style="margin-top:8px;font-size:12px;">
      O Lottobot e um gerador analitico. Nao realiza apostas. Para concorrer, registre seus jogos em uma loterica ou no app/site da Caixa.
    </p>
  </footer>`;
}

// ══════════════════════════════════════════════
// SSR — Pagina de Loteria
// ══════════════════════════════════════════════
function renderPaginaLoteria(loteria, dados, estatisticas, artigos) {
  const nums = (dados.listaDezenas || dados.dezenas || dados.numeros || []).map(n => String(n).padStart(2, '0'));
  const concurso = dados.concurso || dados.numero;
  const dataApuracao = dados.dataApuracao || dados.data || '';
  const acumulado = dados.acumulado || false;
  const valorAcumulado = dados.valorAcumuladoProximoConcurso || dados.valorAcumulado || 0;
  const premiacoes = dados.listaPremiacoes || dados.premiacoes || [];

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resultado ${loteria.nomeFull} Concurso ${concurso} &mdash; Analise e Numeros Quentes | Lottobot</title>
  <meta name="description" content="Resultado ${loteria.nomeFull} concurso ${concurso} de ${dataApuracao}. Numeros sorteados: ${nums.join(', ')}. Veja analise de frequencia, numeros quentes e frios, e gere combinacoes inteligentes.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://lottobot.com.br/${loteria.slug}">
  <meta property="og:title" content="Resultado ${loteria.nomeFull} #${concurso} &mdash; Lottobot">
  <meta property="og:description" content="Numeros sorteados: ${nums.join(', ')}. ${acumulado ? 'ACUMULOU! Proximo premio estimado: R$ ' + (valorAcumulado / 1e6).toFixed(1) + ' milhoes.' : 'Confira ganhadores e analise completa.'}">
  <meta property="og:url" content="https://lottobot.com.br/${loteria.slug}">
  <meta property="og:type" content="article">
  <meta property="og:image" content="https://lottobot.com.br/og-image.png">
  <meta property="og:locale" content="pt_BR">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Resultado ${loteria.nomeFull} #${concurso}">
  <meta name="twitter:description" content="Numeros: ${nums.join(', ')}. Analise completa no Lottobot.">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "Resultado ${loteria.nomeFull} Concurso ${concurso}",
    "description": "Resultado e analise estatistica do concurso ${concurso} da ${loteria.nomeFull}",
    "url": "https://lottobot.com.br/${loteria.slug}",
    "dateModified": "${new Date().toISOString()}",
    "publisher": {
      "@type": "Organization",
      "name": "Lottobot",
      "url": "https://lottobot.com.br"
    },
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type":"ListItem","position":1,"name":"Lottobot","item":"https://lottobot.com.br"},
        {"@type":"ListItem","position":2,"name":"${loteria.nomeFull}","item":"https://lottobot.com.br/${loteria.slug}"}
      ]
    }
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Qual o resultado da ${loteria.nomeFull} concurso ${concurso}?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Os numeros sorteados no concurso ${concurso} da ${loteria.nomeFull} foram: ${nums.join(', ')}. O sorteio foi realizado em ${dataApuracao}."
        }
      },
      {
        "@type": "Question",
        "name": "Quais os numeros que mais saem na ${loteria.nomeFull}?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Os numeros mais frequentes nos ultimos ${estatisticas.totalConcursos} concursos sao: ${estatisticas.quentes.slice(0, 5).map(q => q[0]).join(', ')}."
        }
      },
      {
        "@type": "Question",
        "name": "A ${loteria.nomeFull} acumulou?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "${acumulado ? 'Sim, o premio acumulou para o proximo concurso.' : 'Nao, houve ganhadores neste concurso.'}"
        }
      }
    ]
  }
  </script>
  <style>${SSR_CSS}</style>
</head>
<body>
<div class="container">
  ${renderNav(loteria.slug)}

  <div class="breadcrumbs">
    <a href="/">Lottobot</a> &rsaquo; <a href="/${loteria.slug}">${loteria.nomeFull}</a> &rsaquo; Concurso ${concurso}
  </div>

  <div class="resultado-card">
    <h1>Resultado ${loteria.nomeFull} &mdash; Concurso ${concurso}</h1>
    <div class="concurso-info">Sorteio realizado em ${dataApuracao}</div>

    <div class="numeros-grid">
      ${nums.map(n => `<div class="numero">${n}</div>`).join('')}
    </div>

    ${acumulado ? `<div class="acumulou">ACUMULOU! Proximo premio estimado: R$ ${Number(valorAcumulado).toLocaleString('pt-BR')}</div>` : ''}

    ${premiacoes.length > 0 ? `
    <div class="premiacoes">
      <table>
        <tr><th>Faixa</th><th>Ganhadores</th><th>Premio</th></tr>
        ${premiacoes.map(p => `<tr>
          <td>${p.descricao || p.faixa || ''}</td>
          <td>${p.ganhadores || 0}</td>
          <td>R$ ${Number(p.valorPremio || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
        </tr>`).join('')}
      </table>
    </div>` : ''}
  </div>

  <div class="stats-section">
    <h2>Numeros Quentes (mais sorteados)</h2>
    <p style="color:#a1a1aa;font-size:14px;margin-bottom:8px;">Baseado nos ultimos ${estatisticas.totalConcursos} concursos</p>
    <div class="nums-row">
      ${estatisticas.quentes.slice(0, 10).map(([n, f]) => `<span class="num-quente">${String(n).padStart(2, '0')} (${f}x)</span>`).join('')}
    </div>
  </div>

  <div class="stats-section">
    <h2>Numeros Frios (menos sorteados)</h2>
    <div class="nums-row">
      ${estatisticas.frios.slice(0, 10).map(([n, f]) => `<span class="num-frio">${String(n).padStart(2, '0')} (${f}x)</span>`).join('')}
    </div>
  </div>

  <div class="cta-box">
    <h2>Gere Seus Numeros Inteligentes</h2>
    <p>Use IA e filtros estatisticos avancados para criar combinacoes otimizadas.</p>
    <a href="/" class="cta-btn">Abrir Lottobot &mdash; Gratis</a>
  </div>

  ${artigos && artigos.length > 0 ? `
  <div class="blog-links">
    <h3>Analises Recentes</h3>
    ${artigos.slice(0, 5).map(a => `<a href="/blog/${a.slug}">${a.titulo} &mdash; ${a.data}</a>`).join('')}
  </div>` : ''}

  <div class="stats-section">
    <h2>Sobre a ${loteria.nomeFull}</h2>
    <p style="color:#a1a1aa;font-size:14px;line-height:1.8;">
      A ${loteria.nomeFull} e uma das loterias mais populares do Brasil, com sorteios regulares realizados pela Caixa Economica Federal.
      No concurso ${concurso}, os numeros sorteados foram ${nums.join(', ')}.
      ${acumulado ? 'O premio acumulou para o proximo concurso.' : 'Houve ganhadores neste concurso.'}
      Use o Lottobot para gerar combinacoes inteligentes baseadas em analise estatistica, filtros avancados e inteligencia artificial.
    </p>
  </div>

  ${renderFooter()}
</div>
</body>
</html>`;
}

// ══════════════════════════════════════════════
// SSR — Pagina de Estatisticas
// ══════════════════════════════════════════════
function renderPaginaEstatisticas(loteria, stats) {
  const maxFreq = stats.quentes.length > 0 ? stats.quentes[0][1] : 1;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Estatisticas ${loteria.nomeFull} &mdash; Numeros Quentes e Frios | Lottobot</title>
  <meta name="description" content="Estatisticas completas da ${loteria.nomeFull}. Numeros mais e menos sorteados nos ultimos ${stats.totalConcursos} concursos. Analise de frequencia para gerar jogos inteligentes.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://lottobot.com.br/${loteria.slug}/estatisticas">
  <meta property="og:title" content="Estatisticas ${loteria.nomeFull} &mdash; Lottobot">
  <meta property="og:description" content="Numeros mais e menos sorteados nos ultimos ${stats.totalConcursos} concursos da ${loteria.nomeFull}.">
  <meta property="og:url" content="https://lottobot.com.br/${loteria.slug}/estatisticas">
  <meta property="og:type" content="article">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "Estatisticas ${loteria.nomeFull}",
    "url": "https://lottobot.com.br/${loteria.slug}/estatisticas",
    "publisher": {"@type": "Organization", "name": "Lottobot"}
  }
  </script>
  <style>${SSR_CSS}</style>
</head>
<body>
<div class="container">
  ${renderNav(loteria.slug)}

  <div class="breadcrumbs">
    <a href="/">Lottobot</a> &rsaquo; <a href="/${loteria.slug}">${loteria.nomeFull}</a> &rsaquo; Estatisticas
  </div>

  <div class="resultado-card">
    <h1>Estatisticas da ${loteria.nomeFull}</h1>
    <div class="concurso-info">Baseado nos ultimos ${stats.totalConcursos} concursos</div>
  </div>

  <div class="stats-section">
    <h2>Top 10 &mdash; Numeros Mais Sorteados</h2>
    ${stats.quentes.slice(0, 10).map(([n, f]) => `
    <div class="freq-bar">
      <span class="label">${String(n).padStart(2, '0')}</span>
      <div class="bar" style="width:${Math.round((f / maxFreq) * 100)}%"></div>
      <span class="count">${f}x</span>
    </div>`).join('')}
  </div>

  <div class="stats-section">
    <h2>Top 10 &mdash; Numeros Menos Sorteados</h2>
    ${stats.frios.slice(0, 10).map(([n, f]) => `
    <div class="freq-bar">
      <span class="label">${String(n).padStart(2, '0')}</span>
      <div class="bar" style="width:${Math.max(Math.round((f / maxFreq) * 100), 5)}%;background:#3b82f6;"></div>
      <span class="count">${f}x</span>
    </div>`).join('')}
  </div>

  <div class="stats-section">
    <h2>Frequencia Completa</h2>
    <div class="nums-row" style="margin-top:12px;">
      ${Object.entries(stats.freq).sort((a,b) => b[1] - a[1]).map(([n, f]) => {
        const pct = f / maxFreq;
        const color = pct > 0.7 ? '#ef4444' : pct > 0.4 ? '#d4a853' : '#3b82f6';
        return `<span style="background:${color}22;color:${color};padding:4px 8px;border-radius:6px;font-size:13px;font-weight:600;">${String(n).padStart(2,'0')} (${f})</span>`;
      }).join('')}
    </div>
  </div>

  <div class="cta-box">
    <h2>Use Esses Dados a Seu Favor</h2>
    <p>O Lottobot usa analise estatistica e IA para gerar combinacoes inteligentes.</p>
    <a href="/" class="cta-btn">Abrir Lottobot &mdash; Gratis</a>
  </div>

  ${renderFooter()}
</div>
</body>
</html>`;
}

// ══════════════════════════════════════════════
// SSR — Blog Index
// ══════════════════════════════════════════════
async function renderBlogIndex(req, res) {
  const artigos = await buscarArtigosBlog(null, 30);

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog Lottobot &mdash; Analises e Resultados das Loterias</title>
  <meta name="description" content="Analises automaticas dos resultados da Lotofacil, Mega-Sena, Quina e mais. Numeros quentes, frios, tendencias e dicas.">
  <link rel="canonical" href="https://lottobot.com.br/blog">
  <meta property="og:title" content="Blog Lottobot &mdash; Analises de Loterias">
  <meta property="og:description" content="Analises automaticas de cada sorteio. Atualizado em tempo real.">
  <meta property="og:url" content="https://lottobot.com.br/blog">
  <meta property="og:type" content="website">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Blog",
    "name": "Blog Lottobot",
    "url": "https://lottobot.com.br/blog",
    "publisher": {"@type": "Organization", "name": "Lottobot"}
  }
  </script>
  <style>${SSR_CSS}</style>
</head>
<body>
<div class="container">
  ${renderNav('')}

  <div class="breadcrumbs">
    <a href="/">Lottobot</a> &rsaquo; Blog
  </div>

  <h1 style="font-size:28px;margin-bottom:8px;">Blog Lottobot</h1>
  <p style="color:#a1a1aa;margin-bottom:24px;">Analises automaticas de cada sorteio. Atualizado em tempo real.</p>

  ${artigos.length > 0 ? artigos.map(a => `
  <div class="blog-article">
    <a href="/blog/${a.slug}">${a.titulo}</a>
    <p>${a.data || ''} &middot; ${(LOTERIAS[a.loteria] || {}).nomeFull || a.loteria || ''}</p>
  </div>
  `).join('') : '<p style="color:#a1a1aa;">Nenhum artigo publicado ainda. Os artigos serao gerados automaticamente a cada novo sorteio.</p>'}

  <div class="cta-box">
    <h2>Gere Seus Numeros</h2>
    <p>Use IA para criar combinacoes inteligentes.</p>
    <a href="/" class="cta-btn">Abrir Lottobot</a>
  </div>

  ${renderFooter()}
</div>
</body>
</html>`;

  res.set('Cache-Control', 'public, max-age=1800');
  return res.status(200).send(html);
}

// ══════════════════════════════════════════════
// SSR — Blog Post
// ══════════════════════════════════════════════
async function renderBlogPost(req, res, slug) {
  const doc = await db.collection('blog_posts').doc(slug).get();
  if (!doc.exists) return res.redirect(301, '/blog');

  const post = doc.data();

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${post.titulo} | Lottobot</title>
  <meta name="description" content="${post.metaDescription || ''}">
  <link rel="canonical" href="https://lottobot.com.br/blog/${slug}">
  <meta property="og:title" content="${post.titulo}">
  <meta property="og:description" content="${post.metaDescription || ''}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://lottobot.com.br/blog/${slug}">
  <meta property="article:published_time" content="${post.data || ''}">
  <script type="application/ld+json">
  {
    "@context":"https://schema.org",
    "@type":"Article",
    "headline":"${post.titulo}",
    "datePublished":"${post.data || ''}",
    "author":{"@type":"Organization","name":"Lottobot"},
    "publisher":{"@type":"Organization","name":"Lottobot"}
  }
  </script>
  <style>${SSR_CSS}</style>
</head>
<body>
<div class="container">
  ${renderNav('')}

  <div class="breadcrumbs">
    <a href="/">Lottobot</a> &rsaquo; <a href="/blog">Blog</a> &rsaquo; ${post.titulo}
  </div>

  <article class="resultado-card">
    ${post.conteudo || ''}
  </article>

  <div class="cta-box">
    <h2>Gere Seus Numeros Inteligentes</h2>
    <p>Use IA e filtros estatisticos para criar combinacoes otimizadas.</p>
    <a href="/" class="cta-btn">Abrir Lottobot &mdash; Gratis</a>
  </div>

  ${renderFooter()}
</div>
</body>
</html>`;

  res.set('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(html);
}

// ══════════════════════════════════════════════
// SSR — Sitemap
// ══════════════════════════════════════════════
async function renderSitemap(req, res) {
  let artigos = [];
  try {
    artigos = await buscarArtigosBlog(null, 200);
  } catch (e) {
    console.error('Sitemap blog fetch error:', e.message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://lottobot.com.br/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>https://lottobot.com.br/blog</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  ${Object.keys(LOTERIAS).map(slug => `
  <url><loc>https://lottobot.com.br/${slug}</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>https://lottobot.com.br/${slug}/estatisticas</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`).join('')}
  ${artigos.map(a => `
  <url><loc>https://lottobot.com.br/blog/${a.slug}</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>`).join('')}
</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(xml);
}

// ══════════════════════════════════════════════
// 0. SSR PAGES — HTTP Function
// ══════════════════════════════════════════════
exports.ssrPages = onRequest({
  region: "southamerica-east1",
  memory: "256MiB",
  timeoutSeconds: 30,
  cors: false
}, async (req, res) => {
  const path = req.path.replace(/\/+$/, '') || '/';

  try {
    // ─── SITEMAP ───
    if (path === '/sitemap.xml') {
      return renderSitemap(req, res);
    }

    // ─── BLOG ───
    if (path === '/blog') {
      return renderBlogIndex(req, res);
    }
    if (path.startsWith('/blog/')) {
      const slug = path.replace('/blog/', '');
      return renderBlogPost(req, res, slug);
    }

    // ─── PAGINAS DE LOTERIA ───
    const parts = path.split('/').filter(Boolean);
    const loteriaSlug = parts[0];

    if (LOTERIAS[loteriaSlug]) {
      const loteria = { ...LOTERIAS[loteriaSlug], slug: loteriaSlug };

      // /lotofacil/concurso/3245
      if (parts[1] === 'concurso' && parts[2]) {
        const dados = await fetchConcurso(loteria.api, parts[2]);
        const resultados = await fetchHistorico(loteria.api, 50);
        const stats = calcularEstatisticas(resultados, loteria.numeros);
        let artigos = [];
        try { artigos = await buscarArtigosBlog(loteriaSlug, 5); } catch (e) { /* ok */ }
        const html = renderPaginaLoteria(loteria, dados, stats, artigos);
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        return res.status(200).send(html);
      }

      // /lotofacil/estatisticas
      if (parts[1] === 'estatisticas') {
        const resultados = await fetchHistorico(loteria.api, 100);
        const stats = calcularEstatisticas(resultados, loteria.numeros);
        const html = renderPaginaEstatisticas(loteria, stats);
        res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
        return res.status(200).send(html);
      }

      // /lotofacil (ultimo resultado)
      const dados = await fetchLatest(loteria.api);
      const resultados = await fetchHistorico(loteria.api, 50);
      const stats = calcularEstatisticas(resultados, loteria.numeros);
      let artigos = [];
      try { artigos = await buscarArtigosBlog(loteriaSlug, 5); } catch (e) { /* ok */ }
      const html = renderPaginaLoteria(loteria, dados, stats, artigos);
      res.set('Cache-Control', 'public, max-age=1800, s-maxage=1800');
      return res.status(200).send(html);
    }

    // Rota nao encontrada
    return res.redirect(301, '/');

  } catch (err) {
    console.error('SSR Error:', err.message);
    res.status(500).send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Erro &mdash; Lottobot</title><style>${SSR_CSS}</style></head><body><div class="container"><h1 style="margin:40px 0 16px;">Erro temporario</h1><p style="color:#a1a1aa;">Tente novamente em instantes.</p><a href="/" style="color:#4a7c59;">Ir para o Lottobot</a>${renderFooter()}</div></body></html>`);
  }
});

// ══════════════════════════════════════════════
// 1. CHECK FOR NEW DRAW — runs every 30 minutes
//    Now checks ALL 8 lotteries + generates blog posts
// ══════════════════════════════════════════════
exports.checkNewDraw = onSchedule({
  schedule: "every 30 minutes",
  timeZone: "America/Sao_Paulo",
  region: "southamerica-east1"
}, async () => {
  console.log("Checking for new draws (all lotteries)...");

  const loteriasParaVerificar = [
    { slug: 'lotofacil', api: 'lotofacil' },
    { slug: 'megasena', api: 'megasena' },
    { slug: 'quina', api: 'quina' },
    { slug: 'duplasena', api: 'duplasena' },
    { slug: 'diadesorte', api: 'diadesorte' },
    { slug: 'supersete', api: 'supersete' },
    { slug: 'maismilionaria', api: 'maismilionaria' },
    { slug: 'timemania', api: 'timemania' }
  ];

  for (const lot of loteriasParaVerificar) {
    try {
      const resp = await fetch(`${API_BASE}/${lot.api}/latest`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) { console.log(`${lot.slug}: API returned ${resp.status}`); continue; }
      const data = await resp.json();
      const numero = data.concurso || data.numero;
      if (!numero) continue;

      const docId = `${lot.slug}_${numero}`;
      const drawRef = db.collection("draws").doc(docId);
      const exists = await drawRef.get();
      if (exists.exists) continue;

      const numeros = (data.listaDezenas || data.dezenas || data.numeros || []).map(Number);

      await drawRef.set({
        numero,
        loteria: lot.slug,
        data: data.dataApuracao || data.data || "",
        numeros,
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        processed: false
      });

      // Gerar artigo de blog automaticamente
      const urlSlug = API_TO_URL_SLUG[lot.api] || lot.slug;
      try {
        await gerarArtigoBlog(data, urlSlug);
        console.log(`New draw: ${lot.slug} #${numero} — blog post created`);
      } catch (blogErr) {
        console.error(`Blog gen error for ${lot.slug} #${numero}:`, blogErr.message);
        console.log(`New draw: ${lot.slug} #${numero} — saved (blog failed)`);
      }
    } catch (e) {
      console.error(`Error checking ${lot.slug}:`, e.message);
    }
  }
});

// ══════════════════════════════════════════════
// 2. PROCESS DRAW — triggered when new draw is created
//    Checks all users' saved games and sends push for 11+ hits
// ══════════════════════════════════════════════
exports.processDrawResults = onDocumentCreated({
  document: "draws/{drawId}",
  region: "southamerica-east1"
}, async (event) => {
  const draw = event.data.data();
  const drawNums = new Set(draw.numeros);
  const drawId = event.params.drawId;
  const drawNumero = draw.numero || parseInt(drawId);
  console.log(`Processing draw ${drawId} with numbers: ${draw.numeros}`);

  // Only process Lotofacil for push notifications (game checking)
  // Other lotteries: draw is saved + blog generated by checkNewDraw
  const loteria = draw.loteria || 'lotofacil';
  if (loteria !== 'lotofacil') {
    await event.data.ref.update({ processed: true });
    console.log(`Draw ${drawId} (${loteria}) — no game checking for this lottery`);
    return;
  }

  let processedUsers = 0;
  let notificationsSent = 0;
  let lastDoc = null;

  while (true) {
    let query = db.collection("users").limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    lastDoc = snap.docs[snap.docs.length - 1];

    for (const userDoc of snap.docs) {
      const user = userDoc.data();
      processedUsers++;

      const gamesSnap = await userDoc.ref.collection("savedGames").get();
      if (gamesSnap.empty) continue;

      let bestHits = 0;
      let bestGameId = null;

      for (const gameDoc of gamesSnap.docs) {
        const game = gameDoc.data();
        if (game.checkedDraws && game.checkedDraws.includes(drawNumero)) continue;

        const hits = (game.numbers || []).filter(n => drawNums.has(n)).length;
        if (hits > bestHits) { bestHits = hits; bestGameId = gameDoc.id; }

        await gameDoc.ref.update({
          checkedDraws: admin.firestore.FieldValue.arrayUnion(drawNumero)
        });
      }

      if (bestHits >= 11 && user.fcmTokens && user.fcmTokens.length > 0 && user.notificationsEnabled) {
        const prizeLabels = { 11: "R$ 6", 12: "R$ 12", 13: "R$ 30", 14: "R$ 1.700", 15: "JACKPOT!" };
        let title, body;
        if (bestHits >= 14) {
          title = `${bestHits} ACERTOS! Voce pode ter ganhado!`;
          body = `Premio estimado: ${prizeLabels[bestHits]}. Confira agora! Se o Lottobot te ajudou, considere fazer uma doacao via PIX: lottobot.io@gmail.com`;
        } else {
          title = `${bestHits} acertos no concurso ${drawNumero}!`;
          body = `Seu jogo acertou ${bestHits} numeros (${prizeLabels[bestHits]}). Confira! Gostou do Lottobot? Apoie via PIX: lottobot.io@gmail.com`;
        }

        try {
          const result = await messaging.sendEachForMulticast({
            tokens: user.fcmTokens,
            notification: { title, body },
            data: {
              type: "win",
              hits: String(bestHits),
              gameId: bestGameId || "",
              concurso: String(drawNumero),
              url: `/?notify=win&game=${bestGameId}&hits=${bestHits}`
            },
            webpush: {
              fcmOptions: { link: `/?notify=win&game=${bestGameId}&hits=${bestHits}` }
            }
          });
          notificationsSent++;

          const invalidTokens = [];
          result.responses.forEach((r, i) => {
            if (!r.success && (r.error?.code === "messaging/registration-token-not-registered" || r.error?.code === "messaging/invalid-registration-token")) {
              invalidTokens.push(user.fcmTokens[i]);
            }
          });
          if (invalidTokens.length > 0) {
            await userDoc.ref.update({
              fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
            });
          }
        } catch (e) {
          console.error(`FCM error for user ${userDoc.id}:`, e.message);
        }
      }
    }
  }

  await event.data.ref.update({ processed: true });

  console.log(`Draw ${drawId} processed: ${processedUsers} users, ${notificationsSent} notifications sent`);
  await db.collection("notifications").add({
    type: "auto_draw_check",
    title: `Concurso ${drawNumero} processado`,
    body: `${processedUsers} usuarios verificados, ${notificationsSent} notificacoes enviadas`,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    sentBy: "system",
    recipientCount: notificationsSent
  });
});

// ══════════════════════════════════════════════
// 3. ADMIN BROADCAST — triggered when admin creates notification with status=pending
// ══════════════════════════════════════════════
exports.sendAdminBroadcast = onDocumentCreated({
  document: "notifications/{notifId}",
  region: "southamerica-east1"
}, async (event) => {
  const notif = event.data.data();
  if (notif.type !== "admin_broadcast" || notif.status !== "pending") return;

  const { title, body, tokens } = notif;
  if (!tokens || !tokens.length || !title) return;

  console.log(`Sending admin broadcast to ${tokens.length} tokens...`);
  let successCount = 0;

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const result = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        webpush: {
          fcmOptions: { link: "/" }
        }
      });
      successCount += result.successCount;
    } catch (e) {
      console.error("Broadcast batch error:", e.message);
    }
  }

  await event.data.ref.update({
    status: "sent",
    successCount,
    processedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`Admin broadcast sent: ${successCount}/${tokens.length} successful`);
});

// ══════════════════════════════════════════════
// 4. BETS SCANNER — fetch odds, detect value/sure bets
// ══════════════════════════════════════════════

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

const BETS_SPORTS = [
  {key:"soccer_brazil_serie_a",name:"Brasileirao Serie A",priority:1,flag:"BR"},
  {key:"soccer_brazil_serie_b",name:"Brasileirao Serie B",priority:1,flag:"BR"}
];

// --- Value Bet Detection ---
function impliedProb(odd) { return 1 / odd; }

function betsDetectValueBets(event) {
  const valueBets = [];
  const allOutcomes = {};
  event.bookmakers.forEach(bk => {
    bk.markets.forEach(mkt => {
      mkt.outcomes.forEach(out => {
        const key = mkt.key + "|" + out.name + (out.point != null ? "|" + out.point : "");
        if (!allOutcomes[key]) allOutcomes[key] = [];
        allOutcomes[key].push({bookmaker:bk.title,bookmakerKey:bk.key,price:out.price,market:mkt.key,name:out.name,point:out.point});
      });
    });
  });
  Object.entries(allOutcomes).forEach(([key, odds]) => {
    if (odds.length < 2) return;
    const avgImplied = odds.reduce((s, o) => s + impliedProb(o.price), 0) / odds.length;
    const fairOdd = 1 / avgImplied;
    odds.forEach(o => {
      const edge = ((o.price - fairOdd) / fairOdd) * 100;
      if (edge > 3) {
        valueBets.push({
          bookmaker:o.bookmaker,bookmakerKey:o.bookmakerKey,market:o.market,
          outcome:o.name,point:o.point||null,price:o.price,
          fairOdd:Math.round(fairOdd*100)/100,
          edge:Math.round(edge*10)/10,
          confidence:odds.length>=4?"alta":odds.length>=3?"media":"baixa"
        });
      }
    });
  });
  return valueBets.sort((a, b) => b.edge - a.edge);
}

// --- Sure Bet Detection ---
function betsDetectSureBets(event) {
  const sureBets = [];
  ["h2h","totals"].forEach(mktKey => {
    const bestByOutcome = {};
    event.bookmakers.forEach(bk => {
      const mkt = bk.markets.find(m => m.key === mktKey);
      if (!mkt) return;
      mkt.outcomes.forEach(out => {
        const oKey = out.name + (out.point != null ? "|" + out.point : "");
        if (!bestByOutcome[oKey] || out.price > bestByOutcome[oKey].price) {
          bestByOutcome[oKey] = {name:out.name,point:out.point||null,price:out.price,bookmaker:bk.title,bookmakerKey:bk.key};
        }
      });
    });
    const bestOdds = Object.values(bestByOutcome);
    if (bestOdds.length < 2) return;
    const totalImplied = bestOdds.reduce((s, o) => s + 1 / o.price, 0);
    if (totalImplied < 1) {
      const profit = Math.round(((1 / totalImplied) - 1) * 1000) / 10;
      sureBets.push({
        market:mktKey,profit,totalImplied:Math.round(totalImplied*10000)/10000,
        outcomes:bestOdds.map(o => ({...o,stake:Math.round((1/o.price)/totalImplied*1000)/10}))
      });
    }
  });
  return sureBets;
}

// --- Scheduled fetcher ---
exports.fetchBetsOdds = onSchedule({
  schedule: "every 10 minutes",
  timeZone: "America/Sao_Paulo",
  region: "southamerica-east1"
}, async () => {
  const configSnap = await db.collection("bets_meta").doc("config").get();
  const apiKey = configSnap.exists ? configSnap.data().apiKey : null;
  if (!apiKey) { console.error("ODDS_API_KEY not set. Add apiKey to bets_meta/config in Firestore."); return; }

  const now = Date.now();
  const metaRef = db.collection("bets_meta").doc("status");
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() : {};
  let creditsUsed = meta.creditsUsed || 0;
  let creditsRemaining = meta.creditsRemaining || 500;

  if (creditsRemaining < 20) {
    console.log("Credits too low (" + creditsRemaining + "), skipping");
    return;
  }

  const H = 3600000;
  const sportsToFetch = [];
  const sportNearestGame = {};

  for (const sport of BETS_SPORTS) {
    const oddsRef = db.collection("bets_odds").doc(sport.key);
    const oddsSnap = await oddsRef.get();
    const oddsData = oddsSnap.exists ? oddsSnap.data() : null;
    const lastFetch = oddsData?.fetchedAt?.toMillis() || 0;
    const age = now - lastFetch;

    let nearestGame = Infinity;
    if (oddsData && oddsData.events) {
      oddsData.events.forEach(ev => {
        const gameTime = new Date(ev.commence).getTime();
        const diff = gameTime - now;
        if (diff > 0 && diff < nearestGame) nearestGame = diff;
      });
    }

    let minInterval;
    if (!oddsData) {
      minInterval = 0;
    } else if (nearestGame < 2 * H) {
      minInterval = 25 * 60000;
    } else if (nearestGame < 24 * H) {
      minInterval = 110 * 60000;
    } else {
      minInterval = 480 * 60000;
    }

    if (age >= minInterval) {
      sportsToFetch.push(sport);
      sportNearestGame[sport.key] = nearestGame;
    }
  }

  if (!sportsToFetch.length) { console.log("No sports need refresh"); return; }

  let fetchList = sportsToFetch;

  if (creditsRemaining < 50) {
    const filtered = [];
    for (const s of fetchList) {
      const snap = await db.collection("bets_odds").doc(s.key).get();
      const last = snap.exists && snap.data().fetchedAt ? snap.data().fetchedAt.toMillis() : 0;
      if (now - last >= 110 * 60000) filtered.push(s);
    }
    fetchList = filtered;
  } else if (creditsRemaining < 100) {
    const filtered = [];
    for (const s of fetchList) {
      const snap = await db.collection("bets_odds").doc(s.key).get();
      const last = snap.exists && snap.data().fetchedAt ? snap.data().fetchedAt.toMillis() : 0;
      if (now - last >= 55 * 60000) filtered.push(s);
    }
    fetchList = filtered;
  }

  if (!fetchList.length) { console.log("Budget constraints: no sports to fetch"); return; }

  console.log("Fetching " + fetchList.length + " sports: " + fetchList.map(s => s.key).join(", ") + " | Credits: " + creditsRemaining);
  const errors = [];

  for (const sport of fetchList) {
    try {
      const nearest = sportNearestGame[sport.key] || Infinity;
      const markets = (nearest < 2 * H) ? "h2h,totals" : "h2h";
      const url = ODDS_API_BASE + "/sports/" + sport.key + "/odds/?apiKey=" + apiKey + "&regions=eu&markets=" + markets + "&oddsFormat=decimal";
      const resp = await fetch(url, {signal: AbortSignal.timeout(15000)});

      const rem = resp.headers.get("x-requests-remaining");
      if (rem) creditsRemaining = parseInt(rem);
      const used = resp.headers.get("x-requests-used");
      if (used) creditsUsed = parseInt(used);

      if (!resp.ok) {
        errors.push({sport:sport.key,status:resp.status,time:new Date().toISOString()});
        continue;
      }

      const events = await resp.json();

      const cutoff = now + 48*3600000;
      const upcoming = events.filter(e => {
        const t = new Date(e.commence_time).getTime();
        return t > now && t < cutoff;
      });

      const allValueBets = [];
      const allSureBets = [];
      upcoming.forEach(ev => {
        const vb = betsDetectValueBets(ev);
        const sb = betsDetectSureBets(ev);
        if (vb.length) allValueBets.push(...vb.map(v => ({...v,eventId:ev.id,home:ev.home_team,away:ev.away_team,commence:ev.commence_time})));
        if (sb.length) allSureBets.push(...sb.map(s => ({...s,eventId:ev.id,home:ev.home_team,away:ev.away_team,commence:ev.commence_time})));
      });

      await db.collection("bets_odds").doc(sport.key).set({
        sportKey:sport.key,sportName:sport.name,flag:sport.flag,priority:sport.priority,
        events:upcoming.map(e => ({
          id:e.id,home:e.home_team,away:e.away_team,commence:e.commence_time,
          bookmakers:e.bookmakers.map(bk => ({key:bk.key,title:bk.title,markets:bk.markets}))
        })),
        valueBets:allValueBets,sureBets:allSureBets,
        eventCount:upcoming.length,valueBetCount:allValueBets.length,sureBetCount:allSureBets.length,
        fetchedAt:admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(sport.key + ": " + upcoming.length + " events, " + allValueBets.length + " VB, " + allSureBets.length + " SB");
    } catch (e) {
      errors.push({sport:sport.key,error:e.message,time:new Date().toISOString()});
      console.error("Error " + sport.key + ": " + e.message);
    }
  }

  await metaRef.set({
    lastRun:admin.firestore.FieldValue.serverTimestamp(),
    creditsRemaining,creditsUsed,
    activeSports:fetchList.map(s => s.key),
    sportsCount:fetchList.length,
    errors:errors.slice(-10)
  },{merge:true});

  console.log("Bets fetch done. Credits: " + creditsRemaining);
});
