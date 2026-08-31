import crypto from 'node:crypto';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const hold = args.includes('--hold');
const positional = args.filter(arg => arg !== '--hold');
const [deviceArg = 'C1', buttonArg = 'RED_1', sequenceArg = '1', url = process.env.SFTS_SERVER_URL || 'ws://127.0.0.1:8080'] = positional;
const deviceId = deviceArg.toUpperCase();
const button = buttonArg.toUpperCase();
const sequence = Number(sequenceArg);
const sessionId = crypto.randomBytes(8).toString('hex');
const token = process.env[`SFTS_REMOTE_TOKEN_${deviceId}`] || '';

if (!/^C[1-4]$/.test(deviceId)) throw new Error('deviceId must be C1, C2, C3, or C4');
if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('sequence must be a positive integer');

const ws = new WebSocket(url);
let eventSent = false;

ws.on('open', () => {
  console.log(`Connected to ${url} as ${deviceId}`);
  ws.send(JSON.stringify({
    type: 'remote_hello',
    protocolVersion: 1,
    deviceId,
    sessionId,
    token,
    firmware: 'simulator'
  }));
});

ws.on('message', raw => {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  console.log(JSON.stringify(message));

  if (message.type === 'remote_ready' && !eventSent) {
    eventSent = true;
    ws.send(JSON.stringify({
      type: 'remote_event',
      deviceId,
      sessionId,
      sequence,
      button
    }));
  }
  if (message.type === 'error') {
    process.exitCode = 1;
    ws.close();
  }
  if (message.type === 'remote_event_ack') {
    if (hold) console.log('Holding connection; press Ctrl+C to disconnect.');
    else ws.close();
  }
});

ws.on('error', error => {
  console.error(`Remote simulator error: ${error.message}`);
  process.exitCode = 1;
});
