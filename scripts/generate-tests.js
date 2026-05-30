#!/usr/bin/env node
/**
 * generate-tests.js
 *
 * Script principal del prototipo: lee el spec OpenAPI de la API,
 * lo envía a GPT-4o y genera automáticamente una colección de Postman
 * lista para ejecutar con Newman en el pipeline CI/CD.
 *
 * Tesis: "Desarrollo de un prototipo para la generación automatizada
 * de casos de prueba en APIs REST mediante modelos de lenguaje
 * integrados en pipelines CI/CD"
 *
 * CORRECCIÓN v3:
 * - Prompt exhaustivo con lista explícita de endpoints
 * - Generación libre de casos (el modelo decide cantidad según criterio QA)
 * - Temperatura 0.4 para variación natural entre iteraciones
 * - Elimina redundancia por diseño
 * - max_tokens ajustado a 16384 (límite máximo de gpt-4o)
 */

require('dotenv').config();
const OpenAI = require('openai');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { uploadToS3 } = require('../src/utils/s3-uploader');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const API_BASE_URL   = process.env.API_BASE_URL  || 'http://localhost:3000';
const MODEL          = process.env.OPENAI_MODEL  || 'gpt-4o';
const POSTMAN_OUTPUT = path.join(__dirname, '../postman/collection.json');

// ─────────────────────────────────────────────
// 1. Obtener el spec OpenAPI desde la API viva
// ─────────────────────────────────────────────
async function fetchOpenAPISpec() {
  console.log(`📄 Obteniendo spec OpenAPI desde ${API_BASE_URL}/api-docs.json ...`);
  try {
    const res = await axios.get(`${API_BASE_URL}/api-docs.json`);
    console.log(`✅ Spec obtenido. Endpoints encontrados: ${Object.keys(res.data.paths || {}).length}`);
    return res.data;
  } catch (err) {
    throw new Error(`No se pudo obtener el spec de OpenAPI: ${err.message}\nAsegúrate que la API esté corriendo en ${API_BASE_URL}`);
  }
}

/**
 * Extrae la lista exacta de METHOD + PATH del spec OpenAPI.
 * Excluye endpoints de infraestructura (/api-docs.json)
 * que no son parte del contrato funcional de la API.
 */
