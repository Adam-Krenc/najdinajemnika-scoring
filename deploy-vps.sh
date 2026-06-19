#!/bin/bash
# Deploy script for najdinajemnika-scoring on VPS
# Run this ON the VPS: bash deploy-vps.sh

set -e

APP_DIR="/opt/najdinajemnika-scoring"
REPO="https://github.com/Adam-Krenc/najdinajemnika-scoring.git"

echo "=== NajdiNájemníka Scoring Service — Deploy ==="

# 1. Install Node.js 20 if not present
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 18 ]]; then
  echo "[1] Instaluji Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[1] Node.js $(node -v) již nainstalován ✓"
fi

# 2. Install PM2 globally
if ! command -v pm2 &> /dev/null; then
  echo "[2] Instaluji PM2..."
  npm install -g pm2
else
  echo "[2] PM2 $(pm2 -v) již nainstalován ✓"
fi

# 3. Clone or pull repo
if [ -d "$APP_DIR" ]; then
  echo "[3] Aktualizuji repozitář..."
  cd "$APP_DIR" && git pull
else
  echo "[3] Kloním repozitář..."
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

cd "$APP_DIR"

# 4. Install dependencies
echo "[4] Instaluji závislosti..."
npm ci --omit=dev
npm install  # includes devDeps for build

# 5. Generate Prisma client
echo "[5] Generuji Prisma klienta..."
npx prisma generate

# 6. Build TypeScript
echo "[6] Buildím TypeScript..."
npm run build

# 7. Create .env template if not exists
# DŮLEŽITÉ: do gitu NIKDY nepatří skutečné tajné údaje. Tento skript vytvoří
# pouze ŠABLONU s placeholdery — reálné hodnoty doplňte ručně na serveru
# (nebo je dodejte přes prostředí CI / secret manager).
if [ ! -f "$APP_DIR/.env" ]; then
  echo "[7] Vytvářím šablonu .env (doplňte skutečné hodnoty)..."
  cat > "$APP_DIR/.env" << 'ENVEOF'
ANTHROPIC_API_KEY=DOPLNIT
DATABASE_URL=DOPLNIT_postgresql_connection_string
WEBHOOK_SECRET=DOPLNIT_nahodny_min_32_znaku
PORT=3001
ENVEOF
  echo ""
  echo "⚠️  DOPLŇTE skutečné hodnoty v souboru $APP_DIR/.env !"
  echo "   - ANTHROPIC_API_KEY"
  echo "   - DATABASE_URL (připojení k Postgres)"
  echo "   - WEBHOOK_SECRET (vygenerujte: openssl rand -hex 32)"
  echo "   nano $APP_DIR/.env"
  echo ""
else
  echo "[7] .env soubor již existuje ✓"
fi

# 8. Start / restart with PM2
echo "[8] Spouštím s PM2..."
pm2 stop najdinajemnika-scoring 2>/dev/null || true
pm2 start "$APP_DIR/ecosystem.config.js"
pm2 save
pm2 startup 2>/dev/null || true

echo ""
echo "=== Deploy hotový! ==="
echo "Logy: pm2 logs najdinajemnika-scoring"
echo "Status: pm2 status"
echo "Health: curl http://localhost:3001/health"
