require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const path = require('path');
const fs = require('fs');

const usersRouter    = require('./routes/users');
const productsRouter = require('./routes/products');
const ordersRouter   = require('./routes/orders');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Swagger UI ──────────────────────────────────────────────────────────────
// Usa el spec generado por swagger-autogen (swagger-output.json).
// Si aún no existe (primera ejecución local antes del pipeline), cae a un
// objeto mínimo para que el servidor arranque sin explotar.
const swaggerOutputPath = path.join(__dirname, '../swagger-output.json');

let swaggerSpec = { openapi: '3.0.0', info: { title: 'API', version: '1.0.0' }, paths: {} };
if (fs.existsSync(swaggerOutputPath)) {
  swaggerSpec = JSON.parse(fs.readFileSync(swaggerOutputPath, 'utf8'));
}

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'API Test Generator - Docs',
}));

// El generador de pruebas obtiene el spec desde este endpoint
app.get('/api-docs.json', (req, res) => {
  // Recargar en cada petición por si el archivo fue regenerado
  if (fs.existsSync(swaggerOutputPath)) {
    res.json(JSON.parse(fs.readFileSync(swaggerOutputPath, 'utf8')));
  } else {
    res.json(swaggerSpec);
  }
});

// ── Rutas ───────────────────────────────────────────────────────────────────
app.use('/api/users',    usersRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders',   ordersRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor', message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 API corriendo en http://localhost:${PORT}`);
  console.log(`📄 Swagger UI:   http://localhost:${PORT}/api-docs`);
  console.log(`📦 OpenAPI JSON: http://localhost:${PORT}/api-docs.json\n`);
});

module.exports = app;