function extractEndpointList(openAPISpec) {
  const httpMethods = ['get','post','put','patch','delete'];
  const excluded    = ['/api-docs.json', '/health'];
  const endpoints   = [];

  for (const [routePath, methods] of Object.entries(openAPISpec.paths || {})) {
    if (excluded.includes(routePath)) continue;
    for (const method of Object.keys(methods)) {
      if (httpMethods.includes(method.toLowerCase())) {
        endpoints.push(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }
  return endpoints;
}

// ─────────────────────────────────────────────
// 2. Llamar a GPT-4o para generar los test cases
// ─────────────────────────────────────────────
async function generateTestsWithLLM(openAPISpec) {
  console.log(`\n🤖 Enviando spec a ${MODEL} para generar casos de prueba...`);

  const endpointList    = extractEndpointList(openAPISpec);
  const endpointListStr = endpointList.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
  const totalEndpoints  = endpointList.length;

const systemPrompt = `Eres un experto en QA y pruebas de APIs REST. Generas colecciones Postman listas para Newman.

REGLAS CRÍTICAS:
1. Responde ÚNICAMENTE con JSON válido. Sin texto, sin comentarios, sin markdown.
2. COBERTURA OBLIGATORIA: genera casos para TODOS los ${totalEndpoints} endpoints de la lista. Sin excepción.
3. Para cada endpoint, genera los casos de prueba que consideres necesarios:
   - Caso exitoso (status 2xx) — obligatorio para cada endpoint
   - Casos negativos: datos inválidos, campos faltantes, IDs inexistentes (99999), valores fuera de rango (cero, negativos), formatos incorrectos
   Usa tu criterio profesional de QA para decidir cuántos y cuáles casos negativos son relevantes para cada endpoint.
4. Para casos negativos, incluye pruebas de valores de borde: cantidades en cero, precios negativos, cadenas vacías, y valores fuera de los enums permitidos.
5. ORDEN DE EJECUCIÓN OBLIGATORIO dentro de cada carpeta:
   a) Primero: POST exitoso → DEBE guardar el ID con pm.collectionVariables.set()
   b) Luego: GET, PUT, PATCH exitosos usando {{userId}}, {{productId}} o {{orderId}}
   c) Luego: casos negativos (datos inválidos, IDs inexistentes como 99999)
   d) Último: DELETE exitoso usando el ID guardado
   Este orden es crítico. Si POST no va primero, los demás fallan con 404.
6. Los POST exitosos DEBEN enviar datos válidos que la API acepte:
   - Users: {"name": "Test User", "email": "test@example.com", "role": "user"}
   - Products: {"name": "Test Product", "price": 99.99, "stock": 10, "category": "General"}
   - Orders: {"userId": 1, "productId": 1, "quantity": 2}
7. Cada request incluye script de test: status code + tiempo de respuesta (<2000ms).
8. Usa "{{baseUrl}}" para URLs. URLs EXACTAS del spec, nunca rutas genéricas.
9. Para PATCH /api/orders/{id}/status, usa el orderId guardado por POST, NO un ID hardcodeado.
10. El JSON debe estar completo y bien cerrado.`;

  const userPrompt = `Genera una colección Postman para esta API.

ENDPOINTS (${totalEndpoints} — cubre TODOS):
${endpointListStr}

OpenAPI Spec:
${JSON.stringify(openAPISpec, null, 2)}

Variables de colección: baseUrl="${API_BASE_URL}", userId, productId, orderId
Carpetas: Users, Products, Orders (cada una con POST exitoso PRIMERO)

Formato Postman v2.1:
{
  "info": { "name": "API Test Generator - Colección Automática (${new Date().toISOString()})", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "variable": [
    { "key": "baseUrl", "value": "${API_BASE_URL}" },
    { "key": "userId", "value": "" },
    { "key": "productId", "value": "" },
    { "key": "orderId", "value": "" }
  ],
  "item": [ ... ]
}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 16384,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    temperature: 0.4,
  });

  const rawContent = response.choices[0].message.content.trim();
  const cleaned    = rawContent.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();

  console.log(`✅ GPT-4o generó respuesta (${rawContent.length} caracteres)`);
  console.log(`📊 Tokens usados: prompt=${response.usage.prompt_tokens}, completion=${response.usage.completion_tokens}, total=${response.usage.total_tokens}`);

  // Advertir si se acercó al límite
  if (response.usage.completion_tokens >= 15000) {
    console.warn(`⚠️  Completion tokens (${response.usage.completion_tokens}) cerca del límite. Verificar JSON completo.`);
  }

  return { raw: cleaned, usage: response.usage };
}

// ─────────────────────────────────────────────
// 3. Parsear y enriquecer la colección generada
// ─────────────────────────────────────────────
function parseAndEnrichCollection(rawJson, openAPISpec) {
  let collection;
  try {
    collection = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`GPT-4o no generó JSON válido: ${e.message}\nContenido recibido:\n${rawJson.substring(0, 500)}...`);
  }

  if (!collection.info) collection.info = {};
  collection.info.schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

  collection._generatedBy = 'api-test-generator-llm';
  collection._generatedAt = new Date().toISOString();
  collection._sourceSpec  = openAPISpec.info?.title || 'Unknown API';
  collection._model       = MODEL;

  return collection;
}

// ─────────────────────────────────────────────
// 4. Contar requests en la colección
// ─────────────────────────────────────────────
function countRequests(collection) {
  let count = 0;
  function traverse(items) {
    if (!items) return;
    for (const item of items) {
      if (item.item) traverse(item.item);
      else count++;
    }
  }
  traverse(collection.item);
  return count;
}

// ─────────────────────────────────────────────
// 5. Guardar colección y métricas
// ─────────────────────────────────────────────
async function saveResults(collection, metrics) {
  fs.mkdirSync(path.dirname(POSTMAN_OUTPUT), { recursive: true });
  fs.writeFileSync(POSTMAN_OUTPUT, JSON.stringify(collection, null, 2));
  console.log(`\n💾 Colección guardada en: ${POSTMAN_OUTPUT}`);

  const metricsDir  = path.join(__dirname, '../reports');
  fs.mkdirSync(metricsDir, { recursive: true });
  const metricsPath = path.join(metricsDir, 'generation-metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`📈 Métricas guardadas en: ${metricsPath}`);

  if (process.env.AWS_ACCESS_KEY_ID && process.env.S3_BUCKET_NAME) {
    try {
      await uploadToS3(POSTMAN_OUTPUT, `collections/collection-${metrics.timestamp}.json`);
      await uploadToS3(metricsPath,    `metrics/generation-${metrics.timestamp}.json`);
      console.log('☁️  Resultados subidos a S3');
    } catch (err) {
      console.warn(`⚠️  No se pudo subir a S3: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('  🧪 API Test Generator - Generación con LLM');
  console.log('═'.repeat(60));

  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const openAPISpec = await fetchOpenAPISpec();
    const { raw, usage } = await generateTestsWithLLM(openAPISpec);
    const collection = parseAndEnrichCollection(raw, openAPISpec);

    const requestCount = countRequests(collection);
    const duration     = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n📋 Casos de prueba generados: ${requestCount}`);
    console.log(`⏱️  Tiempo de generación: ${duration}s`);

    const metrics = {
      timestamp,
      model: MODEL,
      generationDurationSeconds: parseFloat(duration),
      casesGenerated: requestCount,
      tokensUsed: usage,
      apiEndpoints: extractEndpointList(openAPISpec).length,
      sourceApi: openAPISpec.info?.title,
    };

    await saveResults(collection, metrics);

    console.log('\n✅ Generación completada exitosamente');
    console.log('▶️  Para ejecutar las pruebas: npm run run-tests');
    console.log('═'.repeat(60));
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
