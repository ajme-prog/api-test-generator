const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Sube un archivo local a S3
 * @param {string} localFilePath - Ruta local del archivo
 * @param {string} s3Key - Clave (path) en S3
 */
async function uploadToS3(localFilePath, s3Key) {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error('S3_BUCKET_NAME no está configurado');

  const fileContent = fs.readFileSync(localFilePath);
  const ext = path.extname(localFilePath).toLowerCase();
  const contentType = ext === '.json' ? 'application/json' : 'text/plain';

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: fileContent,
    ContentType: contentType,
    Metadata: {
      'generated-by': 'api-test-generator',
      'uploaded-at': new Date().toISOString(),
    },
  });

  await s3.send(command);
  console.log(`  ☁️  Subido: s3://${bucket}/${s3Key}`);
}

/**
 * Sube contenido JSON directamente a S3 (sin archivo temporal)
 * @param {object} jsonData - Objeto a serializar y subir
 * @param {string} s3Key - Clave en S3
 */
async function uploadJSONToS3(jsonData, s3Key) {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error('S3_BUCKET_NAME no está configurado');

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: JSON.stringify(jsonData, null, 2),
    ContentType: 'application/json',
    Metadata: {
      'generated-by': 'api-test-generator',
      'uploaded-at': new Date().toISOString(),
    },
  });

  await s3.send(command);
  console.log(`  ☁️  Subido: s3://${bucket}/${s3Key}`);
}

module.exports = { uploadToS3, uploadJSONToS3 };
