# API Test Generator — Prototipo de Tesis

**Desarrollo de un prototipo para la generación automatizada de casos de prueba en APIs REST mediante modelos de lenguaje integrados en pipelines CI/CD**

> Alan Joel Morataya Escobar — Universidad de San Carlos de Guatemala, Facultad de Ingeniería, Escuela de Estudios de Postgrado (2025)

---

## Flujo completo del pipeline

```
git push
    │
    ├─ 1. swagger-autogen   → escanea rutas Express → swagger-output.json
    ├─ 2. npm start         → levanta API en :3000
    ├─ 3. GPT-4o            → lee swagger-output.json → genera colección Postman
    ├─ 4. Newman            → ejecuta colección → reports/newman-report.json
    ├─ 5. inject-faults.js  → API con bugs en :3001 → mide tasa de detección
    ├─ 6. generate-pdf-report.js → PDF con 6 gráficas matplotlib
    └─ 7. analyze-metrics.js →
              ├─ descarga runs-history.json desde S3
              ├─ agrega entrada de este run
              └─ sube runs-history.json actualizado a S3
                        │
                        └─ dashboard/index.html lo lee → muestra tendencias
```

---

## Instalación local

```bash
unzip api-test-generator-v4.zip
cd api-test-generator-v4
npm install
cp .env.example .env
# Editar .env: agregar OPENAI_API_KEY y credenciales AWS
```

### Correr todo localmente

```bash
node scripts/swagger-gen.js   # Genera swagger-output.json
npm start &                   # Levanta API en :3000
npm run generate-tests        # GPT-4o genera la colección
npm run run-tests             # Newman ejecuta las pruebas
npm run inject-faults         # Mide tasa de detección
npm run report:pdf            # PDF con gráficas
npm run report:analyze        # Actualiza historial en S3
```

---

## Configuración de AWS S3 (requerida para el historial y el dashboard)

### 1. Crear el bucket

```bash
aws s3 mb s3://api-test-generator-results --region us-east-1
```

### 2. Deshabilitar "Block all public access"

En la consola AWS → S3 → tu bucket → Permissions → Block public access → Edit → desmarcar todo → Save.

### 3. Agregar bucket policy de lectura pública

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadHistory",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::api-test-generator-results/history/*"
    },
    {
      "Sid": "PublicReadDashboard",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::api-test-generator-results/dashboard/*"
    }
  ]
}
```

### 4. Configurar CORS (para que el dashboard pueda leer desde el navegador)

En la consola AWS → S3 → tu bucket → Permissions → CORS:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": []
  }
]
```

### 5. URL del historial

Después del primer push, la URL del historial será:

```
https://api-test-generator-results.s3.us-east-1.amazonaws.com/history/runs-history.json
```

Esta URL se imprime automáticamente en el log de GitHub Actions al finalizar el paso `analyze-metrics`.

---

## Dashboard

Abre `dashboard/index.html` en el navegador, pega la URL del historial S3 y haz clic en **Cargar**.

El dashboard muestra:
- Tasa de éxito de assertions por run (línea)
- Casos generados vs ejecutados (barras)
- Tiempo promedio de respuesta (línea)
- Tasa de detección de fallos (barras + tendencia)
- Cobertura de endpoints (barras + tendencia)
- Tabla completa del historial

---

## Secrets requeridos en GitHub Actions

Settings → Secrets and variables → Actions:

| Secret | Descripción |
|--------|-------------|
| `OPENAI_API_KEY` | API key de OpenAI |
| `AWS_ACCESS_KEY_ID` | Credenciales AWS |
| `AWS_SECRET_ACCESS_KEY` | Credenciales AWS |
| `AWS_REGION` | Región del bucket (ej: `us-east-1`) |
| `S3_BUCKET_NAME` | Nombre del bucket |

---

## Variables de investigación medidas

| Variable | Archivo fuente |
|----------|----------------|
| Casos de prueba generados | `generation-metrics.json → casesGenerated` |
| Tiempo de generación | `generation-metrics.json → generationDurationSeconds` |
| Tokens consumidos | `generation-metrics.json → tokensUsed.total_tokens` |
| Tasa de éxito de assertions | `runs-history.json → passRate` |
| Tasa de detección de fallos | `runs-history.json → detectionRate` |
| Cobertura de endpoints | `runs-history.json → coveragePercent` |
| Tiempo promedio de respuesta | `runs-history.json → avgResponseTime` |

