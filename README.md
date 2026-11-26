# VegieTrack Portfolio Demo

VegieTrack is a produce-market inventory and sales application presented here as a standalone portfolio demo. This repository is a separate copy of the project and is configured to use **demo-only credentials and a separate demo database**.

## What the demo includes

- Dashboard, inventory, FIFO batches, unit conversions, sales, transaction history, reports and analytics, user management, and settings.
- Fictional store, employees, suppliers, products, sample sales, and operating expenses.
- Public one-click demo login. There are no shared passwords to disclose.
- Sales, product edits, and restocking work against the demo database. Account management, settings changes, payroll/expense updates, write-offs, voiding, and destructive deletes are disabled for the demo session.
- A persistent shared demo database is changed by visitor sales and inventory edits. Re-import or restore the demo seed periodically if the sample state needs to be reset.

## Local development

Use a local MySQL database or a newly created, isolated demo database. Never point this copy at the original project's database.

1. Import [`backend/database.sql`](backend/database.sql) into MySQL. It creates the `vegietrack_demo` database and fictional seed data.
2. Create `backend/.env` from the local template:

   ```powershell
   Copy-Item backend\.env.example backend\.env
   ```

   Set `DEMO_DB_USER`, `DEMO_DB_PASSWORD`, and a unique `DEMO_JWT_SECRET` for this local demo only. The API ignores generic `DB_*`, `DATABASE_URL`, `POSTGRES_*`, and production JWT variables.
3. Start the API:

   ```powershell
   cd backend
   npm install
   npm run dev
   ```
4. In another terminal, install and start the React app:

   ```powershell
   cd frontend
   Copy-Item .env.example .env.local
   npm install
   npm run dev
   ```
5. Open the Vite URL (normally `http://localhost:5173`) and choose **Enter the demo**.

The legacy PHP API in `api/` also reads only `DEMO_DB_*` variables and defaults to `vegietrack_demo`; Vercel uses the Express API described below.

## Deploy as a separate Vercel project

1. Create a **new Vercel project** from this repository copy. Do not reuse the original project's Vercel project, environment variables, or production database.
2. Create a **new Supabase project/database** for the demo. Do not connect this project to production.
3. Run [`backend/supabase_schema.sql`](backend/supabase_schema.sql) in the new project's SQL editor. It creates the schema and sample data, enables RLS on the application tables, and defines no public-table policies. The browser has no direct Supabase connection; requests go through the Express API.
4. Add the environment variables below in Vercel for the environments you intend to deploy, then redeploy.
5. Smoke-test `/api/health`, `/api/health/db`, demo login, a sample sale/restock, and the Reports page before sharing the URL.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DEMO_DATABASE_URL` | Yes for Vercel | Private connection string to the **new demo database only**. Never prefix it with `VITE_`. |
| `DEMO_JWT_SECRET` | Yes | Unique, high-entropy signing secret for demo JWTs. Generate a new value specifically for this deployment. |
| `DEMO_DB_DRIVER` | Optional with URL | Set to `postgres` for Supabase; local MySQL uses `mysql`. |
| `DEMO_DB_HOST` | Alternative to URL | Dedicated demo DB host. |
| `DEMO_DB_PORT` | Alternative to URL | Dedicated demo DB port. |
| `DEMO_DB_NAME` | Alternative to URL | Must name a separate demo database (for example `vegietrack_demo`). |
| `DEMO_DB_USER` | Alternative to URL | Database user for the demo only. Keep its credentials server-side. |
| `DEMO_DB_PASSWORD` | Alternative to URL | Password for the demo database user only. |
| `DEMO_LOGIN_USERNAME` | Optional | Seeded active demo admin username; defaults to `demo`. |
| `DEMO_JWT_EXPIRES_IN` | Optional | Demo session lifetime; defaults to `2h`. |
| `VITE_API_URL` | Optional | Frontend API base URL. Defaults to `/api` on the deployed site and `http://localhost:5000/api` on localhost. |
| `VITE_MAINTENANCE_MODE` | Optional | Set to `true` to show the existing maintenance page. |

`.env.example`, `backend/.env.example`, and `frontend/.env.example` contain placeholders only. Do not commit `.env` files. Vercel needs the `DEMO_*` values in its project settings; the local `backend/.env` is not deployed.

The server uses a private database connection string and does **not** use or expose a Supabase service-role key. RLS with no public policies prevents browser-facing Supabase roles from accessing these tables; the API's server-side connection is the trusted database boundary and its JWT/role middleware enforces demo restrictions. Do not add Supabase client keys or database credentials to frontend variables.

## Deployment and runtime notes

- Vercel serves the Vite build from `frontend/dist` and routes `/api/*` to `api/server.js`, which exports the Express app in `backend/server-vercel.js`.
- The local API entry point is `backend/server.js`. The `api/` PHP endpoints are for the optional XAMPP setup and are not used by Vercel.
- Use a Node.js version supported by Vite 8 (Node.js 20.19+ or 22.12+).
- `backend/config/db.js` only reads `DEMO_DATABASE_URL` or `DEMO_DB_*`. Missing demo DB settings cause requests to fail with `ECONFIG`; there is no fallback to the original database or to MySQL `root`.
- The public demo login is intentionally open for portfolio visitors. It issues a short-lived demo-only token, and the backend rejects tokens without the demo claim. Data is synthetic and isolated; do not put real customer, employee, or business information in the demo database.
- Do not use the demo deployment for production or sensitive data. Use a separate database, signing key, Vercel project, and environment-variable set.

## Useful commands

```powershell
# Frontend production build (Vercel output)
cd frontend
$env:VERCEL = "1"
npm run build

# Backend tests
cd ..\backend
node --test tests\*.test.js
```
