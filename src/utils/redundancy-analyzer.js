/**
 * redundancy-analyzer.js
 *
 * Módulo reutilizable que analiza una colección Postman y mide
 * la redundancia de casos de prueba en dos niveles:
 *
 * NIVEL 1 — Redundancia exacta (automática, objetiva):
 *   Dos casos son exactamente redundantes si tienen el mismo
 *   método HTTP + el mismo path normalizado de endpoint. Ej: dos veces
 *   "POST /api/users" con distintos bodies pero probando lo mismo.
 *
 * NIVEL 2 — Redundancia semántica (semi-automática, cualitativa):
 *   Clasifica cada grupo de casos por endpoint+método según el
 *   tipo de assertion que contiene: positivo (2xx), negativo (4xx/5xx),
 *   o mixto. Permite identificar si GPT-4o generó múltiples casos
 *   negativos que prueban exactamente lo mismo.
 *
 * CORRECCIÓN v2: normalización de rutas mejorada para distinguir
 *   correctamente entre rutas de colección (/api/users) y rutas de
 *   recurso individual (/api/users/{id}), evitando agrupaciones
 *   incorrectas por prefijo común.
 */

'use strict';

/**
 * Extrae todos los items (requests) de una colección Postman v2.1
 * aplanando las carpetas recursivamente.
 */
