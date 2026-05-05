/**
 * swagger-gen.js
 *
 * Genera el contrato OpenAPI/Swagger automáticamente leyendo las
 * rutas de Express. Los devs solo escriben endpoints; este script
 * se ejecuta como primer paso del pipeline CI/CD para que el
 * contrato siempre refleje el estado real del código.
 *
 * Herramienta: swagger-autogen (determinística, sin LLM).
 */

const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.0' });
const path = require('path');

const outputFile = path.join(__dirname, '../swagger-output.json');

// Archivos donde están definidas las rutas (swagger-autogen las escanea)
const endpointsFiles = [
  path.join(__dirname, '../src/routes/users.js'),
  path.join(__dirname, '../src/routes/products.js'),
  path.join(__dirname, '../src/routes/orders.js'),
];

const doc = {
  info: {
    title: 'API REST de Prueba - Prototipo Tesis',
    version: '1.0.0',
    description:
      'Contrato generado automáticamente por swagger-autogen a partir del código fuente. ' +
      'Tesis: "Desarrollo de un prototipo para la generación automatizada de casos de prueba ' +
      'en APIs REST mediante modelos de lenguaje integrados en pipelines CI/CD".',
  },
  servers: [
    {
      url: process.env.API_BASE_URL || 'http://localhost:3000',
      description: 'Servidor local / CI runner',
    },
  ],
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id:        { type: 'integer',  example: 1 },
          name:      { type: 'string',   example: 'Ana García' },
          email:     { type: 'string',   format: 'email', example: 'ana@example.com' },
          role:      { type: 'string',   enum: ['admin', 'user', 'viewer'], example: 'user' },
          createdAt: { type: 'string',   format: 'date-time' },
        },
      },
      Product: {
        type: 'object',
        properties: {
          id:       { type: 'integer', example: 1 },
          name:     { type: 'string',  example: 'Laptop Pro 15' },
          price:    { type: 'number',  example: 1299.99 },
          stock:    { type: 'integer', example: 50 },
          category: { type: 'string',  example: 'Electrónica' },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id:        { type: 'integer', example: 1 },
          userId:    { type: 'integer', example: 1 },
          productId: { type: 'integer', example: 1 },
          quantity:  { type: 'integer', minimum: 1, example: 2 },
          status:    { type: 'string',  enum: ['pending','confirmed','shipped','delivered','cancelled'] },
          total:     { type: 'number',  example: 2599.98 },
          createdAt: { type: 'string',  format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error:   { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
};

console.log('📐 Generando contrato OpenAPI desde el código fuente...');

swaggerAutogen(outputFile, endpointsFiles, doc).then(({ success }) => {
  if (success) {
    const spec = require(outputFile);
    const endpointCount = Object.keys(spec.paths || {}).length;
    console.log(`✅ Contrato generado: ${outputFile}`);
    console.log(`   Endpoints detectados: ${endpointCount}`);
    console.log('   El contrato refleja el estado actual del código.\n');
  } else {
    console.error('❌ swagger-autogen falló');
    process.exit(1);
  }
});
