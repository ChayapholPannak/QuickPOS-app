const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-origin' }, contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1d', fallthrough: false }));
app.use(express.static(path.join(ROOT, 'public')));

const db = new Database(path.join(DATA_DIR, 'quickpos.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Other',
 description TEXT NOT NULL DEFAULT '', unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
 image_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
 id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
 total_items INTEGER NOT NULL, total_amount_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
 product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, product_name TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity > 0), unit_price_cents INTEGER NOT NULL,
 total_amount_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_timestamp ON sales(timestamp);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
`);
const cents = n => Math.round(Number(n) * 100);
const money = n => Number(n) / 100;
const productDTO = p => ({ id:p.id, name:p.name, category:p.category, description:p.description, unitPrice:money(p.unit_price_cents), imageUrl:p.image_url, createdAt:p.created_at, updatedAt:p.updated_at });
const saleDTO = s => ({ id:s.id, timestamp:s.timestamp, totalItems:s.total_items, totalAmount:money(s.total_amount_cents), items:(s.items||[]).map(i=>({ productId:i.product_id, productName:i.product_name, quantity:i.quantity, unitPrice:money(i.unit_price_cents), totalAmount:money(i.total_amount_cents) })) });
const getProduct = db.prepare('SELECT * FROM products WHERE id=?');
const listProducts = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE');
const listSales = db.prepare('SELECT * FROM sales ORDER BY timestamp DESC, id DESC LIMIT ?');
const listItems = db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id');
function getSales(limit=100) { return listSales.all(limit).map(s=>saleDTO({...s,items:listItems.all(s.id)})); }
const upload = multer({
 storage: multer.diskStorage({
  destination: (_req,_file,cb)=>cb(null,UPLOAD_DIR),
  filename: (_req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())
 }),
 limits: { fileSize: 5*1024*1024, files: 1 },
 fileFilter: (_req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))
});
function validateProduct(req,res,next) {
 const name=String(req.body.name||'').trim(), category=String(req.body.category||'Other').trim(), description=String(req.body.description||'').trim();
 const price=Number(req.body.unitPrice);
 if(!name || name.length>120) return res.status(400).json({error:'Enter a product name (up to 120 characters).'});
 if(!Number.isFinite(price)||price<0||price>100000000) return res.status(400).json({error:'Enter a valid non-negative price.'});
 if(category.length>60 || description.length>1000) return res.status(400).json({error:'Category or description is too long.'});
 req.productInput={name,category:category||'Other',description,priceCents:cents(price)};
 next();
}
app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.get('/api/products',(req,res)=>{
 const q=String(req.query.q||'').toLowerCase();
 res.json({products:listProducts.all().filter(p=>!q||`${p.name} ${p.category} ${p.description}`.toLowerCase().includes(q)).map(productDTO)});
});
app.post('/api/products',upload.single('image'),validateProduct,(req,res)=>{
 const now=new Date().toISOString();
 let imageUrl=null;
 if(req.file) {
  const sig=fs.readFileSync(req.file.path).subarray(0,12);
  const valid=(req.file.mimetype==='image/jpeg'&&sig[0]===0xff&&sig[1]===0xd8)||
   (req.file.mimetype==='image/png'&&sig.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||
   (req.file.mimetype==='image/webp'&&sig.toString('ascii',0,4)==='RIFF'&&sig.toString('ascii',8,12)==='WEBP');
  if(!valid){fs.unlinkSync(req.file.path);return res.status(400).json({error:'Image file signature does not match its type.'});}
  imageUrl='/uploads/'+path.basename(req.file.path);
 }
 const x=req.productInput;
 const result=db.prepare('INSERT INTO products(name,category,description,unit_price_cents,image_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(x.name,x.category,x.description,x.priceCents,imageUrl,now,now);
 res.status(201).json({product:productDTO(getProduct.get(result.lastInsertRowid))});
});
app.put('/api/products/:id',upload.single('image'),validateProduct,(req,res)=>{
 const old=getProduct.get(Number(req.params.id));
 if(!old)return res.status(404).json({error:'Product not found.'});
 let imageUrl=old.image_url;
 if(req.file){
  const sig=fs.readFileSync(req.file.path).subarray(0,12);
  const valid=(req.file.mimetype==='image/jpeg'&&sig[0]===0xff&&sig[1]===0xd8)||(req.file.mimetype==='image/png'&&sig.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(req.file.mimetype==='image/webp'&&sig.toString('ascii',0,4)==='RIFF'&&sig.toString('ascii',8,12)==='WEBP');
  if(!valid){fs.unlinkSync(req.file.path);return res.status(400).json({error:'Image file signature does not match its type.'});}
  imageUrl='/uploads/'+path.basename(req.file.path);
 }
 const x=req.productInput;
 db.prepare('UPDATE products SET name=?,category=?,description=?,unit_price_cents=?,image_url=?,updated_at=? WHERE id=?').run(x.name,x.category,x.description,x.priceCents,imageUrl,new Date().toISOString(),old.id);
 res.json({product:productDTO(getProduct.get(old.id))});
});
app.get('/api/summary',(_req,res)=>{
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const sales=db.prepare("SELECT COUNT(*) n,COALESCE(SUM(total_items),0) items,COALESCE(SUM(total_amount_cents),0) revenue FROM sales WHERE substr(datetime(timestamp,'+7 hours'),1,10)=?").get(day);
 res.json({todaySales:sales.n,todayItems:sales.items,todayRevenue:money(sales.revenue),products:db.prepare('SELECT COUNT(*) n FROM products').get().n});
});
app.get('/api/sales',(req,res)=>{
 const limit=Math.max(1,Math.min(500,Number(req.query.limit)||100));
 res.json({sales:getSales(limit)});
});
const createSale=db.transaction(items=>{
 let totalItems=0,totalAmount=0;
 const lines=[];
 for(const item of items){
  const p=getProduct.get(item.productId);
  if(!p) throw new Error(`Product ${item.productId} was not found.`);
  const lineTotal=p.unit_price_cents*item.quantity;
  if(!Number.isSafeInteger(lineTotal)) throw new Error('Sale amount is too large.');
  totalItems+=item.quantity; totalAmount+=lineTotal;
  lines.push({p,quantity:item.quantity,lineTotal});
 }
 if(!Number.isSafeInteger(totalAmount)) throw new Error('Sale total is too large.');
 const timestamp=new Date().toISOString();
 const sale=db.prepare('INSERT INTO sales(timestamp,total_items,total_amount_cents) VALUES(?,?,?)').run(timestamp,totalItems,totalAmount);
 const insert=db.prepare('INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price_cents,total_amount_cents) VALUES(?,?,?,?,?,?)');
 for(const l of lines) insert.run(sale.lastInsertRowid,l.p.id,l.p.name,l.quantity,l.p.unit_price_cents,l.lineTotal);
 return sale.lastInsertRowid;
});
app.post('/api/sales',(req,res)=>{
 const items=req.body?.items;
 if(!Array.isArray(items)||items.length<1||items.length>100)return res.status(400).json({error:'Add between 1 and 100 product lines.'});
 const seen=new Set();
 for(const i of items){
  if(!Number.isSafeInteger(i.productId)||i.productId<1||!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>999)return res.status(400).json({error:'Each product needs a valid ID and quantity from 1 to 999.'});
  if(seen.has(i.productId))return res.status(400).json({error:'Each product should appear only once in the basket.'});
  seen.add(i.productId);
 }
 try { const id=createSale(items); res.status(201).json({sale:getSales(500).find(s=>s.id===id)}); }
 catch(e){res.status(400).json({error:e.message||'Unable to save sale.'});}
});
function csvCell(value){let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function sendCsv(res,filename,headers,rows){
 const body='\uFEFF'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
 res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.send(body);
}
app.get('/api/export/sales.csv',(_req,res)=>{
 const sales=getSales(50000);
 const rows=sales.flatMap(s=>s.items.map(i=>[s.timestamp,s.id,i.productName,i.quantity,i.unitPrice.toFixed(2),i.totalAmount.toFixed(2)]));
 sendCsv(res,'quickpos-sales.csv',['Timestamp (UTC)','Sale ID','Product name','Quantity','Unit price','Total amount'],rows);
});
app.get('/api/export/products.csv',(_req,res)=>{
 const rows=listProducts.all().map(p=>[p.id,p.name,p.category,p.description,money(p.unit_price_cents).toFixed(2),p.created_at,p.updated_at]);
 sendCsv(res,'quickpos-products.csv',['Product ID','Product name','Category','Description','Unit price','Created at','Updated at'],rows);
});
app.get('/api/export/workbook.xlsx',async(_req,res)=>{
 try {
  const wb=new ExcelJS.Workbook();wb.creator='QuickPOS';wb.created=new Date();
  const sales=wb.addWorksheet('Sales');sales.columns=[{header:'Timestamp (UTC)',key:'timestamp',width:26},{header:'Sale ID',key:'saleId',width:12},{header:'Product name',key:'productName',width:28},{header:'Quantity',key:'quantity',width:12},{header:'Unit price',key:'unitPrice',width:15},{header:'Total amount',key:'total',width:16}];
  for(const s of getSales(50000))for(const i of s.items)sales.addRow({timestamp:s.timestamp,saleId:s.id,productName:i.productName,quantity:i.quantity,unitPrice:i.unitPrice,total:i.totalAmount});
  sales.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sales.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF173F35'}};sales.getColumn(5).numFmt='฿#,##0.00';sales.getColumn(6).numFmt='฿#,##0.00';sales.views=[{state:'frozen',ySplit:1}];sales.autoFilter='A1:F1';
  const products=wb.addWorksheet('Products');products.columns=[{header:'Product ID',key:'id',width:12},{header:'Product name',key:'name',width:28},{header:'Category',key:'category',width:20},{header:'Description',key:'description',width:42},{header:'Unit price',key:'price',width:15},{header:'Created at',key:'created',width:26},{header:'Updated at',key:'updated',width:26}];
  for(const p of listProducts.all())products.addRow({id:p.id,name:p.name,category:p.category,description:p.description,price:money(p.unit_price_cents),created:p.created_at,updated:p.updated_at});
  products.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};products.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF173F35'}};products.getColumn(5).numFmt='฿#,##0.00';products.views=[{state:'frozen',ySplit:1}];products.autoFilter='A1:G1';
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="quickpos-workbook.xlsx"');await wb.xlsx.write(res);res.end();
 }catch(e){console.error(e);if(!res.headersSent)res.status(500).json({error:'Unable to create workbook.'});}
});
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.use((err,_req,res,_next)=>{console.error(err);res.status(400).json({error:err.message||'Request failed.'});});
app.listen(PORT,'0.0.0.0',()=>console.log(`QuickPOS running at http://localhost:${PORT}`));
