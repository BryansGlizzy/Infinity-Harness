// A swarm's identity and the signing of federation messages (master plan Phase 7, "Identity and trust").
//
// Each daemon has one ed25519 key pair (Node's built-in crypto, no dependency). The swarm id and the fingerprint
// operators compare are both derived from the public key, so a claimed id can never disagree with its key and there is
// no shared secret to copy between operators. Every federation message is signed over its method, path, timestamp,
// nonce, intended recipient and a hash of its body; answers are signed too, so a caller knows who really answered.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SwarmInfo } from '@ih/core';

export const PROTOCOL = 'IH-FED1';

export interface Identity {
  /** Base64 SPKI DER of the public key. */
  publicKey: string;
  privateKey: KeyObject;
  swarmId: string;
  fingerprint: string;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const hashBody = (body: string) => sha256hex(body);

/** The digits an operator reads aloud or compares: 32 hex characters in groups of four. */
export function fingerprintOf(publicKeyB64: string): string {
  const hex = sha256hex(Buffer.from(publicKeyB64, 'base64')).slice(0, 32);
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Normalises what a person typed for a fingerprint (spaces, colons and case do not matter). */
export function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/[^0-9a-f]/g, '');
}

export function swarmIdOf(publicKeyB64: string): string {
  return `sw_${sha256hex(Buffer.from(publicKeyB64, 'base64')).slice(0, 16)}`;
}

/** True for a base64 SPKI DER ed25519 public key. */
export function validPublicKey(publicKeyB64: string): boolean {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyB64)) return false;
  try {
    return createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function fromKeys(publicKey: string, privateKey: KeyObject): Identity {
  return { publicKey, privateKey, swarmId: swarmIdOf(publicKey), fingerprint: fingerprintOf(publicKey) };
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return fromKeys(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey);
}

/**
 * Loads the identity kept in `file`, creating it on first use (mode 0600, written atomically). A null file gives a
 * throwaway identity, for tests and in-memory daemons.
 */
export function loadIdentity(file: string | null): Identity {
  if (!file) return generateIdentity();
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { publicKey?: string; privateKey?: string };
    if (!data.publicKey || !data.privateKey) throw new Error(`${file} is not a swarm key file`);
    return fromKeys(data.publicKey, createPrivateKey(data.privateKey));
  }
  const id = generateIdentity();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ publicKey: id.publicKey, privateKey: id.privateKey.export({ format: 'pem', type: 'pkcs8' }) }) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  // rename is atomic, so a crash cannot leave half a key
  renameSync(tmp, file);
  return id;
}

export function selfInfo(id: Identity, name: string): SwarmInfo {
  return { swarmId: id.swarmId, name, fingerprint: id.fingerprint, publicKey: id.publicKey };
}

// --- request signing

export interface SignedFields {
  method: string;
  /** Path and query, exactly as sent. */
  path: string;
  ts: number;
  nonce: string;
  /** The swarm the request is for (empty only for a knock to a swarm whose id we do not know yet). */
  to: string;
  body: string;
}

export function requestText(f: SignedFields): string {
  return [PROTOCOL, f.method.toUpperCase(), f.path, f.ts, f.nonce, f.to, hashBody(f.body)].join('\n');
}

export function responseText(f: { nonce: string; status: number; ts: number; body: string }): string {
  return [`${PROTOCOL}-RES`, f.nonce, f.status, f.ts, hashBody(f.body)].join('\n');
}

export function signText(id: Identity, text: string): string {
  return sign(null, Buffer.from(text), id.privateKey).toString('base64');
}

export function verifyText(publicKeyB64: string, text: string, signatureB64: string): boolean {
  try {
    if (!validPublicKey(publicKeyB64) || signatureB64.length > 200) return false;
    return verify(null, Buffer.from(text), createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export const newNonce = () => randomBytes(16).toString('hex');

export const HEADERS = { key: 'x-fed-key', ts: 'x-fed-ts', nonce: 'x-fed-nonce', to: 'x-fed-to', sig: 'x-fed-sig' } as const;

/** The headers that sign a request. */
export function signRequest(id: Identity, f: Omit<SignedFields, 'ts' | 'nonce'> & { ts?: number; nonce?: string }): Record<string, string> {
  const ts = f.ts ?? Date.now();
  const nonce = f.nonce ?? newNonce();
  return {
    [HEADERS.key]: id.publicKey,
    [HEADERS.ts]: String(ts),
    [HEADERS.nonce]: nonce,
    [HEADERS.to]: f.to,
    [HEADERS.sig]: signText(id, requestText({ ...f, ts, nonce })),
  };
}

/** The headers that sign an answer to the request carrying `nonce`. */
export function signResponse(id: Identity, f: { nonce: string; status: number; body: string }): Record<string, string> {
  const ts = Date.now();
  return {
    [HEADERS.key]: id.publicKey,
    [HEADERS.ts]: String(ts),
    [HEADERS.sig]: signText(id, responseText({ ...f, ts })),
  };
}

export type Header = string | string[] | undefined;
const one = (h: Header) => (Array.isArray(h) ? h[0] : h);

export interface VerifiedCaller {
  publicKey: string;
  swarmId: string;
  nonce: string;
  ts: number;
}

/** How far a message's clock may be from ours. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Checks the signature, the clock and the addressee of a request. Replay protection (a nonce seen before) is the
 * caller's job, because it needs the database. Returns a reason string when the request must be refused.
 */
export function verifyRequest(
  headers: Record<string, Header>,
  f: { method: string; path: string; body: string },
  me: { swarmId: string },
  now = Date.now(),
): VerifiedCaller | string {
  const publicKey = one(headers[HEADERS.key]);
  const ts = Number(one(headers[HEADERS.ts]));
  const nonce = one(headers[HEADERS.nonce]);
  const to = one(headers[HEADERS.to]) ?? '';
  const sig = one(headers[HEADERS.sig]);
  if (!publicKey || !nonce || !sig || !Number.isFinite(ts)) return 'unsigned request';
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return 'bad nonce';
  if (!validPublicKey(publicKey)) return 'bad key';
  if (Math.abs(now - ts) > CLOCK_SKEW_MS) return 'clock too far off';
  if (to && to !== me.swarmId) return 'not addressed to this swarm';
  if (!verifyText(publicKey, requestText({ ...f, ts, nonce, to }), sig)) return 'bad signature';
  return { publicKey, swarmId: swarmIdOf(publicKey), nonce, ts };
}

/** Verifies an answer signed by `publicKey` to the request carrying `nonce`. */
export function verifyResponse(headers: Record<string, Header>, f: { nonce: string; status: number; body: string }, now = Date.now()): { publicKey: string; swarmId: string } | string {
  const publicKey = one(headers[HEADERS.key]);
  const ts = Number(one(headers[HEADERS.ts]));
  const sig = one(headers[HEADERS.sig]);
  if (!publicKey || !sig || !Number.isFinite(ts)) return 'unsigned answer';
  if (!validPublicKey(publicKey)) return 'bad key';
  if (Math.abs(now - ts) > CLOCK_SKEW_MS) return 'clock too far off';
  if (!verifyText(publicKey, responseText({ ...f, ts }), sig)) return 'bad signature';
  return { publicKey, swarmId: swarmIdOf(publicKey) };
}
