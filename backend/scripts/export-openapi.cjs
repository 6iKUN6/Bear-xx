const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);

function applyOpenApiEnvFallbacks() {
  const fallbackEntries = {
    DATABASE_URL: 'postgresql://docs:docs@localhost:5432/litter_bear_docs',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6379',
    JWT_ACCESS_SECRET: 'docs-access-secret',
    JWT_REFRESH_SECRET: 'docs-refresh-secret',
    OPENAI_API_KEY: 'docs-openai-key',
  };

  for (const [key, value] of Object.entries(fallbackEntries)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function buildBackend() {
  execFileSync('pnpm', ['build'], {
    cwd: backendRoot,
    stdio: 'inherit',
  });
}

async function exportOpenApi() {
  applyOpenApiEnvFallbacks();
  buildBackend();

  require('reflect-metadata');

  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { createSwaggerDocument } = require('../dist/swagger');

  const app = await NestFactory.create(AppModule, { logger: false });

  try {
    const document = createSwaggerDocument(app);
    const outputPath = path.resolve(backendRoot, 'docs/openapi.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(document, null, 2) + '\n');
    console.log(`OpenAPI exported to ${outputPath}`);
  } finally {
    await app.close();
  }
}

exportOpenApi().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
