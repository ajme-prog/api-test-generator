#!/usr/bin/env node
/**
 * generate-tests.js
 * 
 * Script principal del prototipo: lee el spec OpenAPI de la API,
 * lo envía a GPT-4 y genera automáticamente una colección de Postman
 * lista para ejecutar con Newman en el pipeline CI/CD.
 * 
 * Tesis: "Desarrollo de un prototipo para la generación automatizada
 * de casos de prueba en APIs REST mediante modelos de lenguaje
 * integrados en pipelines CI/CD"
 */

require('dotenv').config();
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { uploadToS3 } = require('../src/utils/s3-uploader');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
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

// ─────────────────────────────────────────────
// 2. Llamar a GPT-4 para generar los test cases
// ─────────────────────────────────────────────
async function generateTestsWithLLM(openAPISpec) {
  console.log(`\n🤖 Enviando spec a ${MODEL} para generar casos de prueba...`);

  const systemPrompt = `Eres un experto en QA y pruebas de APIs REST. Tu tarea es generar una colección de Postman completa y lista para ejecutar con Newman.

REGLAS ESTRICTAS:
1. Responde ÚNICAMENTE con JSON válido. Sin texto adicional, sin comentarios, sin markdown.
2. Genera casos de prueba positivos (happy path) Y negativos (edge cases, validaciones, errores).
3. Para cada endpoint del spec, incluye al menos:
   - 1 caso exitoso (status 2xx)
   - 1 caso con datos inválidos/faltantes (status 4xx)
   - 1 caso de recurso no encontrado donde aplique (status 404)
4. Cada request debe incluir "tests" en JavaScript para validar status code, tiempo de respuesta y estructura del body.
5. Usa variables de colección para el baseUrl y para IDs creados dinámicamente.
6. El JSON debe seguir exactamente el formato de colección de Postman v2.1.
7. CRÍTICO: Usa las URLs EXACTAS del spec OpenAPI. Por ejemplo, si el spec dice "/api/users", el request debe ir a "{{baseUrl}}/api/users", NUNCA a "{{baseUrl}}/" ni a rutas genéricas. Cada request DEBE incluir la ruta completa del endpoint incluyendo el prefijo /api/.
8. Para endpoints con parámetros de ruta como /api/users/{id}, usa el ID guardado dinámicamente en la variable de colección o un ID numérico concreto como 1, 2 o 99999 (para casos 404).
9. NUNCA generes rutas genéricas como "/" o "/{id}". Siempre usa la ruta completa del spec.`;

  const userPrompt = `Genera una colección de Postman completa para la siguiente API REST.

IMPORTANTE: Lee el spec completo. Cada endpoint tiene una ruta específica como /api/users, /api/products, /api/orders. Usa esas rutas EXACTAS en cada request. NO uses rutas genéricas.

OpenAPI Spec:
${JSON.stringify(openAPISpec, null, 2)}

La colección debe:
- Llamarse "API Test Generator - Colección Automática (${new Date().toISOString()})"
- Tener una variable de colección "baseUrl" con valor "${API_BASE_URL}"
- Organizar los requests por carpetas: una para Users (/api/users), una para Products (/api/products), una para Orders (/api/orders)
- En cada request, la URL debe ser "{{baseUrl}}/api/users", "{{baseUrl}}/api/products/{{productId}}", etc. NUNCA "{{baseUrl}}/" ni "{{baseUrl}}/{{id}}"
- Incluir scripts de test en cada request para validar: status code esperado, tiempo de respuesta (<2000ms), y estructura del JSON de respuesta
- Los casos POST deben guardar el ID creado en una variable de colección (ej: pm.collectionVariables.set('userId', json.id)) para usarlo en los siguientes requests GET, PUT, DELETE
- Para casos 404, usar IDs que no existen como 99999

Ejemplo de un request correcto:
{
  "name": "GET /api/users - Listar todos",
  "request": {
    "method": "GET",
    "url": "{{baseUrl}}/api/users"
  },
  "event": [{"listen":"test","script":{"exec":["pm.test('Status 200', () => pm.response.to.have.status(200));"]}}]
}

Formato de salida (Postman v2.1):
{
  "info": { "name": "...", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "variable": [{ "key": "baseUrl", "value": "${API_BASE_URL}" }],
  "item": [ ... carpetas con requests ... ]
}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 16000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2, // Baja temperatura para output más determinístico y válido
  });

  const rawContent = response.choices[0].message.content.trim();
  
  // Limpiar posibles bloques de código markdown
  const cleaned = rawContent.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  
  console.log(`✅ GPT-4 generó respuesta (${rawContent.length} caracteres)`);
  console.log(`📊 Tokens usados: prompt=${response.usage.prompt_tokens}, completion=${response.usage.completion_tokens}, total=${response.usage.total_tokens}`);

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
    throw new Error(`GPT-4 no generó JSON válido: ${e.message}\nContenido recibido:\n${rawJson.substring(0, 500)}...`);
  }

  // Asegurar que la colección tiene el schema correcto
  if (!collection.info) {
    collection.info = {};
  }
  collection.info.schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

  // Agregar metadata de generación
  collection._generatedBy = 'api-test-generator-llm';
  collection._generatedAt = new Date().toISOString();
  collection._sourceSpec = openAPISpec.info?.title || 'Unknown API';
  collection._model = MODEL;

  return collection;
}

// ─────────────────────────────────────────────
// 4. Guardar colección y métricas
// ─────────────────────────────────────────────
function countRequests(collection) {
  let count = 0;
  function traverse(items) {
    if (!items) return;
    for (const item of items) {
      if (item.item) traverse(item.item); // carpeta
      else count++;
    }
  }
  traverse(collection.item);
  return count;
}

async function saveResults(collection, metrics) {
  // Guardar colección Postman
  fs.mkdirSync(path.dirname(POSTMAN_OUTPUT), { recursive: true });
  fs.writeFileSync(POSTMAN_OUTPUT, JSON.stringify(collection, null, 2));
  console.log(`\n💾 Colección guardada en: ${POSTMAN_OUTPUT}`);

  // Guardar métricas
  const metricsDir = path.join(__dirname, '../reports');
  fs.mkdirSync(metricsDir, { recursive: true });
  const metricsPath = path.join(metricsDir, 'generation-metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`📈 Métricas guardadas en: ${metricsPath}`);

  // Subir a S3 si está configurado
  if (process.env.AWS_ACCESS_KEY_ID && process.env.S3_BUCKET_NAME) {
    try {
      await uploadToS3(POSTMAN_OUTPUT, `collections/collection-${metrics.timestamp}.json`);
      await uploadToS3(metricsPath, `metrics/generation-${metrics.timestamp}.json`);
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
    // Paso 1: Obtener spec
    const openAPISpec = await fetchOpenAPISpec();

    // Paso 2: Generar con LLM
    const { raw, usage } = await generateTestsWithLLM(openAPISpec);

    // Paso 3: Parsear y enriquecer
    const collection = parseAndEnrichCollection(raw, openAPISpec);

    const requestCount = countRequests(collection);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n📋 Casos de prueba generados: ${requestCount}`);
    console.log(`⏱️  Tiempo de generación: ${duration}s`);

    // Paso 4: Guardar
    const metrics = {
      timestamp,
      model: MODEL,
      generationDurationSeconds: parseFloat(duration),
      casesGenerated: requestCount,
      tokensUsed: usage,
      apiEndpoints: Object.keys(openAPISpec.paths || {}).length,
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
