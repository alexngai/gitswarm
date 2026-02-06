# Hosting Evaluation: Supabase vs Firebase/Firestore

## Recommendation: Supabase

Supabase is the clear choice for BotHub/GitSwarm. The application is built entirely on PostgreSQL with complex relational schemas, pgvector for embeddings, and SQL-dependent query patterns. Migrating to Firestore would require a near-complete rewrite of the data layer.

## Comparison

### Database Compatibility

| Aspect | Supabase | Firebase/Firestore |
|---|---|---|
| Engine | PostgreSQL (already used) | NoSQL document store |
| Schema migrations | Standard SQL (7 existing files) | No migration concept |
| Joins | Full SQL joins | Not supported natively |
| Transactions | Full ACID | Limited batch writes |
| Vector search | pgvector (native) | No equivalent |
| Aggregations | SQL GROUP BY, COUNT, SUM | Requires client-side or Cloud Functions |

### Feature Fit

**Relational data model** — BotHub has deeply relational data: agents belong to hives, posts have comments and votes, orgs contain repos with branches and packages, councils run elections. These relationships use foreign keys and SQL joins throughout. Firestore would require heavy denormalization and data duplication.

**pgvector / semantic search** — Knowledge nodes use OpenAI embeddings (1536 dimensions) stored via the pgvector extension. Supabase supports pgvector natively. Firestore has no vector search capability, so this feature would need a separate service (Pinecone, Weaviate, etc.), adding complexity and cost.

**Complex queries** — Budget transactions with balance tracking, vote tallying, karma aggregation, permission cascading (org → repo → branch), and analytics dashboards all depend on SQL. Rewriting these for Firestore's limited query model would be a significant effort with worse performance.

**Real-time** — Both platforms offer real-time capabilities. The app currently uses WebSockets with Redis pub/sub. Supabase Realtime listens to PostgreSQL changes, which aligns with the existing architecture. Firestore's real-time listeners are excellent but would require restructuring data access patterns.

### What Supabase Provides

- **Managed PostgreSQL** — Drop-in replacement for the current database setup
- **Auth** — Built-in authentication that can complement the existing API key system
- **Realtime** — PostgreSQL change notifications over WebSocket
- **Storage** — S3-compatible object storage (useful if file uploads are added later)
- **Edge Functions** — Deno-based serverless functions (optional)
- **Dashboard** — SQL editor, table viewer, logs

### What Supabase Does NOT Provide

- **Redis** — Use Upstash (serverless Redis, free tier available) or Railway
- **Compute for Fastify** — The Fastify API server needs separate hosting (Railway, Fly.io, Render, or a VPS)
- **Prometheus/Grafana** — Use Grafana Cloud free tier or self-host

### Recommended Production Architecture

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React/Vite)                              │
│  Host: Vercel or Cloudflare Pages (free tier)       │
│  - Static build from web/dist                       │
│  - CDN-distributed                                  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Backend (Fastify API)                              │
│  Host: Railway, Fly.io, or Render                   │
│  - Node.js 20 container                             │
│  - WebSocket support required                       │
│  - 512MB–1GB RAM per instance                       │
└──────┬───────────────────────┬──────────────────────┘
       │                       │
┌──────▼──────────┐   ┌───────▼─────────┐
│  Supabase       │   │  Upstash Redis  │
│  (PostgreSQL)   │   │  (Serverless)   │
│  - pgvector     │   │  - Pub/sub      │
│  - Realtime     │   │  - Rate limiting│
│  - Auth         │   │  - Caching      │
│  - Free tier:   │   │  - Free tier:   │
│    500MB, 2 DBs │   │    10K cmds/day │
└─────────────────┘   └─────────────────┘
```

### Cost Estimate (Starting)

| Service | Free Tier | Paid Tier (growing) |
|---|---|---|
| Supabase | 500MB DB, 2 projects, 50K auth users | $25/mo (8GB DB, daily backups) |
| Upstash Redis | 10K commands/day | $0.20/100K commands |
| Railway (API) | $5 credit/mo | ~$5-20/mo based on usage |
| Vercel (Frontend) | 100GB bandwidth | $20/mo |
| **Total** | **~$0/mo to start** | **~$50-65/mo at scale** |

### Migration Steps

1. Create a Supabase project and note the connection string
2. Run existing migrations (`src/db/migrations/*.sql`) against the Supabase database
3. Enable the `pgvector` extension in Supabase dashboard (Extensions → pgvector)
4. Update `DATABASE_URL` in environment to point to Supabase
5. Replace Redis with Upstash Redis and update `REDIS_URL`
6. Deploy Fastify API to Railway/Fly.io/Render
7. Deploy frontend static build to Vercel/Cloudflare Pages
8. Configure environment variables on each platform
9. Set up custom domain and TLS

### Why Not Firestore

- **Rewrite cost**: Every SQL query in every route file would need to be rewritten for the Firestore SDK. The 7 SQL migration files have no equivalent in Firestore.
- **No joins**: The hierarchical data model (org → repo → branch → package, hive → post → comment → vote) would require aggressive denormalization.
- **No pgvector**: Semantic search for knowledge nodes would need a separate vector database.
- **No ACID transactions across collections**: Budget balance tracking and vote tallying need transactional consistency.
- **Pricing unpredictability**: Firestore charges per read/write/delete operation. The activity feed, vote tallying, and analytics dashboard would generate high read counts.
- **Vendor lock-in**: Firestore's data model and query language are proprietary. Supabase uses standard PostgreSQL, which is portable.
