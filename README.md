# Resource Guru Live Dashboard

Connects your custom utilisation dashboard directly to Resource Guru's API
and adds a Claude AI assistant for forecasting and capacity planning.

## Project structure

```
rg-dashboard-live/
├── server/
│   ├── index.js          ← Express proxy (main entry point)
│   ├── resourceGuru.js   ← RG API client (auth + data fetching)
│   └── transformer.js    ← Converts RG responses → dashboard RAW shape
├── public/
│   └── index.html        ← Your dashboard (now with live data + AI tab)
├── .env.example          ← Copy to .env and fill in credentials
├── package.json
└── README.md
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure credentials
```bash
cp .env.example .env
# Edit .env with your Resource Guru and Anthropic credentials
```

### 3. Run
```bash
npm start
# Development (auto-restarts on changes):
npm run dev
```

Open http://localhost:3000

## How it works

```
Browser → GET /api/utilisation → Express proxy → Resource Guru API
                                               ↓ transforms response
                                         returns RAW object
                                         (same shape as the hardcoded data)
Browser → POST /api/claude     → Express proxy → Anthropic API
                                               ↓ returns AI response
```

The dashboard's existing charts/tables/scenario planner all work unchanged —
the only difference is `RAW` now comes from the API instead of hardcoded data.

## Deploying to the cloud

### Railway (recommended — free tier available)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
# Set env vars in the Railway dashboard
```

### Render
1. Push to GitHub
2. New Web Service → connect repo
3. Build: `npm install`, Start: `npm start`
4. Add env vars in Render dashboard

## Data refresh

The proxy caches data for 15 minutes (configurable via `CACHE_TTL_MS` in .env).
Force a refresh: `GET /api/utilisation?refresh=1`

## Troubleshooting

**"Could not connect to proxy server"** in the dashboard:
→ Make sure `npm start` is running

**Resource Guru auth errors:**
→ Check `RG_CLIENT_ID`, `RG_CLIENT_SECRET`, `RG_USERNAME`, `RG_PASSWORD`, `RG_ACCOUNT` in .env

**Claude AI not responding:**
→ Check `ANTHROPIC_API_KEY` in .env
