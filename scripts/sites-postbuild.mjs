import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const dist = resolve(root, 'dist');
const server = resolve(dist, 'server');
const metadata = resolve(dist, '.openai');

await mkdir(server, { recursive: true });
await mkdir(metadata, { recursive: true });
await copyFile(
  resolve(root, '.openai', 'hosting.json'),
  resolve(metadata, 'hosting.json'),
);

await writeFile(
  resolve(server, 'index.js'),
  `const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    const fallback = new URL(request.url);
    fallback.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(fallback, request));
  },
};

export default worker;
`,
);
