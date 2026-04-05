const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// ══════════════════════════════════════════════
// 1. CHECK FOR NEW DRAW — runs every 30 minutes
// ══════════════════════════════════════════════
exports.checkNewDraw = onSchedule({
  schedule: "every 30 minutes",
  timeZone: "America/Sao_Paulo",
  region: "southamerica-east1"
}, async () => {
  console.log("Checking for new draw...");
  try {
    const resp = await fetch("https://loteriascaixa-api.herokuapp.com/api/lotofacil/latest", {
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json();
    const numero = data.concurso || data.numero;
    if (!numero) { console.log("No draw number found"); return; }

    const drawRef = db.collection("draws").doc(String(numero));
    const exists = await drawRef.get();
    if (exists.exists) { console.log(`Draw ${numero} already exists`); return; }

    const numeros = (data.listaDezenas || data.dezenas || data.numeros || []).map(Number);
    if (numeros.length < 15) { console.log("Invalid draw data"); return; }

    await drawRef.set({
      numero,
      data: data.dataApuracao || data.data || "",
      numeros,
      fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false
    });
    console.log(`New draw ${numero} saved! Will trigger processDrawResults.`);
  } catch (e) {
    console.error("Error checking draw:", e.message);
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
  const drawId = parseInt(event.params.drawId);
  console.log(`Processing draw ${drawId} with numbers: ${draw.numeros}`);

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
        // Skip if already checked for this draw
        if (game.checkedDraws && game.checkedDraws.includes(drawId)) continue;

        const hits = (game.numbers || []).filter(n => drawNums.has(n)).length;
        if (hits > bestHits) { bestHits = hits; bestGameId = gameDoc.id; }

        // Mark as checked
        await gameDoc.ref.update({
          checkedDraws: admin.firestore.FieldValue.arrayUnion(drawId)
        });
      }

      // Send push if 11+ hits
      if (bestHits >= 11 && user.fcmTokens && user.fcmTokens.length > 0 && user.notificationsEnabled) {
        const prizeLabels = { 11: "R$ 6", 12: "R$ 12", 13: "R$ 30", 14: "R$ 1.700", 15: "JACKPOT!" };
        let title, body;
        if (bestHits >= 14) {
          title = `🏆 ${bestHits} ACERTOS! Voce pode ter ganhado!`;
          body = `Premio estimado: ${prizeLabels[bestHits]}. Confira agora! Se o Lottobot te ajudou, considere fazer uma doacao via PIX: lottobot.io@gmail.com`;
        } else {
          title = `🎯 ${bestHits} acertos no concurso ${drawId}!`;
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
              concurso: String(drawId),
              url: `/?notify=win&game=${bestGameId}&hits=${bestHits}`
            },
            webpush: {
              fcmOptions: { link: `/?notify=win&game=${bestGameId}&hits=${bestHits}` }
            }
          });
          notificationsSent++;

          // Clean up invalid tokens
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

  // Mark draw as processed
  await event.data.ref.update({ processed: true });

  // Log
  console.log(`Draw ${drawId} processed: ${processedUsers} users, ${notificationsSent} notifications sent`);
  await db.collection("notifications").add({
    type: "auto_draw_check",
    title: `Concurso ${drawId} processado`,
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

  // Send in batches of 500
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

  // Update notification status
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
// API key stored in Firestore: bets_meta/config { apiKey: "..." }
// Set manually in Firebase Console > Firestore > bets_meta > config
// TODO: adicionar gerenciamento da API key no painel admin (painel/index.html)

exports.fetchBetsOdds = onSchedule({
  schedule: "every 20 minutes",
  timeZone: "America/Sao_Paulo",
  region: "southamerica-east1"
}, async () => {
  // Read API key from Firestore config
  const configSnap = await db.collection("bets_meta").doc("config").get();
  const apiKey = configSnap.exists ? configSnap.data().apiKey : null;
  if (!apiKey) { console.error("ODDS_API_KEY not set. Add apiKey to bets_meta/config in Firestore."); return; }

  const now = Date.now();
  const metaRef = db.collection("bets_meta").doc("status");
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() : {};
  let creditsUsed = meta.creditsUsed || 0;
  let creditsRemaining = meta.creditsRemaining || 500;

  // Safety: stop if credits too low
  if (creditsRemaining < 20) {
    console.log("Credits too low (" + creditsRemaining + "), skipping");
    return;
  }

  // Decide which sports need refresh this cycle
  const sportsToFetch = [];
  for (const sport of BETS_SPORTS) {
    const oddsRef = db.collection("bets_odds").doc(sport.key);
    const oddsSnap = await oddsRef.get();
    const lastFetch = oddsSnap.exists && oddsSnap.data().fetchedAt ? oddsSnap.data().fetchedAt.toMillis() : 0;
    const age = now - lastFetch;

    // Dynamic intervals based on priority
    const intervals = {1: 18*60000, 2: 38*60000, 3: 58*60000};
    if (age >= (intervals[sport.priority] || 58*60000)) {
      sportsToFetch.push(sport);
    }
  }

  if (!sportsToFetch.length) { console.log("No sports need refresh"); return; }

  // Budget: priority 1 gets h2h+totals (2 credits), others get h2h only (1 credit)
  let fetchList = sportsToFetch;

  // If credits < 100, only priority 1
  if (creditsRemaining < 100) {
    fetchList = fetchList.filter(s => s.priority === 1);
  }
  // If credits < 50, reduce frequency (skip if fetched in last 40 min)
  if (creditsRemaining < 50) {
    const filtered = [];
    for (const s of fetchList) {
      const snap = await db.collection("bets_odds").doc(s.key).get();
      const last = snap.exists && snap.data().fetchedAt ? snap.data().fetchedAt.toMillis() : 0;
      if (now - last >= 38*60000) filtered.push(s);
    }
    fetchList = filtered;
  }

  if (!fetchList.length) { console.log("Budget constraints: no sports to fetch"); return; }

  console.log("Fetching " + fetchList.length + " sports: " + fetchList.map(s => s.key).join(", "));
  const errors = [];

  for (const sport of fetchList) {
    try {
      const markets = sport.priority === 1 ? "h2h,totals" : "h2h";
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

      // Filter: only games in next 48h
      const cutoff = now + 48*3600000;
      const upcoming = events.filter(e => {
        const t = new Date(e.commence_time).getTime();
        return t > now && t < cutoff;
      });

      // Detect value/sure bets
      const allValueBets = [];
      const allSureBets = [];
      upcoming.forEach(ev => {
        const vb = betsDetectValueBets(ev);
        const sb = betsDetectSureBets(ev);
        if (vb.length) allValueBets.push(...vb.map(v => ({...v,eventId:ev.id,home:ev.home_team,away:ev.away_team,commence:ev.commence_time})));
        if (sb.length) allSureBets.push(...sb.map(s => ({...s,eventId:ev.id,home:ev.home_team,away:ev.away_team,commence:ev.commence_time})));
      });

      // Save to Firestore
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

  // Update meta
  await metaRef.set({
    lastRun:admin.firestore.FieldValue.serverTimestamp(),
    creditsRemaining,creditsUsed,
    activeSports:fetchList.map(s => s.key),
    sportsCount:fetchList.length,
    errors:errors.slice(-10)
  },{merge:true});

  console.log("Bets fetch done. Credits: " + creditsRemaining);
});
