import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "../../db/index.js";
import { products, sales, saleItems } from "../../db/schema.js";

type Product = typeof products.$inferSelect;
type Sale = typeof sales.$inferSelect;
type SaleItem = typeof saleItems.$inferSelect;

const images = () => getStore("product-images");
const json = (data: unknown, status = 200) => Response.json(data, { status });
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

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
function validSignature(type: string, sig: Uint8Array) {
  const ascii = (a: number, b: number) => String.fromCharCode(...sig.subarray(a, b));
  if (type === "image/jpeg") return sig[0] === 0xff && sig[1] === 0xd8;
  if (type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => sig[i] === b);
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  return false;
}

// Parses and validates the multipart product form. Returns an error Response or the cleaned input.
async function readProductForm(req: Request) {
  let form: FormData;
  try { form = await req.formData(); } catch { return fail("Invalid form submission."); }
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
      if (!p) throw new Error(`Product ${item.productId} was not found.`);
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

function csvCell(value: unknown) { let s = String(value ?? ""); if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
function sendCsv(filename: string, headers: string[], rows: unknown[][]) {
  const body = "﻿" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` } });
}

async function workbook() {
  const wb = new ExcelJS.Workbook(); wb.creator = "QuickPOS"; wb.created = new Date();
  const header = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF173F35" } } };
  const s = wb.addWorksheet("Sales");
  s.columns = [{ header: "Timestamp (UTC)", key: "timestamp", width: 26 }, { header: "Sale ID", key: "saleId", width: 12 }, { header: "Product name", key: "productName", width: 28 }, { header: "Quantity", key: "quantity", width: 12 }, { header: "Unit price", key: "unitPrice", width: 15 }, { header: "Total amount", key: "total", width: 16 }];
  for (const sale of await getSales(50000)) for (const i of sale.items) s.addRow({ timestamp: sale.timestamp, saleId: sale.id, productName: i.productName, quantity: i.quantity, unitPrice: i.unitPrice, total: i.totalAmount });
  Object.assign(s.getRow(1), header); s.getColumn(5).numFmt = "฿#,##0.00"; s.getColumn(6).numFmt = "฿#,##0.00"; s.views = [{ state: "frozen", ySplit: 1 }]; s.autoFilter = "A1:F1";
  const p = wb.addWorksheet("Products");
  p.columns = [{ header: "Product ID", key: "id", width: 12 }, { header: "Product name", key: "name", width: 28 }, { header: "Category", key: "category", width: 20 }, { header: "Description", key: "description", width: 42 }, { header: "Unit price", key: "price", width: 15 }, { header: "Created at", key: "created", width: 26 }, { header: "Updated at", key: "updated", width: 26 }];
  for (const x of await listProducts()) p.addRow({ id: x.id, name: x.name, category: x.category, description: x.description, price: money(x.unitPriceCents), created: iso(x.createdAt), updated: iso(x.updatedAt) });
  Object.assign(p.getRow(1), header); p.getColumn(5).numFmt = "฿#,##0.00"; p.views = [{ state: "frozen", ySplit: 1 }]; p.autoFilter = "A1:G1";
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="quickpos-workbook.xlsx"' } });
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), method = req.method;

  if (path.startsWith("/uploads/") && method === "GET") {
    const result = await images().getWithMetadata(path.slice("/uploads/".length), { type: "arrayBuffer" });
    if (!result) return new Response("Not found", { status: 404 });
    return new Response(result.data, { headers: { "Content-Type": String(result.metadata.contentType || "application/octet-stream"), "Cache-Control": "public, max-age=86400" } });
  }

  if (path === "/api/health") return json({ ok: true });

  if (path === "/api/products" && method === "GET") {
    const q = String(url.searchParams.get("q") || "").toLowerCase();
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

  const productMatch = path.match(/^\/api\/products\/(\d+)$/);
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

  if (path === "/api/summary") {
    const today = sql`(now() at time zone 'Asia/Bangkok')::date`;
    const [s] = await db.select({ n: count(), items: sql<number>`coalesce(sum(${sales.totalItems}),0)::int`, revenue: sql<number>`coalesce(sum(${sales.totalAmountCents}),0)::bigint` })
      .from(sales).where(sql`(${sales.timestamp} at time zone 'Asia/Bangkok')::date = ${today}`);
    const [pc] = await db.select({ n: count() }).from(products);
    return json({ todaySales: Number(s.n), todayItems: Number(s.items), todayRevenue: money(Number(s.revenue)), products: Number(pc.n) });
  }

  if (path === "/api/sales" && method === "GET") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
    return json({ sales: await getSales(limit) });
  }

  if (path === "/api/sales" && method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return fail("Invalid JSON body."); }
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
    } catch (e: any) { return fail(e?.message || "Unable to save sale."); }
  }

  if (path === "/api/export/sales.csv") {
    const rows = (await getSales(50000)).flatMap(s => s.items.map(i => [s.timestamp, s.id, i.productName, i.quantity, i.unitPrice.toFixed(2), i.totalAmount.toFixed(2)]));
    return sendCsv("quickpos-sales.csv", ["Timestamp (UTC)", "Sale ID", "Product name", "Quantity", "Unit price", "Total amount"], rows);
  }

  if (path === "/api/export/products.csv") {
    const rows = (await listProducts()).map(p => [p.id, p.name, p.category, p.description, money(p.unitPriceCents).toFixed(2), iso(p.createdAt), iso(p.updatedAt)]);
    return sendCsv("quickpos-products.csv", ["Product ID", "Product name", "Category", "Description", "Unit price", "Created at", "Updated at"], rows);
  }

  if (path === "/api/export/workbook.xlsx") return workbook();

  return fail("Not found.", 404);
}

export default async (req: Request) => {
  try { return await route(req); }
  catch (e) { console.error(e); return fail("Request failed.", 500); }
};

export const config: Config = {
  path: ["/api/*", "/uploads/*"],
};
