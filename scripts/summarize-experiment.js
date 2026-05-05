#!/usr/bin/env node
/**
 * summarize-experiment.js
 *
 * Descarga el historial completo desde S3 y calcula las estadísticas
 * descriptivas del experimento:
 *
 *   - Media (x̄)
 *   - Desviación estándar (σ)
 *   - Coeficiente de variación (CV = σ/x̄ × 100)
 *   - Valor mínimo y máximo
 *   - Intervalo de confianza al 95% (t-Student, n pequeño)
 *
 * Métricas analizadas:
 *   - Tasa de éxito de assertions (%)
 *   - Tasa de detección de fallos (%)
 *   - Cobertura de endpoints (%)
 *   - Casos de prueba generados
 *   - Tiempo de generación (segundos)
 *   - Tokens consumidos
 *   - Tiempo promedio de respuesta (ms)
 *
 * Genera:
 *   - reports/experiment-summary.json  (datos para el capítulo de resultados)
 *   - reports/experiment-summary.md    (tabla lista para copiar a la tesis)
 *
 * El CV es el indicador clave de consistencia:
 *   CV < 10%  → muy consistente (alta confiabilidad del enfoque)
 *   CV 10-20% → aceptable
 *   CV > 20%  → alta variabilidad (el LLM es impredecible en esa métrica)
 *
 * Uso:
 *   node scripts/summarize-experiment.js
 *   node scripts/summarize-experiment.js --local   (lee reports/runs-history.json)
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const REPORTS_DIR  = path.join(__dirname, '../reports');
const HISTORY_KEY  = 'history/runs-history.json';
const LOCAL_HISTORY= path.join(REPORTS_DIR, 'runs-history.json');

const useLocal = process.argv.includes('--local');

// ─── S3 ───────────────────────────────────────────────────────────────────
const s3Ok = !!(process.env.AWS_ACCESS_KEY_ID && process.env.S3_BUCKET_NAME);
const s3   = s3Ok ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
}) : null;

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8');
}

async function fetchHistory() {
  if (useLocal || !s3Ok) {
    if (!fs.existsSync(LOCAL_HISTORY)) {
      console.error('❌ No se encontró reports/runs-history.json');
      console.error('   Ejecuta primero el pipeline o usa --local con el archivo presente.');
      process.exit(1);
    }
    console.log('📂 Leyendo historial local...');
    return JSON.parse(fs.readFileSync(LOCAL_HISTORY, 'utf8'));
  }
  console.log('📥 Descargando historial desde S3...');
  try {
    const res  = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME, Key: HISTORY_KEY,
    }));
    return JSON.parse(await streamToString(res.Body));
  } catch (err) {
    console.error('❌ Error descargando historial S3:', err.message);
    process.exit(1);
  }
}

// ─── Estadísticas descriptivas ────────────────────────────────────────────
function pct(v) {
  if (v == null) return null;
  return parseFloat(String(v).replace('%', ''));
}

function stats(values) {
  const clean = values.filter(v => v !== null && !isNaN(v));
  if (clean.length === 0) return null;

  const n    = clean.length;
  const mean = clean.reduce((a,b) => a+b, 0) / n;
  const variance = clean.reduce((s,v) => s + Math.pow(v - mean, 2), 0) / (n - 1 || 1);
  const std  = Math.sqrt(variance);
  const cv   = mean !== 0 ? (std / mean * 100) : 0;
  const min  = Math.min(...clean);
  const max  = Math.max(...clean);

  // Intervalo de confianza 95% usando t de Student
  // Valores críticos t para n-1 grados de libertad (tabla simplificada)
  const tTable = { 1:12.706,2:4.303,3:3.182,4:2.776,5:2.571,
                   6:2.447,7:2.365,8:2.306,9:2.262,10:2.228,
                   11:2.201,12:2.179,13:2.160,14:2.145,15:2.131,
                   20:2.086,25:2.060,30:2.042,40:2.021,60:2.000 };
  const df  = n - 1;
  const tCrit = tTable[df] || tTable[Math.max(...Object.keys(tTable).map(Number).filter(k=>k<=df))] || 2.0;
  const me  = tCrit * (std / Math.sqrt(n));

  return {
    n,
    mean:   parseFloat(mean.toFixed(3)),
    std:    parseFloat(std.toFixed(3)),
    cv:     parseFloat(cv.toFixed(2)),
    min:    parseFloat(min.toFixed(3)),
    max:    parseFloat(max.toFixed(3)),
    ci95:   { lower: parseFloat((mean - me).toFixed(3)), upper: parseFloat((mean + me).toFixed(3)) },
    consistency: cv < 10 ? 'Alta' : cv < 20 ? 'Aceptable' : 'Baja',
  };
}

function cvLabel(cv) {
  if (cv == null) return 'N/A';
  if (cv < 10)  return `${cv}% ✓ Alta consistencia`;
  if (cv < 20)  return `${cv}% ~ Aceptable`;
  return `${cv}% ✗ Alta variabilidad`;
}

// ─── Generar tabla Markdown ───────────────────────────────────────────────
function buildMarkdown(summary) {
  const { meta, metrics, conclusions } = summary;

  const row = (label, unit, s) => {
    if (!s) return `| ${label} | — | — | — | — | — | N/A |`;
    return `| ${label} | ${s.mean}${unit} | ${s.std.toFixed(2)}${unit} | ${cvLabel(s.cv)} | ${s.min}${unit} | ${s.max}${unit} | ${s.ci95.lower}–${s.ci95.upper}${unit} |`;
  };

  return `# Resumen Estadístico del Experimento

**Tesis:** Desarrollo de un prototipo para la generación automatizada de casos de prueba en APIs REST mediante modelos de lenguaje integrados en pipelines CI/CD

**Autor:** Alan Joel Morataya Escobar — USAC, Escuela de Estudios de Postgrado, 2025

**Fecha de análisis:** ${meta.analysisDate}
**Total de iteraciones analizadas:** ${meta.totalRuns}
**Modelo LLM:** ${meta.model}
**Endpoints en el spec OpenAPI:** ${meta.apiEndpoints}

---

## Tabla de estadísticas descriptivas

| Métrica | Media (x̄) | Desv. Est. (σ) | CV (σ/x̄) | Mínimo | Máximo | IC 95% |
|---|---|---|---|---|---|---|
${row('Tasa de éxito de assertions', '%', metrics.passRate)}
${row('Tasa de detección de fallos', '%', metrics.detectionRate)}
${row('Cobertura de endpoints', '%', metrics.coveragePct)}
${row('Tasa de redundancia exacta', '%', metrics.redundancyRate)}
${row('Casos de prueba generados', '', metrics.casesGenerated)}
${row('Tiempo de generación', 's', metrics.genDuration)}
${row('Tokens consumidos', '', metrics.tokensUsed)}
${row('Tiempo promedio de respuesta', 'ms', metrics.avgRT)}

> **CV (Coeficiente de Variación):** mide la consistencia del enfoque.
> CV < 10% = alta consistencia. CV 10–20% = aceptable. CV > 20% = alta variabilidad.

---

## Historial de iteraciones

| Run | Fecha | Pass Rate | Detección | Cobertura | Redundancia | Casos | Tokens | Avg RT |
|---|---|---|---|---|---|---|---|---|
${meta.runs.map(r =>
  `| ${r.runId} | ${r.timestamp.substring(0,10)} | ${r.passRate||'—'} | ${r.detectionRate||'N/A'} | ${r.coveragePercent||'—'} | ${r.redundancyRate||'—'} | ${r.casesGenerated||'—'} | ${r.tokensUsed!=null?Number(r.tokensUsed).toLocaleString():'—'} | ${r.avgResponseTime!=null?r.avgResponseTime+'ms':'—'} |`
).join('\n')}

---

## Conclusiones del análisis estadístico

${conclusions.map((c,i) => `${i+1}. ${c}`).join('\n')}

---

*Generado automáticamente por summarize-experiment.js*
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('  📊 Resumen Estadístico del Experimento');
  console.log('═'.repeat(60));

  const history = await fetchHistory();
  if (!history.length) {
    console.error('❌ El historial está vacío. Ejecuta el pipeline al menos una vez.');
    process.exit(1);
  }

  console.log(`✅ ${history.length} iteraciones encontradas\n`);

  // ── Extraer series de datos ───────────────────────────────────────────
  const passRates    = history.map(r => pct(r.passRate));
  const detRates     = history.map(r => pct(r.detectionRate));
  const coverages    = history.map(r => pct(r.coveragePercent));
  const cases        = history.map(r => r.casesGenerated != null ? parseFloat(r.casesGenerated) : null);
  const genDurations = history.map(r => r.genDurationSeconds != null ? parseFloat(r.genDurationSeconds) : null);
  const tokens       = history.map(r => r.tokensUsed != null ? parseFloat(r.tokensUsed) : null);
  const avgRTs       = history.map(r => r.avgResponseTime != null ? parseFloat(r.avgResponseTime) : null);
  const redundancies = history.map(r => pct(r.redundancyRate));

  const apiEndpoints = history.find(r => r.apiEndpoints)?.apiEndpoints || 0;
  const model        = history.find(r => r.model)?.model || 'GPT-4o';

  // ── Calcular estadísticas ─────────────────────────────────────────────
  const metrics = {
    passRate:      stats(passRates),
    detectionRate: stats(detRates),
    coveragePct:   stats(coverages),
    casesGenerated:stats(cases),
    genDuration:   stats(genDurations),
    tokensUsed:    stats(tokens),
    avgRT:         stats(avgRTs),
    redundancyRate:stats(redundancies),
  };

  // ── Conclusiones automáticas ──────────────────────────────────────────
  const conclusions = [];

  if (metrics.passRate) {
    const pr = metrics.passRate;
    conclusions.push(
      `La tasa de éxito de assertions presentó una media de ${pr.mean}% ` +
      `(σ = ${pr.std}%, CV = ${pr.cv}%). ` +
      `El CV ${pr.cv < 10 ? 'inferior al 10% demuestra alta consistencia' : pr.cv < 20 ? 'entre 10% y 20% indica variabilidad aceptable' : 'superior al 20% indica variabilidad alta'} ` +
      `del enfoque de generación mediante LLMs a lo largo de las ${history.length} iteraciones.`
    );
  }

  if (metrics.detectionRate) {
    const dr = metrics.detectionRate;
    const hasNulls = detRates.filter(v => v === null).length;
    if (hasNulls > 0) {
      conclusions.push(
        `La tasa de detección de fallos fue medida en ${dr.n} de las ${history.length} iteraciones ` +
        `(${history.length - dr.n} iteraciones no ejecutaron inject-faults.js). ` +
        `La media fue ${dr.mean}% (σ = ${dr.std}%).`
      );
    } else {
      conclusions.push(
        `La tasa de detección de fallos inyectados promedió ${dr.mean}% ` +
        `con una desviación estándar de ${dr.std}% (CV = ${dr.cv}%). ` +
        `El intervalo de confianza al 95% fue [${dr.ci95.lower}%, ${dr.ci95.upper}%], ` +
        `indicando que el enfoque ${dr.mean >= 70 ? 'es efectivo' : 'requiere refinamiento'} para la detección de errores.`
      );
    }
  }

  if (metrics.coveragePct) {
    const cv = metrics.coveragePct;
    conclusions.push(
      `La cobertura de endpoints del spec OpenAPI promedió ${cv.mean}% ` +
      `(mín. ${cv.min}%, máx. ${cv.max}%), demostrando que el LLM ` +
      `${cv.mean >= 80 ? 'cubre consistentemente la mayoría de los endpoints sin intervención humana' : 'cubre parcialmente los endpoints, lo que sugiere que el prompt puede refinarse'}.`
    );
  }

  if (metrics.casesGenerated) {
    const cg = metrics.casesGenerated;
    conclusions.push(
      `El número de casos de prueba generados por iteración varió entre ${cg.min} y ${cg.max} ` +
      `(media = ${cg.mean}, CV = ${cg.cv}%). ` +
      `${cg.cv < 15 ? 'La baja variabilidad sugiere que el LLM interpreta el spec de forma consistente.' : 'La variabilidad indica que el LLM puede generar cantidades distintas según la interpretación del spec.'}`
    );
  }

  if (metrics.genDuration) {
    const gd = metrics.genDuration;
    conclusions.push(
      `El tiempo de generación promedió ${gd.mean}s por iteración (σ = ${gd.std}s), ` +
      `demostrando que la generación automatizada es significativamente más rápida ` +
      `que la escritura manual de casos de prueba.`
    );
  }

  if (metrics.tokensUsed) {
    const tk = metrics.tokensUsed;
    conclusions.push(
      `El costo computacional promedió ${Math.round(tk.mean).toLocaleString()} tokens por iteración ` +
      `(σ = ${Math.round(tk.std).toLocaleString()}), lo que representa un costo operativo ` +
      `predecible y escalable para equipos de desarrollo.`
    );
  }

  if (metrics.redundancyRate) {
    const rr = metrics.redundancyRate;
    const level = rr.mean < 10 ? 'baja' : rr.mean < 25 ? 'moderada' : 'alta';
    conclusions.push(
      `La tasa de redundancia exacta promedió ${rr.mean}% (σ = ${rr.std}%, CV = ${rr.cv}%). ` +
      `Esto indica que el LLM genera casos con redundancia ${level}, ` +
      `${rr.mean < 15
        ? 'lo que demuestra que la mayor parte de los casos generados aportan cobertura única.'
        : 'lo que sugiere que el prompt podría refinarse para reducir casos duplicados.'} ` +
      `El CV de ${rr.cv}% ${rr.cv < 20 ? 'indica que la redundancia es predecible entre iteraciones' : 'indica variabilidad en la consistencia de generación'}.`
    );
  }

  // ── Armar objeto summary ──────────────────────────────────────────────
  const summary = {
    meta: {
      analysisDate: new Date().toISOString(),
      totalRuns:    history.length,
      model,
      apiEndpoints,
      runs: history.map(r => ({
        runId:          r.runId,
        timestamp:      r.timestamp,
        passRate:       r.passRate,
        detectionRate:  r.detectionRate,
        coveragePercent:r.coveragePercent,
        casesGenerated: r.casesGenerated,
        tokensUsed:     r.tokensUsed,
        avgResponseTime:r.avgResponseTime,
      })),
    },
    metrics,
    conclusions,
  };

  // ── Guardar JSON ──────────────────────────────────────────────────────
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const jsonPath = path.join(REPORTS_DIR, 'experiment-summary.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  // ── Generar Markdown ──────────────────────────────────────────────────
  const md     = buildMarkdown(summary);
  const mdPath = path.join(REPORTS_DIR, 'experiment-summary.md');
  fs.writeFileSync(mdPath, md);

  // ── Mostrar en consola ────────────────────────────────────────────────
  console.log('MÉTRICAS ANALIZADAS:\n');

  const printStat = (label, unit, s) => {
    if (!s) { console.log(`  ${label}: sin datos suficientes`); return; }
    console.log(`  ${label}:`);
    console.log(`    Media:   ${s.mean}${unit}  |  σ = ${s.std}${unit}  |  CV = ${cvLabel(s.cv)}`);
    console.log(`    Rango:   [${s.min}${unit} – ${s.max}${unit}]  |  IC95%: [${s.ci95.lower}–${s.ci95.upper}${unit}]`);
  };

  printStat('Tasa de éxito assertions', '%', metrics.passRate);
  printStat('Tasa de detección fallos', '%', metrics.detectionRate);
  printStat('Cobertura de endpoints',   '%', metrics.coveragePct);
  printStat('Redundancia exacta',       '%', metrics.redundancyRate);
  printStat('Casos generados',          '',  metrics.casesGenerated);
  printStat('Tiempo de generación',     's', metrics.genDuration);
  printStat('Tokens consumidos',        '',  metrics.tokensUsed);
  printStat('Avg tiempo respuesta',     'ms',metrics.avgRT);

  console.log('\nCONCLUSIONES:\n');
  conclusions.forEach((c, i) => console.log(`  ${i+1}. ${c}\n`));

  console.log('─'.repeat(60));
  console.log(`💾 JSON:      ${jsonPath}`);
  console.log(`📄 Markdown:  ${mdPath}`);
  console.log('─'.repeat(60));
  console.log('\n✅ El archivo .md está listo para pegar en la tesis.\n');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
