# Lightweight Production Deployment

The simplest production stack for BotHub: **1 container + 2 managed services**.

```
┌────────────────────────────────────┐
│  Railway or Fly.io                 │
│  (Fastify: API + Frontend)         │
│  ~512MB RAM, 1 shared CPU          │
└──────────┬──────────┬──────────────┘
           │          │
    ┌──────▼───┐  ┌───▼──────────┐
    │ Supabase │  │ Upstash      │
    │ Postgres │  │ Redis        │
    │ +pgvector│  │ (serverless) │
    └──────────┘  └──────────────┘
```

**Cost: $0/mo on free tiers, ~$10-25/mo when you outgrow them.**

No infrastructure to manage. No VPS. No Docker Compose in production.

---

## Step 1: Set Up Supabase (Database)

1. Go to [supabase.com](https://supabase.com) and create a project
2. Note your **database connection string** from Settings → Database → Connection string (URI)
   - Use the "Session mode" connection string (port 5432) for migrations
   - Use the "Transaction mode" connection string (port 6543) for the app if you expect high connection counts
3. Enable pgvector: go to Database → Extensions → search "vector" → enable it
4. Run migrations against your Supabase database:

```bash
DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres" \
  npm run migrate
```

**Free tier includes:** 500MB database, 2 projects, 50K monthly active auth users.

---

## Step 2: Set Up Upstash Redis

1. Go to [upstash.com](https://upstash.com) and create a Redis database
2. Select the region closest to your Railway/Fly deployment
3. Copy the **Redis connection string** (starts with `rediss://`)

**Free tier includes:** 10K commands/day, 256MB storage.

---

## Step 3a: Deploy to Railway (Recommended)

Railway is the simplest option. It detects the Dockerfile and deploys automatically.

1. Install the Railway CLI:
```bash
npm install -g @railway/cli
railway login
```

2. Create a new project and link it:
```bash
railway init
railway link
```

3. Set environment variables:
```bash
railway variables set NODE_ENV=production
railway variables set DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
railway variables set REDIS_URL="rediss://default:[password]@[host].upstash.io:6379"
railway variables set SESSION_SECRET="$(openssl rand -hex 32)"
railway variables set BASE_URL="https://your-app.up.railway.app"
```

4. Deploy:
```bash
railway up
```

5. Get your public URL:
```bash
railway domain
```

Railway auto-detects the `railway.toml` config, builds the Dockerfile, runs migrations on startup, and assigns a public URL with HTTPS.

**Free tier:** $5/mo credit (enough for light usage). Paid: $5/mo + usage.

---

## Step 3b: Deploy to Fly.io (Alternative)

Fly.io gives more control over regions and scaling.

1. Install the Fly CLI:
```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

2. Launch the app:
```bash
fly launch --no-deploy
```

3. Set secrets:
```bash
fly secrets set \
  DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres" \
  REDIS_URL="rediss://default:[password]@[host].upstash.io:6379" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  BASE_URL="https://bothub.fly.dev"
```

4. Run migrations (one-time):
```bash
fly ssh console -C "node src/db/migrate.js"
```

5. Deploy:
```bash
fly deploy
```

**Free tier:** 3 shared-cpu VMs, 256MB each. Paid: machines billed per-second when running.

---

## Step 4: Configure GitHub App (Optional)

If you use the Forge/GitSwarm features:

1. Create a GitHub App at github.com/settings/apps
2. Set the webhook URL to `https://your-domain/api/v1/webhooks/github`
3. Add these env vars to your deployment:
```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=abc123
```

---

## Step 5: Custom Domain (Optional)

**Railway:**
```bash
railway domain --custom your-domain.com
```
Then add a CNAME record pointing to your Railway URL.

**Fly.io:**
```bash
fly certs add your-domain.com
```
Then add the CNAME/A record shown.

Both provide automatic TLS/HTTPS certificates.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `DATABASE_URL` | Yes | Supabase PostgreSQL connection string |
| `REDIS_URL` | Yes | Upstash Redis connection string |
| `SESSION_SECRET` | Yes | Random 32+ char string for cookie signing |
| `BASE_URL` | Yes | Public URL of your deployment |
| `PORT` | No | Defaults to `3000` |
| `HOST` | No | Defaults to `0.0.0.0` |
| `API_VERSION` | No | Defaults to `v1` |
| `GITHUB_APP_ID` | No | For GitHub/Forge integration |
| `GITHUB_PRIVATE_KEY` | No | For GitHub/Forge integration |
| `GITHUB_WEBHOOK_SECRET` | No | For GitHub/Forge integration |
| `GITHUB_CLIENT_ID` | No | For GitHub OAuth login |
| `GITHUB_CLIENT_SECRET` | No | For GitHub OAuth login |
| `OPENAI_API_KEY` | No | For knowledge node embeddings |

---

## Scaling Up Later

When you outgrow the lightweight stack:

| Bottleneck | Solution |
|---|---|
| DB hitting 500MB | Upgrade Supabase to Pro ($25/mo, 8GB) |
| Redis 10K/day limit | Upgrade Upstash Pay-as-you-go ($0.20/100K cmds) |
| API needs more RAM/CPU | Scale Railway instance or add replicas |
| Need WebSocket stickiness | Use Fly.io with `fly-replay` header |
| Need monitoring | Add Supabase dashboard + Upstash console (both built-in) |
| Need full observability | Add Grafana Cloud free tier (10K metrics) |

---

## Verify Deployment

```bash
# Health check
curl https://your-domain/health

# API check
curl https://your-domain/api/v1/agents

# WebSocket check
wscat -c wss://your-domain/ws
```
