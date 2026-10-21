# QuickPOS

A mobile-first point-of-sale dashboard for small shops, built with vanilla JavaScript, Netlify Functions, Netlify Database, Netlify Blobs, and Drizzle ORM.

![QuickPOS interface](https://github.com/user-attachments/assets/a56fcb32-ac9f-4f6d-9c21-fe4e8a0e5087)

> **Live preview:** Deploy this repository to Netlify, then replace this line with your site's URL. A live deployment URL was not present in the repository configuration when this README was updated.

## Features

- Point-of-sale basket and transaction history.
- Product catalog with JPG, PNG, and WebP photos.
- CSV exports and a formatted Excel workbook.
- Responsive desktop and mobile interface.
- Sign-in required to read or change shop data.
- Signed, expiring session cookies; same-origin checks for write requests.
- Request-size validation, spreadsheet formula mitigation, and security headers.

## Deploy to Netlify

1. Import this GitHub repository into Netlify.
2. Keep the repository's `netlify.toml` settings. The site base directory is `quickpos-app`; the publish directory is `public`; functions are in `netlify/functions`.
3. Enable/configure Netlify Database and Blobs for the site.
4. Before using the app, open the site's environment-variable settings and add:

   | Variable | Required value |
   | --- | --- |
   | `QUICKPOS_ADMIN_USERNAME` | Your chosen login name. If omitted, the server uses `admin`. |
   | `QUICKPOS_ADMIN_PASSWORD` | A unique password of at least 12 characters. Prefer a longer passphrase. |
   | `QUICKPOS_SESSION_SECRET` | A random secret with at least 32 characters. |
   
   Generate a secret with Node.js: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`.
5. Trigger a new deploy after adding the variables. Without a valid password and session secret, the app deliberately fails closed and API access returns HTTP 503.
6. Open the deployed URL and sign in with the username/password you configured.

**Never commit real passwords, session secrets, database credentials, or production data.** `.env.example` contains placeholders only. Use Netlify's environment-variable settings for deployed sites and keep any local secrets out of Git.

## Local development

Install Node.js 20 or newer and the Netlify CLI, then run these commands from the repository root:

```bash
npm --prefix quickpos-app install
npx netlify-cli dev
```

Provide the three authentication variables to the local Netlify process before opening the local URL. Do not use production credentials for local development.

Check the browser JavaScript syntax:

```bash
npm --prefix quickpos-app run check
```

## API routes

All shop data and image routes require a valid session.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Create an authenticated session |
| `GET` | `/api/auth/session` | Check whether the current session is valid |
| `POST` | `/api/auth/logout` | Clear the session cookie |
| `GET` | `/api/health` | Public liveness check (does not expose shop data) |
| `GET` | `/api/products` | List/search products |
| `POST` | `/api/products` | Create a product |
| `PUT` | `/api/products/:id` | Update a product |
| `GET` | `/api/summary` | Today's shop summary |
| `GET` | `/api/sales` | List recent sales |
| `POST` | `/api/sales` | Record a sale |
| `GET` | `/api/export/sales.csv` | Export sales CSV |
| `GET` | `/api/export/products.csv` | Export product CSV |
| `GET` | `/api/export/workbook.xlsx` | Export Excel workbook |
| `GET` | `/uploads/:key` | Read a stored product image |

## Security controls

- Server-side session verification with an HMAC-SHA-256 signature, an HttpOnly cookie, SameSite=Strict, and an eight-hour expiry.
- All product, sales, export, and image endpoints require authentication. The UI hiding alone is not treated as access control.
- State-changing requests require a matching same-origin `Origin` header; the cookie has a SameSite restriction as a second CSRF defense.
- Login request parsing and product/sales request bodies have size limits. Product images are limited to 5 MB and validated by MIME type and file signature.
- Response headers include a restrictive Content Security Policy, frame protection, MIME sniffing protection, and a referrer policy.
- CSV and XLSX text fields are guarded against formula injection; error responses do not intentionally return database exception messages.
- The API fails closed if the authentication secrets are missing or do not meet minimum lengths.

### Important limitations

The login throttling map is best-effort and only applies within a running function instance; it is **not** a distributed rate limiter. For a public production deployment, configure edge/WAF rate limits or a shared rate-limiting service for login and expensive export endpoints. Use least-privilege access for Netlify Database/Blobs, review access to the Netlify site, and test your backup-and-restore process.

These changes are source-level hardening, not a penetration test or a guarantee that every deployment is secure. Test sign-in, sign-out, expired sessions, product create/update, sales, image viewing, and all exports in a Netlify deploy preview before using real shop data.
