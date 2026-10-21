import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "../../db/index.js";
import { products, sales, saleItems } from "../../db/schema.js";

type Product = typeof products.$inferSelect;
type Sale = typeof sales.$inferSelect;
type SaleItem = typeof saleItems.$inferSelect;

const env = (globalThis as any).process?.env ?? {};
const SESSION_COOKIE = "quickpos_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();
const images = () => getStore("product-images");
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const fail = (error: string, status = 400) => json({ error }, status);
const cents = (n: number) => Math.round(Number(n) * 100);
const money = (n: number) => Number(n) / 100;
const iso = (d: Date) => new Date(d).toISOString();

const productDTO = (p: Product) => ({ id: p.id, name: p.name, category: p.category, description: p.description, unitPrice: money(p.unitPriceCents), imageUrl: p.imageUrl, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) });
const saleDTO = (s: Sale & { items: SaleItem[] }) => ({ id: s.id, timestamp: iso(s.timestamp), totalItems: s.totalItems, totalAmount: money(s.totalAmountCents), items: s.items.map(i => ({ productId: i.productId, productName: i.productName, quantity: i.quantity, unitPrice: money(i.unitPriceCents), totalAmount: money(i.totalAmountCents) })) });

const listProducts = () => db.select().from(products).orderBy(asc(sql`lower(${products.name})`));

async function getSales(limit = 100) {
  const rows = await db.select().from(sales).orderBy(desc(sales.timestamp), desc(sales.id)).limit(limit);
  if (!rows.length) return [];
  const items = await db.select().from(saleItems).where(inArray(saleItems.saleId, rows.map(s => s.id))).orderBy(asc(saleItems.id));
  const bySale = new Map<number, SaleItem[]>();
  for (const i of items) (bySale.get(i.saleId) ?? bySale.set(i.saleId, []).get(i.saleId)!).push(i);
  return rows.map(s => saleDTO({ ...s, items: bySale.get(s.id) ?? [] }));
}

// Authentication uses a signed, HttpOnly cookie. Configure both secrets in Netlify.
// The app intentionally fails closed (503) if authentication has not been configured.
const adminUsername = String(env.QUICKPOS_ADMIN_USERNAME || "admin");
const adminPassword = String(env.QUICKPOS_ADMIN_PASSWORD || "");
const sessionSecret = String(env.QUICKPOS_SESSION_SECRET || "");
const authConfigured = () => adminPassword.length >= 12 && sessionSecret.length >= 32;

function constantTimeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function base64url(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}
function fromBase64url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function signSession(value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
function cookieValue(req: Request, name: string) {
  const cookies = req.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
async function verifySession(req: Request) {
  if (!authConfigured()) return false;
  const token = cookieValue(req, SESSION_COOKIE);
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length) return false;
  try {
    if (!constantTimeEqual(await signSession(payload), signature)) return false;
    const data = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    const now = Math.floor(Date.now() / 1000);
    return data?.sub === adminUsername && Number.isSafeInteger(data?.exp) && data.exp > now && Number.isSafeInteger(data?.iat) && data.iat <= now + 60;
  } catch {
    return false;
  }
}
function sessionCookie(req: Request, value: string, maxAge: number) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
async function createSession(req: Request) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(encoder.encode(JSON.stringify({ sub: adminUsername, iat: now, exp: now + SESSION_TTL_SECONDS })));
  const signature = await signSession(payload);
  return json({ ok: true, user: adminUsername }, 200, { "Set-Cookie": sessionCookie(req, `${payload}.${signature}`, SESSION_TTL_SECONDS), "Cache-Control": "no-store" });
}
const failedLogins = new Map<string, { count: number; resetAt: number }>();
function clientKey(req: Request) {
  return req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
function isLoginLimited(req: Request) {
  const key = clientKey(req), now = Date.now(), entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= 8;
}
function recordFailedLogin(req: Request) {
  const key = clientKey(req), now = Date.now();
  if (failedLogins.size > 1000) {
    for (const [k, v] of failedLogins) if (v.resetAt <= now) failedLogins.delete(k);
  }
  const entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) failedLogins.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
  else entry.count++;
}
function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(req.url).origin &&
      (!req.headers.get("sec-fetch-site") || req.headers.get("sec-fetch-site") === "same-origin");
  } catch {
    return false;
  }
}
class RequestTooLarge extends Error {}
async function readLimitedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestTooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function login(req: Request) {
  if (!authConfigured()) return fail("Authentication is not configured. Set QUICKPOS_ADMIN_PASSWORD (12+ characters) and QUICKPOS_SESSION_SECRET (32+ characters) in Netlify environment variables.", 503);
  if (!sameOrigin(req)) return fail("Cross-origin request blocked.", 403);
  if (isLoginLimited(req)) return fail("Too many sign-in attempts. Try again in 15 minutes.", 429);
  let body: any;
  try {
    const bytes = await readLimitedBody(req, 4096);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    if (e instanceof RequestTooLarge) return fail("Request body is too large.", 413);
    return fail("Invalid login request.", 400);
  }
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!constantTimeEqual(username, adminUsername) || !constantTimeEqual(password, adminPassword)) {
    recordFailedLogin(req);
    return fail("Invalid username or password.", 401);
  }
  failedLogins.delete(clientKey(req));
  return createSession(req);
}

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
function validSignature(type: string, sig: Uint8Array) {
  const ascii = (a: number, b: number) => String.fromCharCode(...sig.subarray(a, b));
  if (type === "image/jpeg") return sig[0] === 0xff && sig[1] === 0xd8;
  if (type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => sig[i] === b);
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  return false;
}

