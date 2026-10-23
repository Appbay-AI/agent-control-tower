// Web Push sending with nothing but Web Crypto, so it runs on Cloudflare (no Node libraries).
// - Payload encryption: RFC 8291 (Message Encryption for Web Push), "aes128gcm" content coding from RFC 8188.
// - Sender identification: RFC 8292 (VAPID), an ES256-signed JWT for the push service's origin.

export interface PushSubscriptionKeys {
  endpoint: string
  p256dh: string // the browser's public key, base64url, 65-byte uncompressed P-256 point
  auth: string // the browser's 16-byte authentication secret, base64url
}

export interface Vapid {
  public_key: string // base64url, 65-byte uncompressed point
  private_jwk: JsonWebKey
  subject: string // https: or mailto: contact for the push service
}

const enc = new TextEncoder()

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', concat(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: concat(salt), info: concat(info) }, key, bytes * 8))
}

/** Test hook: a fixed sender key pair and salt make the output reproducible. */
export interface EncryptOptions { senderKeys?: CryptoKeyPair; salt?: Uint8Array }

/**
 * Encrypts one push message for one browser (RFC 8291 section 3). Returns the full request body:
 * header (salt, record size 4096, sender public key) followed by the single encrypted record.
 */
export async function encryptPayload(sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>, plaintext: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(sub.p256dh)
  const authSecret = b64urlDecode(sub.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Invalid subscription key (p256dh)')
  if (authSecret.length !== 16) throw new Error('Invalid subscription secret (auth)')
  if (plaintext.length > 3993) throw new Error('Message too long for one push record')

  const sender = opts.senderKeys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', concat(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.privateKey, 256))

  // Combine the ECDH secret with the authentication secret (section 3.3).
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)

  // Content encryption key and nonce (RFC 8188 section 2.2 / 2.3).
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  // One record: the plaintext followed by the 0x02 delimiter (last record), no extra padding.
  const record = concat(plaintext, new Uint8Array([2]))
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record))

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, ciphertext)
}

/** The VAPID Authorization header for one push service (RFC 8292 section 2). Valid for 12 hours. */
export async function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject,
  })))
  const key = await crypto.subtle.importKey('jwk', { ...vapid.private_jwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // Web Crypto gives the raw r||s signature that JWS ES256 expects.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapid.public_key}`
}

export type SendOutcome = 'delivered' | 'gone' | 'failed'

/** Sends one encrypted message. 404/410 mean the browser unsubscribed: the device should be removed. */
export async function sendPush(sub: PushSubscriptionKeys, payload: unknown, vapid: Vapid, opts: { topic?: string; fetchImpl?: typeof fetch } = {}):
  Promise<{ outcome: SendOutcome; status: number; error?: string }> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)))
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(sub.endpoint, vapid),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(24 * 3600),
    urgency: 'high',
  }
  // A topic replaces an older undelivered message with the same topic (max 32 base64url characters).
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(sub.endpoint, { method: 'POST', headers, body })
  } catch (e) {
    return { outcome: 'failed', status: 0, error: `Push service unreachable: ${(e as Error).message}` }
  }
  if (res.status >= 200 && res.status < 300) return { outcome: 'delivered', status: res.status }
  if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status }
  const text = (await res.text().catch(() => '')).slice(0, 200)
  return { outcome: 'failed', status: res.status, error: `${res.status} from push service${text ? `: ${text}` : ''}` }
}
