#!/bin/bash
# ══════════════════════════════════════════════
# LOTTOBOT SETUP — rode apos 'firebase login'
# ══════════════════════════════════════════════

echo "=== Lottobot Setup ==="
echo ""

# 1. Deploy Firestore rules
echo "[1/3] Deploying Firestore rules..."
firebase deploy --only firestore:rules --project lottobot-8d75e
echo ""

# 2. Deploy Cloud Functions
echo "[2/3] Deploying Cloud Functions..."
firebase deploy --only functions --project lottobot-8d75e
echo ""

# 3. Set admin user
echo "[3/3] Setting up admin user..."
echo "Apos fazer login no app (lottobot), copie seu UID do Firebase Console:"
echo "  Firebase Console > Authentication > Users > copie o UID"
echo ""
read -p "Cole seu UID aqui: " ADMIN_UID

if [ -n "$ADMIN_UID" ]; then
  # Use Firebase Admin SDK via a small Node script
  node -e "
    const admin = require('firebase-admin');
    admin.initializeApp({ projectId: 'lottobot-8d75e' });
    admin.firestore().collection('users').doc('$ADMIN_UID').set(
      { isAdmin: true },
      { merge: true }
    ).then(() => {
      console.log('Admin configurado com sucesso para UID: $ADMIN_UID');
      process.exit(0);
    }).catch(e => {
      console.error('Erro:', e.message);
      process.exit(1);
    });
  "
fi

echo ""
echo "=== Setup completo! ==="
echo "Acesse admin.html para gerenciar o Lottobot."
