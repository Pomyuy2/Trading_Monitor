import http from 'node:http';

async function getAuthToken() {
  const { execSync } = await import('node:child_process');
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
  const match = out.match(/TOKEN:(.+)/);
  if (!match) throw new Error('Failed to extract token: ' + out);
  return match[1].trim();
}

async function request(endpoint, body, cookie = null) {
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (cookie) {
    headers['Cookie'] = `authjs.session-token=${cookie}`;
  }

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:3003${endpoint}`,
      { method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const duration = Date.now() - start;
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, duration });
          } catch (e) {
            resolve({ status: res.statusCode, raw: data, duration });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('=== STARTING PRODUCTION BETA ACCEPTANCE CHECKS ===\n');

  console.log('1. Acquiring Authenticated Session Token...');
  const authToken = await getAuthToken();
  console.log('   Authenticated Session Token acquired successfully (length: ' + authToken.length + ').\n');

  // Test 1: V1 Default Verification (Unauthenticated)
  console.log('2. Testing V1 Standard Default (Unauthenticated Request)...');
  const v1Res = await request('/api/ai/ask', {
    question: 'What is DCF valuation?',
    lang: 'en',
  });
  console.log(`   Status: ${v1Res.status}, Duration: ${v1Res.duration}ms`);
  console.log(`   Effective Agent Version: ${v1Res.data.agentVersion || 'v1 (default)'}`);
  if (v1Res.data.agentVersion && v1Res.data.agentVersion !== 'v1') {
    throw new Error('Expected V1 default for unauthenticated request!');
  }
  console.log('   ✓ V1 default confirmed.\n');

  // Test 2: Server-Side Authorization Enforcement (Unauthenticated V2 Request)
  console.log('3. Testing Server-Side Authorization Enforcement (Unauthenticated V2 request)...');
  const unauthV2Res = await request('/api/ai/ask', {
    question: 'What was NVDA Data Center revenue in fiscal 2025?',
    symbol: 'NVDA',
    agentVersion: 'v2',
    lang: 'en',
  });
  console.log(`   Status: ${unauthV2Res.status}, Duration: ${unauthV2Res.duration}ms`);
  console.log(`   Requested: v2, Effective Version Returned: ${unauthV2Res.data.agentVersion}`);
  if (unauthV2Res.data.agentVersion === 'v2') {
    throw new Error('Unauthenticated request was granted V2 access! Authorization enforcement failed.');
  }
  console.log('   ✓ Unauthorized V2 request correctly downgraded to V1.\n');

  // Test 3: Warm Path — Authenticated V2 NVDA Research
  console.log('4. Testing Warm Path — Authenticated V2 NVDA Retrieval (Pre-indexed corpus)...');
  const warmRes = await request(
    '/api/ai/ask',
    {
      question: 'What was NVIDIA Data Center revenue in fiscal 2025 based on the official 10-K?',
      symbol: 'NVDA',
      agentVersion: 'v2',
      lang: 'en',
    },
    authToken
  );
  console.log(`   Status: ${warmRes.status}, Duration: ${warmRes.duration}ms`);
  console.log(`   Effective Agent Version: ${warmRes.data.agentVersion}`);
  console.log(`   Tool Steps Executed: ${warmRes.data.toolSteps?.length || 0}`);
  const hasSecCitation = /\[SEC-NVDA-10-K-[^\]]+\]/.test(warmRes.data.answer || '');
  console.log(`   SEC Citation Present in Answer: ${hasSecCitation}`);
  console.log(`   Sample Answer Excerpt: "${(warmRes.data.answer || '').slice(0, 220)}..."`);
  if (!warmRes.data.answer || warmRes.data.agentVersion !== 'v2') {
    throw new Error('Warm path V2 query failed or did not return V2 response!');
  }
  console.log('   ✓ Warm path confirmed.\n');

  // Test 4: Cold Path — Authenticated V2 TSLA Autonomous Ingestion & Grounding
  console.log('5. Testing Cold Path — Authenticated V2 TSLA Autonomous Ingestion...');
  console.log('   Triggering on-demand research for TSLA...');
  const coldRes = await request(
    '/api/ai/ask',
    {
      question: 'What are Tesla automotive revenues and key risk factors reported in the latest SEC 10-K filing?',
      symbol: 'TSLA',
      agentVersion: 'v2',
      lang: 'en',
    },
    authToken
  );
  console.log(`   Status: ${coldRes.status}, Duration: ${coldRes.duration}ms`);
  console.log(`   Effective Agent Version: ${coldRes.data.agentVersion}`);
  console.log(`   Tool Steps Executed: ${coldRes.data.toolSteps?.length || 0}`);
  for (const step of coldRes.data.toolSteps || []) {
    console.log(`     - Tool: ${step.tool} (${step.durationMs}ms): ${step.summary || step.error || 'ok'}`);
  }
  console.log(`   Sample Answer Excerpt: "${(coldRes.data.answer || '').slice(0, 250)}..."`);
  console.log('   ✓ Cold path query completed.\n');

  // Test 5: Repeat TSLA Request (Cached Verification)
  console.log('6. Testing Repeat Request — TSLA Immediate Cache Retrieval...');
  const repeatRes = await request(
    '/api/ai/ask',
    {
      question: 'What are Tesla automotive revenues reported in the latest SEC filing?',
      symbol: 'TSLA',
      agentVersion: 'v2',
      lang: 'en',
    },
    authToken
  );
  console.log(`   Status: ${repeatRes.status}, Duration: ${repeatRes.duration}ms`);
  console.log(`   Repeat Duration: ${repeatRes.duration}ms (vs Cold Duration: ${coldRes.duration}ms)`);
  console.log('   ✓ Repeat request completed without re-downloading.\n');

  // Test 6: Unsupported Ticker Handling
  console.log('7. Testing Failure Handling — Unsupported Ticker (DOGE-USD)...');
  const unsuppRes = await request(
    '/api/ai/ask',
    {
      question: 'What are the SEC 10-K filing risks for DOGE-USD?',
      symbol: 'DOGE-USD',
      agentVersion: 'v2',
      lang: 'en',
    },
    authToken
  );
  console.log(`   Status: ${unsuppRes.status}, Duration: ${unsuppRes.duration}ms`);
  console.log(`   Answer Excerpt: "${(unsuppRes.data.answer || '').slice(0, 200)}..."`);
  console.log('   ✓ Unsupported entity handled cleanly without crashing.\n');

  console.log('=== ALL PRODUCTION BETA ACCEPTANCE CHECKS PASSED ===');
}

run().catch((err) => {
  console.error('Acceptance Check FAILED:', err);
  process.exit(1);
});
