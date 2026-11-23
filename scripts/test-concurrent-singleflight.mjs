import http from 'node:http';
import { execSync } from 'node:child_process';

async function getAuthToken() {
  const out = execSync(
    `docker exec trading-monitor-app node -e "
import('/app/node_modules/.pnpm/@auth+core@0.41.3/node_modules/@auth/core/jwt.js').then(async ({ encode }) => {
  const token = await encode({
    token: { id: 'cmwbutyt3000cn17use9umdbf', email: 'rametrree@trading.local' },
    secret: process.env.AUTH_SECRET,
    salt: 'authjs.session-token',
  });
  console.log('TOKEN:' + token);
});
"`
  ).toString();
  return out.match(/TOKEN:(.+)/)[1].trim();
}

function req(body, token) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      'http://127.0.0.1:3003/api/ai/ask',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Cookie': `authjs.session-token=${token}`,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, raw: d });
          }
        });
      }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

async function main() {
  const token = await getAuthToken();
  console.log('Launching 2 concurrent V2 requests for AMZN...');
  const t0 = Date.now();
  const [res1, res2] = await Promise.all([
    req(
      {
        question: 'What was AWS segment revenue in the latest 10-K?',
        symbol: 'AMZN',
        agentVersion: 'v2',
        lang: 'en',
      },
      token
    ),
    req(
      {
        question: 'What were Amazon North America segment sales in the latest 10-K?',
        symbol: 'AMZN',
        agentVersion: 'v2',
        lang: 'en',
      },
      token
    ),
  ]);
  const dur = Date.now() - t0;
  console.log('Both concurrent requests completed in', dur, 'ms');
  console.log('Res1 status:', res1.status, 'Version:', res1.body?.agentVersion);
  console.log('Res2 status:', res2.status, 'Version:', res2.body?.agentVersion);

  // Check IngestionJob table for AMZN
  const jobsOut = execSync(
    `docker exec trading-monitor-app node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/server/data/trading.db", { readOnly: true });
const j = db.prepare("SELECT id, symbol, cik, status, documentsIngested, chunksCreated, createdAt, completedAt FROM IngestionJob WHERE symbol = ?").all("AMZN");
console.log(JSON.stringify(j));
db.close();
'`
  ).toString();

  const jobs = JSON.parse(jobsOut.trim().split('\n').pop());
  console.log('IngestionJobs created for AMZN:', jobs);
  console.log('Number of IngestionJobs created for AMZN:', jobs.length);

  // Check Docs for AMZN
  const docsOut = execSync(
    `docker exec trading-monitor-app node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/server/data/trading.db", { readOnly: true });
const docs = db.prepare("SELECT id, symbol, form, filingDateStr, chunkCount FROM FinancialDocument WHERE symbol = ?").all("AMZN");
console.log(JSON.stringify(docs));
db.close();
'`
  ).toString();
  const docs = JSON.parse(docsOut.trim().split('\n').pop());
  console.log('AMZN Documents count in DB:', docs.length);
}

main().catch((err) => {
  console.error('Concurrent Singleflight check failed:', err);
  process.exit(1);
});
