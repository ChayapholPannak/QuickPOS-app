# QuickPOS

A mobile-first point-of-sale and product tracker built with vanilla JavaScript and CSS, running on Netlify Functions with Netlify Database (Postgres) for products and sales, Netlify Blobs for product photos, and ExcelJS for exports.

## Requirements
- Node.js 20+
- npm
- Netlify CLI

## Run
```bash
npm install
netlify dev
```
The API lives in `netlify/functions/api.mts`. The database schema is in `db/schema.ts`, and migrations in `netlify/database/migrations/` are applied automatically on deploy. After changing the schema, run `npx drizzle-kit generate --name <change>`.

## Features
- Register products, add camera/gallery photos, edit product details and prices.
- Search and category-filter products.
- Build a basket, adjust quantities, and save sales atomically to the database.
- View sales history and daily dashboard totals.
- Export an Excel workbook with Sales and Products worksheets, or export separate CSV files.
- Uploaded images are limited to 5 MB and supported image types and are served from `/uploads/*`; prices are stored as integer satang.

## API
- `GET /api/health`
- `GET /api/summary`
- `GET /api/products?q=...`
- `POST /api/products` (multipart form)
- `PUT /api/products/:id` (multipart form)
- `GET /api/sales?limit=100`
- `POST /api/sales` with `{ "items": [{ "productId": 1, "quantity": 2 }] }`
- `GET /api/export/sales.csv`
- `GET /api/export/products.csv`
- `GET /api/export/workbook.xlsx`

## Important limitations and deployment notes
The smart suggestion button is a demo using the image filename and keyword rules. It does not identify objects in image pixels or call a vision model.

This starter has no login or user/tenant separation, so anyone with the URL can read and change shop data. Add authentication before using it with real data. Camera access requires HTTPS, which the Netlify site provides.
