#!/usr/bin/env node
/**
 * inject-faults.js
 *
 * Inyecta fallos controlados en la API modificando temporalmente los
 * handlers de Express EN MEMORIA (sin tocar los archivos fuente).
 * Esto simula bugs reales para medir cuántos detecta la suite generada.
 *
 * Variable dependiente medida: tasa de detección de fallos (% fallos
 * detectados / fallos inyectados).
 *
 * Uso:
 *   node scripts/inject-faults.js          → inyecta todos los fallos
 *   node scripts/inject-faults.js --list   → muestra el catálogo
 *   node scripts/inject-faults.js --id 3   → inyecta solo el fallo #3
 *
 * Funciona iniciando la API con los fallos activos (puerto configurable)
 * y terminando con un JSON de resultados en reports/fault-report.json.
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────
// Catálogo de fallos
// ─────────────────────────────────────────────
const FAULT_CATALOG = [
  {
    id: 1,
    name: 'POST /api/users devuelve 200 en lugar de 201',
    endpoint: 'POST /api/users',
    type: 'wrong_status_code',
    description: 'Creación exitosa retorna 200 en vez de 201. Rompe assertions de status.',
  },
  {
    id: 2,
    name: 'GET /api/users/:id con ID inexistente devuelve 200 vacío en vez de 404',
    endpoint: 'GET /api/users/:id',
    type: 'missing_error_handling',
    description: 'El 404 está suprimido; devuelve {} con status 200.',
  },
  {
    id: 3,
    name: 'POST /api/users acepta email inválido sin validar',
    endpoint: 'POST /api/users',
    type: 'missing_validation',
    description: 'La validación de formato email está deshabilitada. Acepta "notanemail".',
  },
  {
    id: 4,
    name: 'GET /api/products filtra mal por minPrice',
    endpoint: 'GET /api/products?minPrice=X',
    type: 'wrong_filter_logic',
    description: 'El filtro minPrice usa > en lugar de >=, excluyendo el límite exacto.',
  },
  {
    id: 5,
    name: 'POST /api/orders acepta quantity=0',
    endpoint: 'POST /api/orders',
    type: 'missing_validation',
    description: 'La validación de quantity mínima está desactivada. Permite 0.',
  },
  {
    id: 6,
    name: 'PATCH /api/orders/:id/status acepta status inválido',
    endpoint: 'PATCH /api/orders/:id/status',
    type: 'missing_validation',
    description: 'La validación de enum de status está desactivada.',
  },
  {
    id: 7,
    name: 'POST /api/products con price negativo devuelve 201',
    endpoint: 'POST /api/products',
    type: 'missing_validation',
    description: 'La validación de price > 0 está desactivada.',
  },
  {
    id: 8,
    name: 'DELETE /api/users/:id devuelve 404 siempre aunque el usuario exista',
    endpoint: 'DELETE /api/users/:id',
    type: 'wrong_status_code',
    description: 'El handler siempre retorna 404, incluso para IDs válidos.',
  },
];

// ─────────────────────────────────────────────
// Routers con fallos inyectados
// ─────────────────────────────────────────────
function buildFaultyRouters(activeIds) {
  const active = new Set(activeIds);

  // ── USERS ──────────────────────────────────
  const users = express.Router();
  let usersDb = [
    { id: 1, name: 'Ana García',    email: 'ana@example.com',    role: 'admin', createdAt: new Date().toISOString() },
    { id: 2, name: 'Carlos López',  email: 'carlos@example.com', role: 'user',  createdAt: new Date().toISOString() },
  ];
  let userNextId = 3;

  users.get('/', (req, res) => {
    let result = [...usersDb];
    if (req.query.role) result = result.filter(u => u.role === req.query.role);
    res.json(result);
  });

  users.get('/:id', (req, res) => {
    const user = usersDb.find(u => u.id === parseInt(req.params.id));
    // FALLO 2: devuelve {} con 200 en vez de 404
    if (!user) return active.has(2)
      ? res.status(200).json({})
      : res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  });

  users.post('/', (req, res) => {
    const { name, email, role = 'user' } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name y email son requeridos' });
    if (name.length < 2)  return res.status(400).json({ error: 'Nombre muy corto' });

    // FALLO 3: sin validación de email
    if (!active.has(3) && !email.includes('@'))
      return res.status(400).json({ error: 'Email inválido' });

    if (!['admin','user','viewer'].includes(role))
      return res.status(400).json({ error: 'Rol inválido' });
    if (usersDb.find(u => u.email === email))
      return res.status(409).json({ error: 'Email ya registrado' });

    const newUser = { id: userNextId++, name, email, role, createdAt: new Date().toISOString() };
    usersDb.push(newUser);

    // FALLO 1: 200 en vez de 201
    res.status(active.has(1) ? 200 : 201).json(newUser);
  });

  users.put('/:id', (req, res) => {
    const index = usersDb.findIndex(u => u.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { name, email, role } = req.body;
    if (role && !['admin','user','viewer'].includes(role))
      return res.status(400).json({ error: 'Rol inválido' });
    usersDb[index] = { ...usersDb[index], ...(name && { name }), ...(email && { email }), ...(role && { role }) };
    res.json(usersDb[index]);
  });

  users.delete('/:id', (req, res) => {
    const index = usersDb.findIndex(u => u.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
    // FALLO 8: siempre 404 aunque el usuario exista
    if (active.has(8)) return res.status(404).json({ error: 'Fallo inyectado' });
    const deleted = usersDb.splice(index, 1)[0];
    res.json({ message: 'Usuario eliminado', user: deleted });
  });

  // ── PRODUCTS ───────────────────────────────
  const products = express.Router();
  let productsDb = [
    { id: 1, name: 'Laptop Pro 15',       price: 1299.99, stock: 50,  category: 'Electrónica' },
    { id: 2, name: 'Teclado Mecánico RGB', price: 89.99,   stock: 200, category: 'Periféricos' },
    { id: 3, name: 'Monitor 4K 27"',       price: 449.99,  stock: 30,  category: 'Electrónica' },
  ];
  let productNextId = 4;

  products.get('/', (req, res) => {
    let result = [...productsDb];
    if (req.query.category) result = result.filter(p => p.category === req.query.category);
    if (req.query.minPrice) {
      const min = parseFloat(req.query.minPrice);
      // FALLO 4: > en vez de >=
      result = result.filter(p => active.has(4) ? p.price > min : p.price >= min);
    }
    if (req.query.maxPrice) result = result.filter(p => p.price <= parseFloat(req.query.maxPrice));
    if (req.query.inStock === 'true') result = result.filter(p => p.stock > 0);
    res.json(result);
  });

  products.get('/:id', (req, res) => {
    const p = productsDb.find(p => p.id === parseInt(req.params.id));
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(p);
  });

  products.post('/', (req, res) => {
    const { name, price, stock, category } = req.body;
    if (!name || price === undefined || stock === undefined)
      return res.status(400).json({ error: 'name, price y stock son requeridos' });

    // FALLO 7: sin validación de precio negativo
    if (!active.has(7) && price <= 0)
      return res.status(400).json({ error: 'El precio debe ser mayor a 0' });

    if (stock < 0) return res.status(400).json({ error: 'Stock no puede ser negativo' });
    const np = { id: productNextId++, name, price: parseFloat(price), stock: parseInt(stock), category: category || 'General' };
    productsDb.push(np);
    res.status(201).json(np);
  });

  products.patch('/:id', (req, res) => {
    const index = productsDb.findIndex(p => p.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Producto no encontrado' });
    const { stock } = req.body;
    if (stock === undefined || stock < 0) return res.status(400).json({ error: 'Stock inválido' });
    productsDb[index].stock = parseInt(stock);
    res.json(productsDb[index]);
  });

  products.delete('/:id', (req, res) => {
    const index = productsDb.findIndex(p => p.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ message: 'Producto eliminado', product: productsDb.splice(index, 1)[0] });
  });

  // ── ORDERS ─────────────────────────────────
  const orders = express.Router();
  let ordersDb = [
    { id: 1, userId: 1, productId: 1, quantity: 1, status: 'confirmed', total: 1299.99, createdAt: new Date().toISOString() },
  ];
  let orderNextId = 2;

  orders.get('/', (req, res) => {
    let result = [...ordersDb];
    if (req.query.status)  result = result.filter(o => o.status  === req.query.status);
    if (req.query.userId)  result = result.filter(o => o.userId  === parseInt(req.query.userId));
    res.json(result);
  });

  orders.get('/:id', (req, res) => {
    const o = ordersDb.find(o => o.id === parseInt(req.params.id));
    if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json(o);
  });

  orders.post('/', (req, res) => {
    const { userId, productId, quantity } = req.body;
    if (!userId || !productId || !quantity)
      return res.status(400).json({ error: 'userId, productId y quantity son requeridos' });

    // FALLO 5: sin validación de quantity mínima
    if (!active.has(5) && quantity < 1)
      return res.status(400).json({ error: 'La cantidad mínima es 1' });

    const no = { id: orderNextId++, userId: parseInt(userId), productId: parseInt(productId), quantity: parseInt(quantity), status: 'pending', total: null, createdAt: new Date().toISOString() };
    ordersDb.push(no);
    res.status(201).json(no);
  });

  orders.patch('/:id/status', (req, res) => {
    const index = ordersDb.findIndex(o => o.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Orden no encontrada' });
    const validStatuses = ['pending','confirmed','shipped','delivered','cancelled'];
    const { status } = req.body;

    // FALLO 6: sin validación de enum
    if (!active.has(6) && (!status || !validStatuses.includes(status)))
      return res.status(400).json({ error: `Estado inválido. Use: ${validStatuses.join(', ')}` });

    ordersDb[index].status = status;
    res.json(ordersDb[index]);
  });

  orders.delete('/:id', (req, res) => {
    const index = ordersDb.findIndex(o => o.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json({ message: 'Orden eliminada', order: ordersDb.splice(index, 1)[0] });
  });

  return { users, products, orders };
}

// ─────────────────────────────────────────────
// Servidor con fallos inyectados
// ─────────────────────────────────────────────
function startFaultyServer(activeIds, port) {
  const app = express();
  app.use(cors());
  app.use(morgan('tiny'));
  app.use(express.json());

  const { users, products, orders } = buildFaultyRouters(activeIds);
  app.use('/api/users',    users);
  app.use('/api/products', products);
  app.use('/api/orders',   orders);
  app.get('/health', (req, res) => res.json({ status: 'ok', faults: activeIds }));

  return new Promise(resolve => {
    const server = app.listen(port, () => {
      console.log(`🐛 Servidor con fallos corriendo en :${port}`);
      console.log(`   Fallos activos: [${activeIds.join(', ')}]\n`);
      resolve(server);
    });
  });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('\n📋 Catálogo de fallos disponibles:\n');
    FAULT_CATALOG.forEach(f => {
      console.log(`  #${f.id} [${f.type}]`);
      console.log(`     ${f.name}`);
      console.log(`     ${f.description}\n`);
    });
    process.exit(0);
  }

  const idIndex = args.indexOf('--id');
  const activeIds = idIndex !== -1
    ? [parseInt(args[idIndex + 1])]
    : FAULT_CATALOG.map(f => f.id);

  const PORT = parseInt(process.env.FAULT_PORT || 3001);
  const COLLECTION = path.join(__dirname, '../postman/collection.json');
  const REPORT_DIR = path.join(__dirname, '../reports');
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const faultReportPath = path.join(REPORT_DIR, 'fault-newman-report.json');

  console.log('═'.repeat(60));
  console.log('  🐛 Inyección de Fallos Controlada');
  console.log('═'.repeat(60));

  const server = await startFaultyServer(activeIds, PORT);

  // Ejecutar Newman contra el servidor con fallos
  const collectionStr = fs.readFileSync(COLLECTION, 'utf8');
  const collection = JSON.parse(collectionStr);

  // Reemplazar baseUrl para apuntar al servidor con fallos
  const faultyCollection = JSON.parse(JSON.stringify(collection));
  if (faultyCollection.variable) {
    faultyCollection.variable = faultyCollection.variable.map(v =>
      v.key === 'baseUrl' ? { ...v, value: `http://localhost:${PORT}` } : v
    );
  }
  const tmpCollection = path.join(REPORT_DIR, 'faulty-collection-tmp.json');
  fs.writeFileSync(tmpCollection, JSON.stringify(faultyCollection, null, 2));

  console.log('▶️  Ejecutando Newman contra servidor con fallos...\n');
  let newmanExitCode = 0;
  try {
execSync(
  `npx newman run ${tmpCollection} --reporters cli,json --reporter-json-export ${faultReportPath} --timeout-request 5000`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    newmanExitCode = e.status || 1;
  }

  // Analizar resultados
  let detected = 0, total = 0;
  if (fs.existsSync(faultReportPath)) {
    const report = JSON.parse(fs.readFileSync(faultReportPath, 'utf8'));
    const stats  = report.run?.stats || {};
    total    = stats.assertions?.total  || 0;
    detected = stats.assertions?.failed || 0;
  }

  const faultSummary = {
    timestamp:       new Date().toISOString(),
    faultsInjected:  activeIds.length,
    faultIds:        activeIds,
    faultsCatalog:   FAULT_CATALOG.filter(f => activeIds.includes(f.id)),
    assertionsTotal: total,
    failuresDetected: detected,
    detectionRate:   total ? ((detected / total) * 100).toFixed(2) + '%' : '0%',
  };

  const summaryPath = path.join(REPORT_DIR, 'fault-injection-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(faultSummary, null, 2));

  console.log('\n═'.repeat(60));
  console.log('  RESULTADO — INYECCIÓN DE FALLOS');
  console.log('═'.repeat(60));
  console.log(`Fallos inyectados:   ${faultSummary.faultsInjected}`);
  console.log(`Assertions totales:  ${faultSummary.assertionsTotal}`);
  console.log(`Fallos detectados:   ${faultSummary.failuresDetected}`);
  console.log(`Tasa de detección:   ${faultSummary.detectionRate}`);
  console.log('═'.repeat(60));

  fs.unlinkSync(tmpCollection);
  server.close();
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
