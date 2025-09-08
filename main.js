// Load sql.js
import initSqlJs from "https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-wasm.js";

// --- IndexedDB helpers (store Uint8Array) ---
const DBKEY = "trailer_pos_db_v1";
const idb = {
  get: () => new Promise((res, rej) => {
    const r = indexedDB.open("trailer-pos-idb", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction("kv", "readonly").objectStore("kv").get(DBKEY);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => rej(tx.error);
    };
  }),
  set: (val) => new Promise((res, rej) => {
    const r = indexedDB.open("trailer-pos-idb", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction("kv", "readwrite").objectStore("kv").put(val, DBKEY);
      tx.onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    };
  })
};

// --- Schema (compact; includes sales/recipes/stock/food-cost & seed) ---
const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS store (store_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS app_user (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, full_name TEXT);
CREATE TABLE IF NOT EXISTS category (category_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS tax_rate (tax_rate_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, rate REAL NOT NULL CHECK(rate>=0));
CREATE TABLE IF NOT EXISTS unit (unit_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS product (product_id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category_id TEXT, unit TEXT NOT NULL DEFAULT 'pcs',
 price_retail REAL NOT NULL DEFAULT 0, tax_rate_id TEXT, active INTEGER NOT NULL DEFAULT 1, is_ingredient INTEGER NOT NULL DEFAULT 1, purchase_unit TEXT, consume_unit TEXT, conversion_hint REAL);
CREATE TABLE IF NOT EXISTS menu_item (menu_item_id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, price_retail REAL NOT NULL, tax_rate_id TEXT, active INTEGER NOT NULL DEFAULT 1, print_group TEXT DEFAULT 'KITCHEN');
CREATE TABLE IF NOT EXISTS recipe (recipe_id TEXT PRIMARY KEY, menu_item_id TEXT NOT NULL, yield_qty REAL NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS recipe_component (recipe_component_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, ingredient_id TEXT NOT NULL, qty_per_yield REAL NOT NULL CHECK(qty_per_yield>0), note TEXT);
CREATE TABLE IF NOT EXISTS modifier_group (modifier_group_id TEXT PRIMARY KEY, name TEXT NOT NULL, min_select INTEGER NOT NULL DEFAULT 0, max_select INTEGER NOT NULL DEFAULT 3);
CREATE TABLE IF NOT EXISTS modifier_option (modifier_option_id TEXT PRIMARY KEY, modifier_group_id TEXT NOT NULL, name TEXT NOT NULL, price_delta REAL NOT NULL DEFAULT 0, ingredient_id TEXT, qty_delta REAL, UNIQUE(modifier_group_id,name));
CREATE TABLE IF NOT EXISTS menu_item_modifier_group (menu_item_id TEXT NOT NULL, modifier_group_id TEXT NOT NULL, PRIMARY KEY(menu_item_id,modifier_group_id));

CREATE TABLE IF NOT EXISTS stock_txn (stock_txn_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, product_id TEXT NOT NULL, qty REAL NOT NULL, unit_cost REAL,
 reason TEXT NOT NULL CHECK(reason IN ('PURCHASE','SALE','ADJUSTMENT','RETURN_SALE','RETURN_VENDOR')), ref_table TEXT, ref_id TEXT, happened_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT);
CREATE VIEW IF NOT EXISTS inventory_current AS SELECT store_id, product_id, SUM(qty) AS qty_on_hand FROM stock_txn GROUP BY store_id, product_id;

CREATE TABLE IF NOT EXISTS supplier (supplier_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, phone TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS purchase (purchase_id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL, store_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('DRAFT','RECEIVED','CANCELLED')), created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT);
CREATE TABLE IF NOT EXISTS purchase_line (purchase_line_id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, product_id TEXT NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL);
CREATE TRIGGER IF NOT EXISTS trg_purchase_received AFTER UPDATE OF status ON purchase
FOR EACH ROW WHEN NEW.status='RECEIVED' AND OLD.status IS NOT 'RECEIVED'
BEGIN
  INSERT INTO stock_txn(stock_txn_id, store_id, product_id, qty, unit_cost, reason, ref_table, ref_id, happened_at, created_by)
  SELECT lower(hex(randomblob(16))), NEW.store_id, pl.product_id, pl.qty, pl.unit_cost, 'PURCHASE', 'purchase', NEW.purchase_id, NEW.created_at, NEW.created_by
  FROM purchase_line pl WHERE pl.purchase_id=NEW.purchase_id;
END;

CREATE TABLE IF NOT EXISTS sale (sale_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, cashier_id TEXT, order_type TEXT NOT NULL DEFAULT 'WALKUP',
 subtotal REAL NOT NULL DEFAULT 0, tax_total REAL NOT NULL DEFAULT 0, grand_total REAL NOT NULL DEFAULT 0, tip_amount REAL NOT NULL DEFAULT 0,
 discount_amount REAL NOT NULL DEFAULT 0, price_includes_tax INTEGER NOT NULL DEFAULT 1, cogs_total REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sale_item (sale_item_id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, menu_item_id TEXT NOT NULL, qty REAL NOT NULL, unit_price REAL NOT NULL, tax_rate_id TEXT);
CREATE TABLE IF NOT EXISTS sale_item_modifier (sale_item_modifier_id TEXT PRIMARY KEY, sale_item_id TEXT NOT NULL, modifier_option_id TEXT NOT NULL, price_delta REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sale_payment (sale_payment_id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('CASH','CARD','OTHER')), amount REAL NOT NULL);

CREATE TABLE IF NOT EXISTS waste_event (waste_event_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, ingredient_id TEXT NOT NULL, qty REAL NOT NULL, reason TEXT NOT NULL, happened_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT);
CREATE TRIGGER IF NOT EXISTS trg_waste_post AFTER INSERT ON waste_event
BEGIN
  INSERT INTO stock_txn(stock_txn_id, store_id, product_id, qty, unit_cost, reason, ref_table, ref_id, happened_at, created_by)
  VALUES (lower(hex(randomblob(16))), NEW.store_id, NEW.ingredient_id, -NEW.qty, NULL, 'ADJUSTMENT','waste_event', NEW.waste_event_id, NEW.happened_at, NEW.created_by);
END;

CREATE VIEW IF NOT EXISTS menu_item_with_tax AS SELECT mi.menu_item_id, mi.sku, mi.price_retail, tr.rate AS tax_rate FROM menu_item mi LEFT JOIN tax_rate tr ON tr.tax_rate_id=mi.tax_rate_id;
CREATE TRIGGER IF NOT EXISTS trg_sale_item_insert AFTER INSERT ON sale_item
BEGIN
  INSERT INTO stock_txn(stock_txn_id, store_id, product_id, qty, unit_cost, reason, ref_table, ref_id, happened_at, created_by)
  SELECT lower(hex(randomblob(16))), s.store_id, rc.ingredient_id, -(rc.qty_per_yield*NEW.qty), NULL, 'SALE','sale', NEW.sale_id, datetime('now'), s.cashier_id
  FROM sale s JOIN recipe r ON r.menu_item_id=NEW.menu_item_id JOIN recipe_component rc ON rc.recipe_id=r.recipe_id WHERE s.sale_id=NEW.sale_id;
  UPDATE sale
  SET subtotal = ROUND(subtotal + (NEW.unit_price*NEW.qty),2),
      tax_total = ROUND(tax_total + (NEW.unit_price*NEW.qty)*COALESCE((SELECT tax_rate FROM menu_item_with_tax WHERE menu_item_id=NEW.menu_item_id),0),2),
      grand_total = ROUND(subtotal + tax_total - discount_amount + tip_amount,2)
  WHERE sale_id=NEW.sale_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_sale_item_modifier_insert AFTER INSERT ON sale_item_modifier
BEGIN
  INSERT INTO stock_txn(stock_txn_id, store_id, product_id, qty, unit_cost, reason, ref_table, ref_id, happened_at, created_by)
  SELECT lower(hex(randomblob(16))), s.store_id, mo.ingredient_id, -(mo.qty_delta*si.qty), NULL, 'SALE','sale', si.sale_id, datetime('now'), s.cashier_id
  FROM sale_item si JOIN sale s ON s.sale_id=si.sale_id JOIN modifier_option mo ON mo.modifier_option_id=NEW.modifier_option_id
  WHERE si.sale_item_id=NEW.sale_item_id AND mo.ingredient_id IS NOT NULL AND mo.qty_delta IS NOT NULL;
  UPDATE sale
  SET subtotal = ROUND(subtotal + (SELECT COALESCE(price_delta,0) FROM sale_item_modifier WHERE sale_item_modifier_id=NEW.sale_item_modifier_id),2),
      tax_total = ROUND(tax_total + (SELECT COALESCE(price_delta,0) FROM sale_item_modifier WHERE sale_item_modifier_id=NEW.sale_item_modifier_id) *
                 COALESCE((SELECT tax_rate FROM menu_item_with_tax mit JOIN sale_item si2 ON si2.menu_item_id=mit.menu_item_id WHERE si2.sale_item_id=NEW.sale_item_id),0),2),
      grand_total = ROUND(subtotal + tax_total - discount_amount + tip_amount,2)
  WHERE sale_id=(SELECT sale_id FROM sale_item WHERE sale_item_id=NEW.sale_item_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_sale_update_totals AFTER UPDATE OF tip_amount, discount_amount ON sale
BEGIN
  UPDATE sale SET grand_total = ROUND(subtotal + tax_total - NEW.discount_amount + NEW.tip_amount,2) WHERE sale_id=NEW.sale_id;
END;

-- Food cost (moving-average)
CREATE TABLE IF NOT EXISTS ingredient_cost (store_id TEXT NOT NULL, product_id TEXT NOT NULL, qty_on_hand REAL NOT NULL DEFAULT 0, avg_unit_cost REAL NOT NULL DEFAULT 0, PRIMARY KEY(store_id,product_id));
CREATE TRIGGER IF NOT EXISTS ai_stock_purchase_avg AFTER INSERT ON stock_txn
FOR EACH ROW WHEN NEW.reason='PURCHASE'
BEGIN
  INSERT INTO ingredient_cost(store_id,product_id,qty_on_hand,avg_unit_cost) VALUES(NEW.store_id,NEW.product_id,NEW.qty,COALESCE(NEW.unit_cost,0))
  ON CONFLICT(store_id,product_id) DO UPDATE SET
    avg_unit_cost = CASE WHEN (ingredient_cost.qty_on_hand + NEW.qty)<=0 THEN COALESCE(NEW.unit_cost,ingredient_cost.avg_unit_cost,0)
                         ELSE ((ingredient_cost.qty_on_hand*ingredient_cost.avg_unit_cost)+(NEW.qty*COALESCE(NEW.unit_cost,0)))
                              /(ingredient_cost.qty_on_hand + NEW.qty) END,
    qty_on_hand = ingredient_cost.qty_on_hand + NEW.qty;
END;
CREATE TRIGGER IF NOT EXISTS ai_stock_consume_onhand AFTER INSERT ON stock_txn
FOR EACH ROW WHEN NEW.reason IN ('SALE','ADJUSTMENT','RETURN_VENDOR','RETURN_SALE')
BEGIN
  INSERT INTO ingredient_cost(store_id,product_id,qty_on_hand,avg_unit_cost) VALUES(NEW.store_id,NEW.product_id,NEW.qty,0)
  ON CONFLICT(store_id,product_id) DO UPDATE SET qty_on_hand = ingredient_cost.qty_on_hand + NEW.qty;
END;
CREATE TRIGGER IF NOT EXISTS ai_stock_sale_cost AFTER INSERT ON stock_txn
FOR EACH ROW WHEN NEW.reason='SALE' AND NEW.unit_cost IS NULL
BEGIN
  UPDATE stock_txn SET unit_cost=(SELECT COALESCE(avg_unit_cost,0) FROM ingredient_cost WHERE store_id=NEW.store_id AND product_id=NEW.product_id) WHERE rowid=NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS ai_sale_cogs_rollup AFTER INSERT ON stock_txn
FOR EACH ROW WHEN NEW.reason='SALE' AND NEW.ref_table='sale' AND NEW.ref_id IS NOT NULL
BEGIN
  UPDATE sale SET cogs_total = ROUND((SELECT COALESCE(SUM(-st.qty*COALESCE(st.unit_cost,0)),0) FROM stock_txn st WHERE st.reason='SALE' AND st.ref_table='sale' AND st.ref_id=NEW.ref_id),2)
  WHERE sale_id=NEW.ref_id;
END;

CREATE VIEW IF NOT EXISTS sale_profit AS
SELECT s.sale_id, s.created_at, s.subtotal, s.tax_total, s.tip_amount, s.discount_amount, s.grand_total AS revenue, s.cogs_total AS cogs, ROUND(s.grand_total - s.cogs_total,2) AS gross_profit
FROM sale s;
CREATE VIEW IF NOT EXISTS daily_profit AS
SELECT substr(created_at,1,10) AS day, ROUND(SUM(revenue),2) AS revenue, ROUND(SUM(cogs),2) AS cogs, ROUND(SUM(revenue - cogs),2) AS gross_profit,
ROUND(CASE WHEN SUM(revenue)>0 THEN (SUM(revenue - cogs)/SUM(revenue)) ELSE NULL END,4) AS gp_margin FROM sale_profit GROUP BY substr(created_at,1,10) ORDER BY day DESC;
CREATE VIEW IF NOT EXISTS inventory_valuation AS
SELECT p.sku, p.name, COALESCE(c.qty_on_hand,0) AS qty_on_hand, COALESCE(c.avg_unit_cost,0) AS avg_unit_cost, ROUND(COALESCE(c.qty_on_hand,0)*COALESCE(c.avg_unit_cost,0),2) AS inventory_value
FROM product p LEFT JOIN ingredient_cost c ON c.product_id=p.product_id ORDER BY inventory_value DESC;

-- Seed (only if empty)
INSERT INTO store SELECT lower(hex(randomblob(16))),'Trailer-1' WHERE NOT EXISTS(SELECT 1 FROM store);
INSERT INTO app_user SELECT lower(hex(randomblob(16))),'cashier1','Front Cashier' WHERE NOT EXISTS(SELECT 1 FROM app_user);
INSERT INTO category SELECT lower(hex(randomblob(16))),'Ingredients' WHERE NOT EXISTS(SELECT 1 FROM category);
INSERT INTO tax_rate SELECT lower(hex(randomblob(16))),'Standard 21%',0.21 WHERE NOT EXISTS(SELECT 1 FROM tax_rate WHERE name='Standard 21%');
INSERT INTO unit SELECT lower(hex(randomblob(16))),'kg' WHERE NOT EXISTS(SELECT 1 FROM unit WHERE name='kg');
INSERT INTO unit SELECT lower(hex(randomblob(16))),'g' WHERE NOT EXISTS(SELECT 1 FROM unit WHERE name='g');
INSERT INTO unit SELECT lower(hex(randomblob(16))),'pcs' WHERE NOT EXISTS(SELECT 1 FROM unit WHERE name='pcs');
INSERT INTO unit SELECT lower(hex(randomblob(16))),'slice' WHERE NOT EXISTS(SELECT 1 FROM unit WHERE name='slice');
INSERT INTO product SELECT lower(hex(randomblob(16))),'BUN','Burger Bun',(SELECT category_id FROM category LIMIT 1),0,(SELECT tax_rate_id FROM tax_rate WHERE name='Standard 21%'),1,1,NULL,NULL,NULL
WHERE NOT EXISTS(SELECT 1 FROM product WHERE sku='BUN');
INSERT INTO product SELECT lower(hex(randomblob(16))),'PATTY','Beef Patty 100g',(SELECT category_id FROM category LIMIT 1),0,(SELECT tax_rate_id FROM tax_rate WHERE name='Standard 21%'),1,1,NULL,NULL,NULL
WHERE NOT EXISTS(SELECT 1 FROM product WHERE sku='PATTY');
INSERT INTO product SELECT lower(hex(randomblob(16))),'CHEESE-SL','Cheese Slice',(SELECT category_id FROM category LIMIT 1),0,(SELECT tax_rate_id FROM tax_rate WHERE name='Standard 21%'),1,1,NULL,NULL,NULL
WHERE NOT EXISTS(SELECT 1 FROM product WHERE sku='CHEESE-SL');
INSERT INTO product SELECT lower(hex(randomblob(16))),'ONION','Onion',(SELECT category_id FROM category LIMIT 1),0,(SELECT tax_rate_id FROM tax_rate WHERE name='Standard 21%'),1,1,NULL,NULL,NULL
WHERE NOT EXISTS(SELECT 1 FROM product WHERE sku='ONION');
INSERT INTO menu_item SELECT lower(hex(randomblob(16))),'BRGR','Classic Burger',8.00,(SELECT tax_rate_id FROM tax_rate WHERE name='Standard 21%'),1
WHERE NOT EXISTS(SELECT 1 FROM menu_item WHERE sku='BRGR');
INSERT INTO recipe SELECT lower(hex(randomblob(16))),(SELECT menu_item_id FROM menu_item WHERE sku='BRGR'),1
WHERE NOT EXISTS(SELECT 1 FROM recipe WHERE menu_item_id=(SELECT menu_item_id FROM menu_item WHERE sku='BRGR'));
INSERT INTO recipe_component SELECT lower(hex(randomblob(16))),(SELECT recipe_id FROM recipe JOIN menu_item USING(menu_item_id) WHERE sku='BRGR'),
(SELECT product_id FROM product WHERE sku='BUN'),1.0,'bun' WHERE NOT EXISTS(SELECT 1 FROM recipe_component WHERE ingredient_id=(SELECT product_id FROM product WHERE sku='BUN'));
INSERT INTO recipe_component SELECT lower(hex(randomblob(16))),(SELECT recipe_id FROM recipe JOIN menu_item USING(menu_item_id) WHERE sku='BRGR'),
(SELECT product_id FROM product WHERE sku='PATTY'),100.0,'beef' WHERE NOT EXISTS(SELECT 1 FROM recipe_component WHERE ingredient_id=(SELECT product_id FROM product WHERE sku='PATTY'));
INSERT INTO recipe_component SELECT lower(hex(randomblob(16))),(SELECT recipe_id FROM recipe JOIN menu_item USING(menu_item_id) WHERE sku='BRGR'),
(SELECT product_id FROM product WHERE sku='CHEESE-SL'),1.0,'cheese' WHERE NOT EXISTS(SELECT 1 FROM recipe_component WHERE ingredient_id=(SELECT product_id FROM product WHERE sku='CHEESE-SL'));
INSERT INTO recipe_component SELECT lower(hex(randomblob(16))),(SELECT recipe_id FROM recipe JOIN menu_item USING(menu_item_id) WHERE sku='BRGR'),
(SELECT product_id FROM product WHERE sku='ONION'),20.0,'onion' WHERE NOT EXISTS(SELECT 1 FROM recipe_component WHERE ingredient_id=(SELECT product_id FROM product WHERE sku='ONION'));
`;

// --- Boot ---
let SQL, db;

// register SW
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("./sw.js"); }

// install prompt
let deferredPrompt=null;
window.addEventListener("beforeinstallprompt", (e)=>{ e.preventDefault(); deferredPrompt=e; });
document.getElementById("btn-install").onclick = async ()=>{
  if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; }
};

// print (AirPrint)
document.getElementById("btn-print").onclick = ()=> window.print();

// init sql.js + db
(async function init(){
  SQL = await initSqlJs({ locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${f}` });
  const saved = await idb.get();
  db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
  if (!saved) runBatch(schema);
  await refresh();
})();

// --- helpers ---
function run(sql, params=[]) { db.run(sql, params); }
function select(sql, params=[]) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows=[]; while(stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
function runBatch(sql) {
  sql.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean).forEach(s=>{ try{ db.run(s); } catch(e){ console.warn(e, s);} });
}
async function persist() { const data = db.export(); await idb.set(data); }

function renderTable(containerId, rows){
  const el = document.getElementById(containerId);
  if (!rows.length) { el.innerHTML = '<div class="muted">No data</div>'; return; }
  const cols = Object.keys(rows[0]);
  el.innerHTML = `<table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r=>`<tr>${cols.map(c=>`<td class="${isNaN(r[c])?'':'right'}">${r[c]??''}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

async function refresh(){
  renderTable("stock-table", select(`
    SELECT p.sku, p.name, COALESCE(ic.qty_on_hand,0) AS qty
    FROM product p LEFT JOIN inventory_current ic ON ic.product_id=p.product_id
    WHERE p.is_ingredient=1 ORDER BY qty ASC LIMIT 50
  `));
  renderTable("profit-table", select(`SELECT * FROM daily_profit ORDER BY day DESC LIMIT 14`));
  const tfc = select(`
    SELECT mi.name AS menu_item,
           ROUND(SUM(rc.qty_per_yield*COALESCE(c.avg_unit_cost,0)),4) AS food_cost,
           mi.price_retail,
           ROUND(CASE WHEN mi.price_retail>0 THEN
             SUM(rc.qty_per_yield*COALESCE(c.avg_unit_cost,0))/mi.price_retail END,4) AS cost_pct
    FROM menu_item mi
    JOIN recipe r ON r.menu_item_id=mi.menu_item_id
    JOIN recipe_component rc ON rc.recipe_id=r.recipe_id
    LEFT JOIN ingredient_cost c ON c.product_id=rc.ingredient_id
    GROUP BY mi.menu_item_id, mi.name, mi.price_retail
    ORDER BY cost_pct DESC
  `);
  renderTable("tfc-table", tfc);
  await persist();
}

// --- UI actions ---
document.getElementById("btn-sell").onclick = async ()=>{
  const sku = document.getElementById("sale-sku").value.trim();
  const price = parseFloat(document.getElementById("sale-price").value||"0");
  const qty = parseFloat(document.getElementById("sale-qty").value||"1");
  const tip = parseFloat(document.getElementById("sale-tip").value||"0");
  // sale header
  run(`INSERT INTO sale(sale_id,store_id,cashier_id,order_type,tip_amount,discount_amount)
       VALUES (lower(hex(randomblob(16))), (SELECT store_id FROM store LIMIT 1), (SELECT user_id FROM app_user LIMIT 1),'WALKUP', ?, 0.0)`, [tip]);
  // sale line (triggers handle stock + totals)
  run(`INSERT INTO sale_item(sale_item_id,sale_id,menu_item_id,qty,unit_price,tax_rate_id)
       VALUES (lower(hex(randomblob(16))), (SELECT sale_id FROM sale ORDER BY rowid DESC LIMIT 1),
               (SELECT menu_item_id FROM menu_item WHERE sku=?), ?, ?, (SELECT tax_rate_id FROM menu_item WHERE sku=?))`,
       [sku, qty, price, sku]);
  // payment
  run(`INSERT INTO sale_payment(sale_payment_id,sale_id,method,amount)
       VALUES (lower(hex(randomblob(16))), (SELECT sale_id FROM sale ORDER BY rowid DESC LIMIT 1), 'CASH', 10.00)`);
  const last = select(`SELECT created_at,revenue,cogs,gross_profit FROM sale_profit ORDER BY created_at DESC LIMIT 1`)[0] || {};
  document.getElementById("sales-log").textContent =
    `Sold ${sku} → Rev ${last.revenue} COGS ${last.cogs} GP ${last.gross_profit}`;
  await refresh();
};

document.getElementById("btn-add-menu").onclick = async ()=>{
  const sku = document.getElementById("menu-sku").value.trim();
  const name = document.getElementById("menu-name").value.trim();
  const price = parseFloat(document.getElementById("menu-price").value||"0");
  if(!sku || !name || !price) { alert("Fill SKU, Name, Price"); return; }
  run(`INSERT INTO menu_item(menu_item_id,sku,name,price_retail,tax_rate_id,active)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, (SELECT tax_rate_id FROM tax_rate WHERE name='Standard 21%'),1)`, [sku,name,price]);
  run(`INSERT INTO recipe(recipe_id,menu_item_id,yield_qty) VALUES (lower(hex(randomblob(16))), (SELECT menu_item_id FROM menu_item WHERE sku=?), 1)`, [sku]);
  // simple recipe = 1x BUN
  run(`INSERT INTO recipe_component(recipe_component_id,recipe_id,ingredient_id,qty_per_yield,note)
       VALUES (lower(hex(randomblob(16))), (SELECT recipe_id FROM recipe JOIN menu_item USING(menu_item_id) WHERE sku=?),
               (SELECT product_id FROM product WHERE sku='BUN'), 1.0, 'bun')`, [sku]);
  await refresh();
  alert("Menu added.");
};

document.getElementById("btn-receive").onclick = async ()=>{
  const sku = document.getElementById("rx-sku").value;
  const qty = parseFloat(document.getElementById("rx-qty").value||"0");
  const cost = parseFloat(document.getElementById("rx-cost").value||"0");
  run(`INSERT INTO supplier(supplier_id,name) VALUES (lower(hex(randomblob(16))),'Acme') ON CONFLICT(name) DO NOTHING`);
  run(`INSERT INTO purchase(purchase_id,supplier_id,store_id,status,created_by)
       VALUES (lower(hex(randomblob(16))), (SELECT supplier_id FROM supplier WHERE name='Acme'),
               (SELECT store_id FROM store LIMIT 1), 'DRAFT', (SELECT user_id FROM app_user LIMIT 1))`);
  run(`INSERT INTO purchase_line(purchase_line_id,purchase_id,product_id,qty,unit_cost)
       SELECT lower(hex(randomblob(16))), (SELECT purchase_id FROM purchase ORDER BY rowid DESC LIMIT 1),
              (SELECT product_id FROM product WHERE sku=?), ?, ?`, [sku, qty, cost]);
  run(`UPDATE purchase SET status='RECEIVED' WHERE purchase_id=(SELECT purchase_id FROM purchase ORDER BY rowid DESC LIMIT 1)`);
  await refresh();
};

document.getElementById("btn-waste").onclick = async ()=>{
  const sku = document.getElementById("waste-sku").value;
  const qty = parseFloat(document.getElementById("waste-qty").value||"0");
  run(`INSERT INTO waste_event(waste_event_id,store_id,ingredient_id,qty,reason,created_by)
       VALUES (lower(hex(randomblob(16))), (SELECT store_id FROM store LIMIT 1),
               (SELECT product_id FROM product WHERE sku=?), ?, 'spoilage', (SELECT user_id FROM app_user LIMIT 1))`, [sku, qty]);
  await refresh();
};

// import/export
document.getElementById("file-import").onchange = async (e)=>{
  const file = e.target.files?.[0]; if(!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  db = new SQL.Database(buf);
  await persist(); await refresh(); alert("DB imported.");
};
document.getElementById("btn-export").onclick = ()=>{
  const data = db.export();
  const blob = new Blob([data], {type:"application/octet-stream"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "trailer_pos.db"; a.click();
};