function flattenItems(items = []) {
  const result = [];
  for (const item of items) {
    if (item.item) {
      result.push(...flattenItems(item.item));
    } else if (item.request) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Extrae método y path normalizado de un request de Postman.
 *
 * Reglas de normalización:
 * 1. Elimina baseUrl y variables de colección ({{baseUrl}})
 * 2. Elimina query string
 * 3. Normaliza SOLO segmentos que son IDs concretos (numéricos o variables
 *    como {{userId}}) a ":param", pero NUNCA normaliza segmentos de texto
 *    fijo como "status", "users", "products", etc.
 * 4. Esto garantiza que GET /api/users y GET /api/users/{id} sean
 *    grupos distintos, y que PATCH /api/orders/{id}/status sea distinto
 *    de DELETE /api/orders/{id}.
 */
function extractEndpoint(request) {
  const method = (request.method || 'GET').toUpperCase();
  let rawPath = '';

  if (request.url) {
    if (typeof request.url === 'string') {
      rawPath = request.url;
    } else if (Array.isArray(request.url.path)) {
      // Reconstruir desde el array de segmentos (formato Postman v2.1)
      rawPath = '/' + request.url.path.join('/');
    } else if (request.url.raw) {
      rawPath = request.url.raw;
    }
  }

  // Eliminar protocolo y host (http://localhost:3000 o {{baseUrl}})
  rawPath = rawPath
    .replace(/\{\{[^}]+\}\}/g, '')          // quitar {{baseUrl}}, {{userId}}, etc.
    .replace(/^https?:\/\/[^/]*/,'');        // quitar http://host

  // Eliminar query string
  rawPath = rawPath.split('?')[0];

  // Normalizar segmentos que son IDs dinámicos:
  // - Numéricos puros: /1, /99999, /123
  // - Variables Postman ya resueltas como segmento vacío tras quitar {{...}}
  // - Segmentos que son UUIDs (letras-números-guiones, 8+ chars)
  // NO normalizar segmentos de texto fijo como /status, /users, /api
  const segments = rawPath.split('/').map(seg => {
    if (!seg) return seg;                          // segmento vacío (slashes dobles)
    if (/^\d+$/.test(seg)) return ':param';        // ID numérico → :param
    if (/^[0-9a-f-]{8,}$/i.test(seg)) return ':param'; // UUID → :param
    if (seg === '') return ':param';               // variable {{id}} ya eliminada → vacío
    return seg;                                    // texto fijo: conservar tal cual
  });

  let path = segments.join('/');

  // Limpiar slashes dobles y trailing slash (excepto raíz)
  path = path.replace(/\/+/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  if (!path.startsWith('/')) path = '/' + path;

  return { method, path, key: `${method} ${path}` };
}

/**
 * Clasifica un caso como positivo, negativo o mixto según
 * los assertions que contiene.
 */
function classifyCase(item) {
  const scripts = [];

  if (Array.isArray(item.event)) {
    for (const ev of item.event) {
      if (ev.listen === 'test' && ev.script?.exec) {
        scripts.push(...ev.script.exec);
      }
    }
  }

  const code = scripts.join('\n');
  const positiveMatch = /\.status\(2\d{2}\)|to\.have\.status\(2\d{2}\)|status.*20[0-9]/i.test(code);
  const negativeMatch = /\.status\([45]\d{2}\)|to\.have\.status\([45]\d{2}\)|status.*4[0-9]{2}|status.*5[0-9]{2}/i.test(code);

  if (positiveMatch && negativeMatch) return 'mixed';
  if (negativeMatch) return 'negative';
  if (positiveMatch) return 'positive';
  return 'unknown';
}

/**
 * Función principal: analiza una colección Postman y devuelve
 * el reporte completo de redundancia.
 *
 * @param {object} collection - Objeto JSON de la colección Postman v2.1
 * @returns {object} redundancyReport
 */
function analyzeRedundancy(collection) {
  const items = flattenItems(collection.item || []);
  const total = items.length;

  if (total === 0) {
    return {
      totalCases: 0,
      uniqueEndpointMethod: 0,
      exactDuplicates: 0,
      redundancyRate: '0.00%',
      groupDetail: [],
      qualitativeFlags: [],
      summary: 'La colección no tiene casos de prueba.',
    };
  }

  // Agrupar por endpoint+método normalizado
  const groups = {};
  for (const item of items) {
    const { key, method, path } = extractEndpoint(item.request || {});
    if (!groups[key]) {
      groups[key] = { method, path, key, cases: [] };
    }
    groups[key].cases.push({
      name: item.name || 'Sin nombre',
      type: classifyCase(item),
    });
  }

  const groupList = Object.values(groups);
  const uniqueEndpointMethod = groupList.length;

  let exactDuplicates = 0;
  const groupDetail = [];
  const qualitativeFlags = [];

  for (const group of groupList) {
    const count    = group.cases.length;
    const positive = group.cases.filter(c => c.type === 'positive').length;
    const negative = group.cases.filter(c => c.type === 'negative').length;
    const mixed    = group.cases.filter(c => c.type === 'mixed').length;
    const unknown  = group.cases.filter(c => c.type === 'unknown').length;

    // Redundancia exacta: más de un caso por endpoint+método
    const duplicatesInGroup = Math.max(0, count - 1);
    exactDuplicates += duplicatesInGroup;

    const detail = {
      endpoint: group.key,
      totalCases: count,
      positive,
      negative,
      mixed,
      unknown,
      exactDuplicates: duplicatesInGroup,
      cases: group.cases.map(c => c.name),
    };
    groupDetail.push(detail);

    if (negative >= 3) {
      qualitativeFlags.push({
        endpoint: group.key,
        reason: `${negative} casos negativos — revisar si prueban validaciones distintas`,
        severity: 'medium',
        cases: group.cases.filter(c => c.type === 'negative').map(c => c.name),
      });
    }
    if (positive >= 3) {
      qualitativeFlags.push({
        endpoint: group.key,
        reason: `${positive} casos positivos — verificar que cada uno cubre un escenario distinto`,
        severity: 'low',
        cases: group.cases.filter(c => c.type === 'positive').map(c => c.name),
      });
    }
  }

  const redundancyRate = ((exactDuplicates / total) * 100).toFixed(2) + '%';
  groupDetail.sort((a, b) => b.totalCases - a.totalCases);

  return {
    totalCases: total,
    uniqueEndpointMethod,
    exactDuplicates,
    redundancyRate,
    groupDetail,
    qualitativeFlags,
    summary: buildSummary(total, uniqueEndpointMethod, exactDuplicates, redundancyRate, qualitativeFlags.length),
  };
}

function buildSummary(total, unique, duplicates, rate, flags) {
  const pct = parseFloat(rate);
  const level = pct < 10 ? 'baja' : pct < 25 ? 'moderada' : 'alta';
  return (
    `La colección tiene ${total} casos de prueba cubriendo ${unique} combinaciones ` +
    `endpoint+método únicas. Se detectaron ${duplicates} casos exactamente redundantes ` +
    `(tasa de redundancia: ${rate}, nivel ${level}). ` +
    `${flags > 0
      ? `Además, ${flags} grupo(s) presentan posible redundancia semántica que requiere revisión cualitativa.`
      : 'No se detectaron grupos con posible redundancia semántica.'}`
  );
}

module.exports = { analyzeRedundancy };
