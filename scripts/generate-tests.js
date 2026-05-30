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
 * CORRECCIÓN v2:
 * - Prompt mejorado con instrucción de exhaustividad explícita
 * - El modelo recibe la lista exacta de endpoints antes de generar
 * - Se instruye a no duplicar endpoints ya cubiertos
 */

require('dotenv').config();
const OpenAI = require('openai');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { uploadToS3 } = require('../src/utils/s3-uploader');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const API_BASE_URL  = process.env.API_BASE_URL  || 'http://localhost:3000';
const MODEL         = process.env.OPENAI_MODEL  || 'gpt-4o';
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
 * Se usa para construir el prompt de exhaustividad.
 */
function extractEndpointList(openAPISpec) {
  const httpMethods = ['get','post','put','patch','delete','head','options'];
  const endpoints = [];
  for (const [routePath, methods] of Object.entries(openAPISpec.paths || {})) {
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

  const endpointList = extractEndpointList(openAPISpec);
  const endpointListStr = endpointList.map((e, i) => `  ${i + 1}. ${e}`).join('\n');

  const systemPrompt = `Eres un experto en QA y pruebas de APIs REST. Tu tarea es generar una colección de Postman completa y lista para ejecutar con Newman.

REGLAS ESTRICTAS:
1. Responde ÚNICAMENTE con JSON válido. Sin texto adicional, sin comentarios, sin markdown.
2. EXHAUSTIVIDAD OBLIGATORIA: Debes generar al menos un caso de prueba para CADA endpoint de la lista que recibirás. No puedes omitir ninguno. Antes de terminar, verifica que todos los endpoints estén cubiertos.
3. Para cada endpoint genera:
   - 1 caso exitoso (status 2xx) — happy path
   - 1 caso con datos inválidos o faltantes (status 4xx) donde aplique
   - 1 caso de recurso no encontrado (status 404) para endpoints con parámetro /{id}
4. NO dupliques el mismo endpoint+método más de 2 veces. Si ya tienes un caso positivo y uno negativo para un endpoint, no agregues un tercero del mismo tipo.
5. Cada request debe incluir scripts de test en JavaScript para validar: status code esperado, tiempo de respuesta (<2000ms) y estructura básica del body.
6. Usa variables de colección para baseUrl e IDs creados dinámicamente.
7. El JSON debe seguir exactamente el formato de colección Postman v2.1.
8. Usa las URLs EXACTAS del spec. Si el spec dice "/api/users/{id}", el request debe ir a "{{baseUrl}}/api/users/{{userId}}" o "{{baseUrl}}/api/users/1".
9. Los casos POST deben guardar el ID creado en una variable: pm.collectionVariables.set('userId', pm.response.json().id)
10. Para casos 404, usa IDs inexistentes como 99999.`;

  const userPrompt = `Genera una colección de Postman completa para la siguiente API REST.

PASO 1 — LISTA COMPLETA DE ENDPOINTS A CUBRIR (obligatorio cubrir TODOS):
${endpointListStr}

PASO 2 — Para cada endpoint de la lista anterior, genera los casos de prueba indicados en las reglas.
Verifica al finalizar que cada número de la lista tenga al menos un caso generado.

OpenAPI Spec completo:
${JSON.stringify(openAPISpec, null, 2)}

La colección debe:
- Llamarse "API Test Generator - Colección Automática (${new Date().toISOString()})"
- Tener una variable de colección "baseUrl" con valor "${API_BASE_URL}"
- Organizar los requests en carpetas por recurso: Users, Products, Orders
- Incluir scripts de test en cada request

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
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.2,
  });

  const rawContent = response.choices[0].message.content.trim();
  const cleaned    = rawContent.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();

  console.log(`✅ GPT-4o generó respuesta (${rawContent.length} caracteres)`);
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
    const openAPISpec = await fetchOpenAPISpec();
    const { raw, usage } = await generateTestsWithLLM(openAPISpec);
    const collection = parseAndEnrichCollection(raw, openAPISpec);

    const requestCount = countRequests(collection);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n📋 Casos de prueba generados: ${requestCount}`);
    console.log(`⏱️  Tiempo de generación: ${duration}s`);

    const metrics = {
      timestamp,
      model: MODEL,
      generationDurationSeconds: parseFloat(duration),
      casesGenerated: requestCount,
      tokensUsed: usage,
      apiEndpoints: (() => {
        const paths   = openAPISpec.paths || {};
        const methods = ['get','post','put','patch','delete','head','options'];
        let count = 0;
        for (const p of Object.values(paths)) {
          count += Object.keys(p).filter(k => methods.includes(k)).length;
        }
        return count;
      })(),
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