// Read the multipart body with a hard limit before parsing it to avoid parsing arbitrarily large uploads.
async function readProductForm(req: Request) {
  let form: FormData;
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) return fail("Expected multipart form data.");
    const bytes = await readLimitedBody(req, 6 * 1024 * 1024);
    const headers = new Headers({ "Content-Type": contentType });
    const replay = new Request(req.url, { method: "POST", headers, body: bytes as unknown as BodyInit });
    form = await replay.formData();
  } catch (e) {
    if (e instanceof RequestTooLarge) return fail("Request body is too large (maximum 6 MB).", 413);
    return fail("Invalid form submission.");
  }
  const name = String(form.get("name") || "").trim(), category = String(form.get("category") || "Other").trim(), description = String(form.get("description") || "").trim();
  const price = Number(form.get("unitPrice"));
  if (!name || name.length > 120) return fail("Enter a product name (up to 120 characters).");
  if (!Number.isFinite(price) || price < 0 || price > 100000000) return fail("Enter a valid non-negative price.");
  if (category.length > 60 || description.length > 1000) return fail("Category or description is too long.");
  const file = form.get("image");
  let image: { bytes: ArrayBuffer; type: string } | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) return fail("Choose an image smaller than 5 MB.");
    if (!IMAGE_TYPES[file.type]) return fail("Use a JPG, PNG or WebP image.");
    const bytes = await file.arrayBuffer();
    if (!validSignature(file.type, new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)))) return fail("Image file signature does not match its type.");
    image = { bytes, type: file.type };
  }
  return { name, category: category || "Other", description, priceCents: cents(price), image };
}

async function storeImage(image: { bytes: ArrayBuffer; type: string }) {
  const key = crypto.randomUUID() + IMAGE_TYPES[image.type];
  await images().set(key, image.bytes, { metadata: { contentType: image.type } });
  return "/uploads/" + key;
}

async function createSale(items: { productId: number; quantity: number }[]) {
  return db.transaction(async tx => {
    const found = await tx.select().from(products).where(inArray(products.id, items.map(i => i.productId)));
    const byId = new Map(found.map(p => [p.id, p]));
    let totalItems = 0, totalAmount = 0;
    const lines = items.map(item => {
      const p = byId.get(item.productId);
      if (!p) throw new Error("Missing product.");
      const lineTotal = p.unitPriceCents * item.quantity;
      totalItems += item.quantity; totalAmount += lineTotal;
      return { p, quantity: item.quantity, lineTotal };
    });
    if (totalAmount > 2147483647) throw new Error("Sale total is too large.");
    const [sale] = await tx.insert(sales).values({ totalItems, totalAmountCents: totalAmount }).returning();
    await tx.insert(saleItems).values(lines.map(l => ({ saleId: sale.id, productId: l.p.id, productName: l.p.name, quantity: l.quantity, unitPriceCents: l.p.unitPriceCents, totalAmountCents: l.lineTotal })));
    return sale.id;
  });
}

function spreadsheetText(value: unknown) {
  const text = String(value ?? "");
  return /^[\\s]*[=+\\-@]/.test(text) ? "'" + text : text;
}
function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\\s]*[=+\\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function sendCsv(filename: string, headers: string[], rows: unknown[][]) {
  const body = "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\\r\\n");
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
}

