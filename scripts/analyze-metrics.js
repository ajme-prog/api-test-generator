#!/usr/bin/env node
/**
 * analyze-metrics.js
 *
 * Al finalizar cada run del pipeline:
 *   1. Lee los reportes locales (Newman, generación, inyección de fallos)
 *   2. Construye el reporte consolidado de ESTE run
 *   3. Descarga el historial acumulado desde S3 (runs-history.json)
 *   4. Agrega la entrada de este run al historial
 *   5. Vuelve a subir el historial actualizado a S3
 *
 * El historial es la fuente de verdad del dashboard.
 * Estructura de cada entrada del historial:
 * {
 *   runId, timestamp, branch, commitSha,
 *   apiEndpoints, casesGenerated, casesExecuted,
 *   passRate, coveragePercent, avgResponseTime,
 *   tokensUsed, genDurationSeconds,
 *   detectionRate   ← de inject-faults.js (null si no se ejecutó)
 * }
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { analyzeRedundancy } = require('../src/utils/redundancy-analyzer');

const REPORTS_DIR      = path.join(__dirname, '../reports');
const HISTORY_S3_KEY   = 'history/runs-history.json';
const COLLECTION_PATH  = path.join(__dirname, '../postman/collection.json');

// ─── S3 client ────────────────────────────────────────────────────────────
const s3Configured = !!(process.env.AWS_ACCESS_KEY_ID && process.env.S3_BUCKET_NAME);
const s3 = s3Configured ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
}) : null;

// ─── Helpers ──────────────────────────────────────────────────────────────
function load(file) {
  const p = path.join(REPORTS_DIR, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

// ─── Leer historial desde S3 ──────────────────────────────────────────────
async function fetchHistory() {
  if (!s3Configured) return [];
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key:    HISTORY_S3_KEY,
    }));
    const text = await streamToString(res.Body);
    const data = JSON.parse(text);
    console.log(`📥 Historial descargado desde S3: ${data.length} entradas previas`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    // El archivo no existe todavía → primera ejecución
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('📥 Historial en S3 no encontrado → se creará nuevo');
      return [];
    }
    console.warn(`⚠️  Error leyendo historial S3: ${err.message}`);
    return [];
  }
}

// ─── Escribir historial a S3 ──────────────────────────────────────────────
async function pushHistory(history) {
  if (!s3Configured) {
    console.log('⚠️  S3 no configurado → historial solo local');
    return;
  }
  await s3.send(new PutObjectCommand({
    Bucket:      process.env.S3_BUCKET_NAME,
    Key:         HISTORY_S3_KEY,
    Body:        JSON.stringify(history, null, 2),
    ContentType: 'application/json',
  }));
  console.log(`☁️  Historial actualizado en s3://${process.env.S3_BUCKET_NAME}/${HISTORY_S3_KEY}`);
  console.log(`    URL pública: https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION||'us-east-1'}.amazonaws.com/${HISTORY_S3_KEY}`);
}

// ─── Subir archivo individual a S3 ───────────────────────────────────────
async function uploadFile(localPath, s3Key) {
  if (!s3Configured || !fs.existsSync(localPath)) return;
  try {
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.S3_BUCKET_NAME,
      Key:         s3Key,
      Body:        fs.readFileSync(localPath),
      ContentType: s3Key.endsWith('.pdf') ? 'application/pdf' : 'application/json',
    }));
    console.log(`  ☁️  Subido: ${s3Key}`);
  } catch (err) {
    console.warn(`  ⚠️  No se pudo subir ${s3Key}: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n📊 Analizando métricas y actualizando historial...\n');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Cargar reportes locales de este run
  const newman     = load('newman-report.json');
  const generation = load('generation-metrics.json');
  const faults     = load('fault-injection-summary.json');

  // ── Métricas de ejecución Newman ──────────────────────────────────────
  const stats   = newman?.run?.stats   || {};
  const timings = newman?.run?.timings || {};
  const execs   = newman?.run?.executions || [];

  const totalAssert = stats.assertions?.total  || 0;
  const failAssert  = stats.assertions?.failed || 0;
  const passAssert  = totalAssert - failAssert;
  const passRate    = totalAssert
    ? ((passAssert / totalAssert) * 100).toFixed(2) + '%'
    : '0%';

  const rts = execs.map(e => e.response?.responseTime).filter(t => t != null);
  const avgRT = rts.length
    ? parseFloat((rts.reduce((a,b)=>a+b,0) / rts.length).toFixed(1))
    : 0;

  const totalDurationMs = timings.completed ? (timings.completed - timings.started) : 0;

  // ── Cobertura de endpoints ────────────────────────────────────────────
  const endpointsTested = new Set();
  execs.forEach(e => {
    const url    = e.request?.url?.path?.join('/');
    const method = e.request?.method;
    if (url && method) endpointsTested.add(`${method}/${url}`);
  });
  const totalEndpoints   = generation?.apiEndpoints || 0;
  const coveredEndpoints = endpointsTested.size;
  const coveragePct      = totalEndpoints
    ? parseFloat(((coveredEndpoints / totalEndpoints) * 100).toFixed(2))
    : 0;

  // ── Redundancia de casos de prueba ───────────────────────────────────
  // Analiza postman/collection.json (generada por GPT-4o en este run)
  // Satisface la métrica: "Redundancia de casos" del marco metodológico
  let redundancy = null;
  try {
    if (fs.existsSync(COLLECTION_PATH)) {
      const collection = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));
      redundancy = analyzeRedundancy(collection);
      // Guardar reporte detallado de redundancia
      fs.writeFileSync(
        path.join(REPORTS_DIR, 'redundancy-report.json'),
        JSON.stringify(redundancy, null, 2)
      );
      console.log(`♻️  Redundancia: ${redundancy.redundancyRate} (${redundancy.exactDuplicates} duplicados exactos de ${redundancy.totalCases} casos)`);
      if (redundancy.qualitativeFlags.length > 0) {
        console.log(`⚠️  ${redundancy.qualitativeFlags.length} grupo(s) con posible redundancia semántica → revisar redundancy-report.json`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  No se pudo analizar redundancia: ${err.message}`);
  }

  // ── Reporte consolidado completo (para PDF y artefacto) ───────────────
  const runId    = process.env.GITHUB_RUN_NUMBER || 'local';
  const ts       = new Date().toISOString();
  const branch   = process.env.GITHUB_REF?.replace('refs/heads/','') || 'local';
  const commitSha= (process.env.GITHUB_SHA || 'local').substring(0,7);

  const consolidatedReport = {
    runInfo: { timestamp: ts, githubRunNumber: runId, commitSha, branch },
    generation,
    execution: {
      requests:      { total: stats.requests?.total||0, failed: stats.requests?.failed||0 },
      assertions:    { total: totalAssert, passed: passAssert, failed: failAssert, passRate },
      responseTimes: { average: avgRT, max: rts.length?Math.max(...rts):0, unit:'ms' },
      duration:      { total: totalDurationMs, unit:'ms' },
      failures: execs.filter(e=>e.assertions?.some(a=>a.error)).map(e=>({
        name:       e.item?.name,
        status:     e.response?.status,
        assertions: e.assertions?.filter(a=>a.error).map(a=>a.error?.message),
      })),
    },
    coverage: {
      totalEndpoints,
      coveredEndpoints,
      coveragePercent: coveragePct + '%',
    },
    faultDetection: faults ? {
      faultsInjected:   faults.faultsInjected,
      failuresDetected: faults.failuresDetected,
      assertionsTotal:  faults.assertionsTotal,
      detectionRate:    faults.detectionRate,
    } : null,
    redundancy: redundancy ? {
      totalCases:           redundancy.totalCases,
      uniqueEndpointMethod: redundancy.uniqueEndpointMethod,
      exactDuplicates:      redundancy.exactDuplicates,
      redundancyRate:       redundancy.redundancyRate,
      qualitativeFlagsCount:redundancy.qualitativeFlags.length,
      summary:              redundancy.summary,
    } : null,
    summary: {
      casesGenerated:  generation?.casesGenerated || 0,
      casesExecuted:   stats.requests?.total || 0,
      passRate,
      coverageRate:    coveragePct + '%',
      avgResponseTime: avgRT,
      totalDurationMs,
    },
  };

  // Guardar reporte consolidado localmente
  const consolidatedPath = path.join(REPORTS_DIR, 'consolidated-report.json');
  fs.writeFileSync(consolidatedPath, JSON.stringify(consolidatedReport, null, 2));

  // ── Mostrar en consola ────────────────────────────────────────────────
  console.log('═'.repeat(52));
  console.log('  REPORTE CONSOLIDADO — Run #' + runId);
  console.log('═'.repeat(52));
  console.log(`Endpoints (swagger-autogen): ${totalEndpoints}`);
  console.log(`Casos generados (GPT-4o):   ${generation?.casesGenerated || 0}`);
  console.log(`Assertions totales:          ${totalAssert}`);
  console.log(`Tasa de éxito:               ${passRate}`);
  console.log(`Cobertura de endpoints:      ${coveragePct}%`);
  console.log(`Tiempo promedio respuesta:   ${avgRT}ms`);
  if (faults) {
    console.log(`Tasa detección de fallos:    ${faults.detectionRate}`);
  }
  if (redundancy) {
    console.log(`Redundancia exacta:          ${redundancy.redundancyRate} (${redundancy.exactDuplicates}/${redundancy.totalCases} casos)`);
  }
  console.log('═'.repeat(52));

  // ── Entrada compacta para el historial ───────────────────────────────
  // Esta es la estructura exacta que lee el dashboard
  const historyEntry = {
    runId,
    timestamp:        ts,
    branch,
    commitSha,
    apiEndpoints:     totalEndpoints,
    casesGenerated:   generation?.casesGenerated  || 0,
    casesExecuted:    stats.requests?.total        || 0,
    tokensUsed:       generation?.tokensUsed?.total_tokens || 0,
    genDurationSeconds: generation?.generationDurationSeconds || 0,
    passRate,
    coveragePercent:  coveragePct + '%',
    avgResponseTime:  avgRT,
    detectionRate:    faults?.detectionRate || null,
    redundancyRate:   redundancy?.redundancyRate || null,
    exactDuplicates:  redundancy?.exactDuplicates ?? null,
    qualitativeFlags: redundancy?.qualitativeFlags.length ?? null,
  };

  // ── Actualizar historial en S3 ────────────────────────────────────────
  const history = await fetchHistory();
  history.push(historyEntry);
  // Mantener máximo 200 entradas
  const trimmed = history.length > 200 ? history.slice(-200) : history;
  await pushHistory(trimmed);

  // Guardar copia local del historial (útil para debug)
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'runs-history.json'),
    JSON.stringify(trimmed, null, 2)
  );

  // ── Subir archivos individuales a S3 ─────────────────────────────────
  const stamp = ts.replace(/[:.]/g, '-');
  await uploadFile(consolidatedPath,
    `consolidated/report-run${runId}-${stamp}.json`);
  await uploadFile(path.join(REPORTS_DIR, 'metrics-report.pdf'),
    `pdf-reports/report-run${runId}-${stamp}.pdf`);
  await uploadFile(path.join(REPORTS_DIR, 'fault-injection-summary.json'),
    `fault-reports/faults-run${runId}-${stamp}.json`);
  await uploadFile(path.join(REPORTS_DIR, 'newman-report.json'),
    `newman-reports/newman-run${runId}-${stamp}.json`);
  await uploadFile(path.join(REPORTS_DIR, 'redundancy-report.json'),
    `redundancy-reports/redundancy-run${runId}-${stamp}.json`);

  console.log(`\n✅ Historial acumulado: ${trimmed.length} ejecuciones`);
  console.log(`💾 Reporte local: ${consolidatedPath}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
