# QuickPOS

A mobile-first point-of-sale and product tracker built with vanilla JavaScript, CSS, Express, SQLite, and ExcelJS.

## Requirements
- Node.js 20+
- npm

## Run
```bash
npm install
npm start
```
Open http://localhost:3000. The database is created automatically at `data/quickpos.sqlite`.

## Features
- Register products, add camera/gallery photos, edit product details and prices.
- Search and category-filter products.
- Build a basket, adjust quantities, and save sales atomically to SQLite.
- View sales history and daily dashboard totals.
- Export an Excel workbook with Sales and Products worksheets, or export separate CSV files.
- Uploaded images are limited to 5 MB and supported image types; prices are stored as integer satang.

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

This starter has no login or user/tenant separation. Do not expose it to the public internet without authentication, authorization, HTTPS, persistent backups, and a production deployment setup. Back up both `data/` and `uploads/`. Set `DATA_DIR` and `UPLOAD_DIR` to persistent writable directories when deploying. Camera access works best on localhost or HTTPS.

## Phone on same Wi-Fi
Start the app on your computer, find its LAN IP, then visit `http://YOUR-COMPUTER-IP:3000` on the phone. Camera access may require HTTPS; gallery upload remains available.
