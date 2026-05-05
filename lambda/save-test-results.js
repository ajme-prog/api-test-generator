/**
 * lambda/save-test-results.js
 * 
 * Función AWS Lambda que recibe los resultados del pipeline Newman
 * y los almacena estructuradamente en S3 para análisis posterior.
 * 
 * Despliegue: ver README.md sección "Configuración AWS"
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET = process.env.S3_BUCKET_NAME;

/**
 * Handler principal de la Lambda
 * 
 * Espera un payload con:
 * {
 *   runId: string,
 *   timestamp: string (ISO),
 *   generation: { casesGenerated, tokensUsed, durationSeconds },
 *   execution: { passed, failed, passRate, avgResponseTime },
 *   coverage: { percent, endpointsCovered, total }
 * }
 */
exports.handler = async (event) => {
  console.log('Lambda invocada:', JSON.stringify(event, null, 2));

  try {
    // Parsear el body (puede venir de API Gateway o directo)
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event;

    const {
      runId = `run-${Date.now()}`,
      timestamp = new Date().toISOString(),
      generation = {},
      execution = {},
      coverage = {},
    } = body;

    // 1. Guardar resultado individual de esta ejecución
    const resultKey = `results/${new Date(timestamp).toISOString().split('T')[0]}/${runId}.json`;
    const resultData = {
      runId,
      timestamp,
      generation,
      execution,
      coverage,
      savedAt: new Date().toISOString(),
    };

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: resultKey,
      Body: JSON.stringify(resultData, null, 2),
      ContentType: 'application/json',
    }));

    console.log(`✅ Resultado guardado: s3://${BUCKET}/${resultKey}`);

    // 2. Actualizar el historial acumulado (para análisis de tendencias)
    const historyKey = 'history/runs-history.json';
    let history = [];

    try {
      const existing = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: historyKey }));
      const existingData = await streamToString(existing.Body);
      history = JSON.parse(existingData);
    } catch {
      // El archivo no existe aún, empezar con array vacío
      history = [];
    }

    // Agregar entrada resumida al historial
    history.push({
      runId,
      timestamp,
      casesGenerated: generation.casesGenerated || 0,
      casesExecuted: execution.total || 0,
      passRate: execution.passRate || '0%',
      coveragePercent: coverage.percent || '0%',
      avgResponseTime: execution.avgResponseTime || 0,
    });

    // Mantener solo los últimos 100 runs en el historial
    if (history.length > 100) history = history.slice(-100);

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: historyKey,
      Body: JSON.stringify(history, null, 2),
      ContentType: 'application/json',
    }));

    console.log(`✅ Historial actualizado: ${history.length} entradas`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Resultados guardados exitosamente',
        runId,
        s3Key: resultKey,
        historyEntries: history.length,
      }),
    };
  } catch (err) {
    console.error('Error en Lambda:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// Utilidad para leer stream de S3 a string
async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
