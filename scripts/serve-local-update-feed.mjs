import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyIfChanged(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing source file: ${source}`);
  }

  if (fs.existsSync(target)) {
    const sourceStat = fs.statSync(source);
    const targetStat = fs.statSync(target);
    if (sourceStat.size === targetStat.size && sourceStat.mtimeMs <= targetStat.mtimeMs) {
      return;
    }
  }

  fs.copyFileSync(source, target);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.yml' || extension === '.yaml') {
    return 'application/yaml; charset=utf-8';
  }

  if (extension === '.exe') {
    return 'application/octet-stream';
  }

  if (extension === '.txt') {
    return 'text/plain; charset=utf-8';
  }

  return 'application/octet-stream';
}

function prepareFeed(feedDir, versionOverride) {
  const latestYmlSource = path.join(rootDir, 'out', 'make', 'wix', 'x64', 'latest.yml');
  if (!fs.existsSync(latestYmlSource)) {
    throw new Error('Missing out/make/wix/x64/latest.yml. Run `npm run make` first.');
  }

  const latestYml = fs.readFileSync(latestYmlSource, 'utf8');
  const metadata = parseYaml(latestYml);
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const setupFile = files.find((file) => String(file?.url || '').endsWith('.exe'));
  if (!setupFile?.url) {
    throw new Error('latest.yml does not reference a Windows setup exe.');
  }

  const sanitizedMetadata = {
    ...metadata,
    version: versionOverride || metadata.version,
    files: [setupFile],
  };
  const setupFileName = path.basename(setupFile.url);
  const setupSource = path.join(rootDir, 'out', 'make', 'squirrel.windows', 'x64', setupFileName);
  const latestYmlTarget = path.join(feedDir, 'latest.yml');
  const setupTarget = path.join(feedDir, setupFileName);

  ensureDir(feedDir);
  fs.writeFileSync(latestYmlTarget, stringifyYaml(sanitizedMetadata));
  copyIfChanged(setupSource, setupTarget);

  return {
    version: String(sanitizedMetadata.version),
    actualArtifactVersion: String(metadata.version),
    feedDir,
    latestYmlTarget,
    setupTarget,
  };
}

const port = Number(readArg('--port', process.env.AGM_UPDATE_FEED_PORT || '18080'));
const host = readArg('--host', '127.0.0.1');
const feedDir = path.resolve(readArg('--dir', path.join(rootDir, 'out', 'local-update-feed')));
const versionOverride = readArg('--version', process.env.AGM_UPDATE_FEED_VERSION || '');
const preparedFeed = prepareFeed(feedDir, versionOverride);

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = decodedPath === '/' ? 'latest.yml' : decodedPath.slice(1);
  const filePath = path.resolve(feedDir, relativePath);

  if (!filePath.startsWith(feedDir + path.sep) && filePath !== feedDir) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': getContentType(filePath),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  const feedUrl = `http://${host}:${port}/`;
  console.log(`Local updater feed ready: ${feedUrl}`);
  console.log(`Version: ${preparedFeed.version}`);
  if (preparedFeed.version !== preparedFeed.actualArtifactVersion) {
    console.log(`Actual setup artifact version: ${preparedFeed.actualArtifactVersion}`);
    console.log('Warning: version override is for detection/download testing only.');
    console.log('Do not click Restart unless the setup artifact really contains that version.');
  }
  console.log(`Feed dir: ${preparedFeed.feedDir}`);
  console.log('');
  console.log('Run a packaged app with:');
  console.log(`  $env:AGM_UPDATE_FEED_URL="${feedUrl}"`);
  console.log('  $env:AGM_UPDATE_ALLOW_UNMANAGED="1"');
  console.log('');
  console.log('Then launch the packaged exe or installed app and click Check for updates.');
});
