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
        const title = bestHits >= 14
          ? `${bestHits} ACERTOS! Voce pode ter ganhado!`
          : `${bestHits} acertos no concurso ${drawId}!`;
        const body = bestHits >= 14
          ? `Premio estimado: ${prizeLabels[bestHits]}. Confira agora!`
          : `Seu jogo acertou ${bestHits} numeros (${prizeLabels[bestHits]}). Confira!`;

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