async function workbook() {
  const wb = new ExcelJS.Workbook(); wb.creator = "QuickPOS"; wb.created = new Date();
  const header = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF173F35" } } };
  const s = wb.addWorksheet("Sales");
  s.columns = [{ header: "Timestamp (UTC)", key: "timestamp", width: 26 }, { header: "Sale ID", key: "saleId", width: 12 }, { header: "Product name", key: "productName", width: 28 }, { header: "Quantity", key: "quantity", width: 12 }, { header: "Unit price", key: "unitPrice", width: 15 }, { header: "Total amount", key: "total", width: 16 }];
  for (const sale of await getSales(50000)) for (const i of sale.items) s.addRow({ timestamp: sale.timestamp, saleId: sale.id, productName: spreadsheetText(i.productName), quantity: i.quantity, unitPrice: i.unitPrice, total: i.totalAmount });
  Object.assign(s.getRow(1), header); s.getColumn(5).numFmt = "฿#,##0.00"; s.getColumn(6).numFmt = "฿#,##0.00"; s.views = [{ state: "frozen", ySplit: 1 }]; s.autoFilter = "A1:F1";
  const p = wb.addWorksheet("Products");
  p.columns = [{ header: "Product ID", key: "id", width: 12 }, { header: "Product name", key: "name", width: 28 }, { header: "Category", key: "category", width: 20 }, { header: "Description", key: "description", width: 42 }, { header: "Unit price", key: "price", width: 15 }, { header: "Created at", key: "created", width: 26 }, { header: "Updated at", key: "updated", width: 26 }];
  for (const x of await listProducts()) p.addRow({ id: x.id, name: spreadsheetText(x.name), category: spreadsheetText(x.category), description: spreadsheetText(x.description), price: money(x.unitPriceCents), created: iso(x.createdAt), updated: iso(x.updatedAt) });
  Object.assign(p.getRow(1), header); p.getColumn(5).numFmt = "฿#,##0.00"; p.views = [{ state: "frozen", ySplit: 1 }]; p.autoFilter = "A1:G1";
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="quickpos-workbook.xlsx"', "Cache-Control": "no-store" } });
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\\/+$/, ""), method = req.method;

  // Every mutation must come from the same origin. SameSite cookies provide a second CSRF defence.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !sameOrigin(req)) return fail("Cross-origin request blocked.", 403);

  if (path === "/api/auth/login") {
    if (method !== "POST") return fail("Method not allowed.", 405);
    return login(req);
  }
  if (path === "/api/auth/session" && method === "GET") {
    return json({ authenticated: await verifySession(req) }, 200, { "Cache-Control": "no-store" });
  }
  if (path === "/api/auth/logout") {
    if (method !== "POST") return fail("Method not allowed.", 405);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(req, "", 0), "Cache-Control": "no-store" });
  }

  const isPublic = path === "/api/health" && method === "GET";
  if (!isPublic && (path.startsWith("/api/") || path.startsWith("/uploads/"))) {
    if (!authConfigured()) return fail("Authentication is not configured. Set QUICKPOS_ADMIN_PASSWORD and QUICKPOS_SESSION_SECRET in Netlify environment variables.", 503);
    if (!(await verifySession(req))) return fail("Authentication required.", 401);
  }

  if (path.startsWith("/uploads/") && method === "GET") {
    const key = path.slice("/uploads/".length);
    if (!/^[0-9a-f-]{36}\\.(jpg|png|webp)$/.test(key)) return fail("Not found.", 404);
    const result = await images().getWithMetadata(key, { type: "arrayBuffer" });
    if (!result) return new Response("Not found", { status: 404 });
    const allowedType = typeof result.metadata.contentType === "string" && IMAGE_TYPES[result.metadata.contentType] ? result.metadata.contentType : "application/octet-stream";
    return new Response(result.data, { headers: { "Content-Type": allowedType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  }

  if (path === "/api/health" && method === "GET") return json({ ok: true });

  if (path === "/api/products" && method === "GET") {
    const rawQuery = url.searchParams.get("q") || "";
    if (rawQuery.length > 120) return fail("Search query is too long.", 400);
    const q = rawQuery.toLowerCase();
    const all = await listProducts();
    return json({ products: all.filter(p => !q || `${p.name} ${p.category} ${p.description}`.toLowerCase().includes(q)).map(productDTO) });
  }

  if (path === "/api/products" && method === "POST") {
    const input = await readProductForm(req);
    if (input instanceof Response) return input;
    const imageUrl = input.image ? await storeImage(input.image) : null;
    const [p] = await db.insert(products).values({ name: input.name, category: input.category, description: input.description, unitPriceCents: input.priceCents, imageUrl }).returning();
    return json({ product: productDTO(p) }, 201);
  }

  const productMatch = path.match(/^\\/api\\/products\\/(\\d+)$/);
  if (productMatch && method === "PUT") {
    const id = Number(productMatch[1]);
    const [old] = await db.select().from(products).where(eq(products.id, id));
    if (!old) return fail("Product not found.", 404);
    const input = await readProductForm(req);
    if (input instanceof Response) return input;
    const imageUrl = input.image ? await storeImage(input.image) : old.imageUrl;
    const [p] = await db.update(products).set({ name: input.name, category: input.category, description: input.description, unitPriceCents: input.priceCents, imageUrl, updatedAt: new Date() }).where(eq(products.id, id)).returning();
    return json({ product: productDTO(p) });
  }

  if (path === "/api/summary" && method === "GET") {
    const today = sql`(now() at time zone 'Asia/Bangkok')::date`;
    const [s] = await db.select({ n: count(), items: sql<number>`coalesce(sum(${sales.totalItems}),0)::int`, revenue: sql<number>`coalesce(sum(${sales.totalAmountCents}),0)::bigint` })
      .from(sales).where(sql`(${sales.timestamp} at time zone 'Asia/Bangkok')::date = ${today}`);
    const [pc] = await db.select({ n: count() }).from(products);
    return json({ todaySales: Number(s.n), todayItems: Number(s.items), todayRevenue: money(Number(s.revenue)), products: Number(pc.n) });
  }

  if (path === "/api/sales" && method === "GET") {
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit && (!/^\\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500)) return fail("Limit must be between 1 and 500.", 400);
    const limit = rawLimit ? Number(rawLimit) : 100;
    return json({ sales: await getSales(limit) });
  }

  if (path === "/api/sales" && method === "POST") {
    let body: any;
    try {
      const bytes = await readLimitedBody(req, 64 * 1024);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      if (e instanceof RequestTooLarge) return fail("Request body is too large.", 413);
      return fail("Invalid JSON body.", 400);
    }
    const items = body?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) return fail("Add between 1 and 100 product lines.");
    const seen = new Set<number>();
    for (const i of items) {
      if (!Number.isSafeInteger(i?.productId) || i.productId < 1 || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 999) return fail("Each product needs a valid ID and quantity from 1 to 999.");
      if (seen.has(i.productId)) return fail("Each product should appear only once in the basket.");
      seen.add(i.productId);
    }
    try {
      const id = await createSale(items);
      return json({ sale: (await getSales(500)).find(s => s.id === id) }, 201);
    } catch (e) {
      console.error("QuickPOS sale creation failed.");
      return fail("Unable to save sale. Check the basket and try again.", 500);
    }
  }

  if (path === "/api/export/sales.csv" && method === "GET") {
    const rows = (await getSales(50000)).flatMap(s => s.items.map(i => [s.timestamp, s.id, i.productName, i.quantity, i.unitPrice.toFixed(2), i.totalAmount.toFixed(2)]));
    return sendCsv("quickpos-sales.csv", ["Timestamp (UTC)", "Sale ID", "Product name", "Quantity", "Unit price", "Total amount"], rows);
  }

  if (path === "/api/export/products.csv" && method === "GET") {
    const rows = (await listProducts()).map(p => [p.id, p.name, p.category, p.description, money(p.unitPriceCents).toFixed(2), iso(p.createdAt), iso(p.updatedAt)]);
    return sendCsv("quickpos-products.csv", ["Product ID", "Product name", "Category", "Description", "Unit price", "Created at", "Updated at"], rows);
  }

  if (path === "/api/export/workbook.xlsx" && method === "GET") return workbook();

  return fail("Not found.", 404);
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
};
function harden(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(key)) headers.set(key, value);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default async (req: Request) => {
  try {
    return harden(await route(req));
  } catch (e) {
    console.error("QuickPOS request failed.");
    return harden(fail("Request failed.", 500));
  }
};

export const config: Config = {
  path: ["/api/*", "/uploads/*"],
};
