import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const apiKey = process.env.OPENAI_API_KEY?.trim();
const accessCode = process.env.SMARTJACKIE_ACCESS_CODE?.trim();
if (!apiKey || !accessCode || accessCode.length < 20) {
  throw new Error('Set OPENAI_API_KEY and a separate random SMARTJACKIE_ACCESS_CODE of at least 20 characters.');
}

const digest = value => createHash('sha256').update(value).digest();
const expected = digest('Bearer ' + accessCode);
const port = Number(process.env.PORT || 8080);
const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const page = readFileSync(new URL('./index.html', import.meta.url));
const script = readFileSync(new URL('./voice.js', import.meta.url));
let inFlight = false;
let lastRequest = 0;

function reply(response, code, contentType, body) {
  response.writeHead(code, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
}

createServer(async (request, response) => {
  const path = request.url?.split('?')[0];
  if (request.method === 'GET' && path === '/') return reply(response, 200, 'text/html; charset=utf-8', page);
  if (request.method === 'GET' && path === '/voice.js') return reply(response, 200, 'text/javascript; charset=utf-8', script);
  if (request.method !== 'POST' || path !== '/session') return reply(response, 404, 'text/plain', 'Not found');
  if (!timingSafeEqual(digest(request.headers.authorization || ''), expected)) {
    return reply(response, 401, 'text/plain', 'Access denied');
  }
  const length = Number(request.headers['content-length']);
  const maxOffer = 32 * 1024;
  if (!Number.isInteger(length) || length < 1 || length > maxOffer) {
    return reply(response, 413, 'text/plain', 'Invalid SDP size');
  }
  if (inFlight || Date.now() - lastRequest < 1500) return reply(response, 429, 'text/plain', 'Retry shortly');
  inFlight = true;
  lastRequest = Date.now();
  try {
    let offer = '';
    request.setEncoding('utf8');
    for await (const chunk of request) offer += chunk;
    if (!offer.startsWith('v=0') || Buffer.byteLength(offer) > maxOffer) {
      return reply(response, 400, 'text/plain', 'Invalid offer');
    }
    const form = new FormData();
    form.set('sdp', offer);
    form.set('session', JSON.stringify({
      type: 'realtime', model,
      instructions: 'Răspunde în română, scurt și clar. Dacă ți se cere să te oprești, nu continua răspunsul.',
      audio: {
        output: { voice: 'marin' },
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'ro' },
          turn_detection: {
            type: 'server_vad', silence_duration_ms: 1200,
            create_response: false, interrupt_response: true,
          },
        },
      },
    }));
    const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      console.warn('OpenAI Realtime HTTP status:', upstream.status);
      return reply(response, 502, 'text/plain', 'OpenAI HTTP ' + upstream.status);
    }
    return reply(response, 200, 'application/sdp', await upstream.text());
  } catch (error) {
    console.warn('Realtime connection failed:', error.name);
    if (!response.destroyed) reply(response, 502, 'text/plain', 'Connection failed');
  } finally {
    inFlight = false;
  }
}).listen(port, '0.0.0.0');
