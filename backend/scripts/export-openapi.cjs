const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);

function buildBackend() {
  execFileSync('pnpm', ['build'], {
    cwd: backendRoot,
    stdio: 'inherit',
  });
}

async function exportOpenApi() {
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
