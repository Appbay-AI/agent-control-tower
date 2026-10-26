// @vitest-environment node
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
// An independent implementation of RFC 8188/8291 (used by the web-push library), to check our encryption against.
// @ts-expect-error no types published
import ece from 'http_ece'
import { b64urlDecode, b64urlEncode, encryptPayload, sendPush, vapidAuthorization, type Vapid } from '../functions-lib/webpush'
import { dispatch, onRequestPost } from './api/v1/push/dispatch'

/** A browser's side of a subscription: its key pair and auth secret. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return { ecdh, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) }, auth }
}

async function vapidKeys(): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    public_key: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    private_jwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    subject: 'https://agent-control-tower-56p.pages.dev',
  }
}

const decrypt = (body: Uint8Array, b: ReturnType<typeof browser>) =>
  (ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: b.ecdh, authSecret: b.auth }) as Buffer).toString('utf8')

describe('Web Push encryption (RFC 8291)', () => {
  it('produces a message the browser side can decrypt (checked with an independent library)', async () => {
    const b = browser()
    const text = JSON.stringify({ title: 'Approval needed · REQ-000001', body: 'Payment Release Assistant wants to release £2,000,000' })
    const body = await encryptPayload(b.sub, new TextEncoder().encode(text))
    expect(decrypt(body, b)).toBe(text)
  })

  it('writes the header as the standard says: salt, record size 4096, then the sender key', async () => {
    const b = browser()
    const salt = new Uint8Array(16).fill(7)
    const body = await encryptPayload(b.sub, new TextEncoder().encode('hi'), { salt })
    expect(Array.from(body.slice(0, 16))).toEqual(Array.from(salt))
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body[21]).toBe(4) // uncompressed point
    expect(body.length).toBe(86 + 2 + 1 + 16) // header + "hi" + delimiter + GCM tag
  })

  it('uses a fresh key and salt every time', async () => {
    const b = browser()
    const one = await encryptPayload(b.sub, new Uint8Array([1]))
    const two = await encryptPayload(b.sub, new Uint8Array([1]))
    expect(b64urlEncode(one)).not.toBe(b64urlEncode(two))
  })

  it('refuses bad subscription keys and messages too long for one record', async () => {
    const b = browser()
    await expect(encryptPayload({ ...b.sub, p256dh: b64urlEncode(new Uint8Array(10)) }, new Uint8Array(1))).rejects.toThrow(/p256dh/)
    await expect(encryptPayload({ ...b.sub, auth: 'AAAA' }, new Uint8Array(1))).rejects.toThrow(/auth/)
    await expect(encryptPayload(b.sub, new Uint8Array(4000))).rejects.toThrow(/too long/)
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs a 12-hour token for the push service, verifiable with the public key', async () => {
    const vapid = await vapidKeys()
    const now = Date.UTC(2026, 9, 24, 10, 0, 0)
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, now)
    const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/)!
    expect(m).not.toBeNull()
    expect(m[4]).toBe(vapid.public_key)
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])))).toEqual({
      aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: vapid.subject,
    })
    const key = createPublicKey({ key: { ...vapid.private_jwk, d: undefined }, format: 'jwk' })
    const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(m[3])))
    expect(ok).toBe(true)
  })
})

describe('sending', () => {
  it('posts the encrypted message with the headers push services require, and reads their answers', async () => {
    const b = browser()
    const vapid = await vapidKeys()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    const out = await sendPush(b.sub, { title: 'T', body: 'B' }, vapid, { topic: 'a1b2-c3d4', fetchImpl })
    expect(out).toEqual({ outcome: 'delivered', status: 201 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string>; body: Uint8Array }]
    expect(url).toBe(b.sub.endpoint)
    expect(init.headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', topic: 'a1b2-c3d4' })
    expect(init.headers.authorization).toMatch(/^vapid t=.+, k=/)
    expect(JSON.parse(decrypt(init.body, b))).toEqual({ title: 'T', body: 'B' })

    const gone = await sendPush(b.sub, {}, vapid, { fetchImpl: vi.fn(async () => new Response(null, { status: 410 })) })
    expect(gone.outcome).toBe('gone')
    const failed = await sendPush(b.sub, {}, vapid, { fetchImpl: vi.fn(async () => new Response('slow down', { status: 429 })) })
    expect(failed).toEqual({ outcome: 'failed', status: 429, error: '429 from push service: slow down' })
    const down = await sendPush(b.sub, {}, vapid, { fetchImpl: vi.fn(async () => { throw new Error('offline') }) })
    expect(down).toMatchObject({ outcome: 'failed', status: 0 })
  })
})

describe('POST /api/v1/push/dispatch', () => {
  const TOKEN = 'pdt_' + 'a'.repeat(64)

  it('needs a well-formed token, answers at once and sends in the background', async () => {
    const waitUntil = vi.fn()
    const bad = await onRequestPost({ request: new Request('https://act.test/x', { method: 'POST', body: '{}' }), waitUntil })
    expect(bad.status).toBe(400)
    expect(waitUntil).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"messages":[]}', { status: 200 })))
    const ok = await onRequestPost({ request: new Request('https://act.test/x', { method: 'POST', body: JSON.stringify({ token: TOKEN }) }), waitUntil })
    expect(ok.status).toBe(202)
    expect(waitUntil).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('claims with the token, sends to every device, and reports delivered, gone and failed devices', async () => {
    const phone = browser()
    const laptop = browser()
    const old = browser()
    const vapid = await vapidKeys()
    const claimed = {
      vapid,
      messages: [{ id: 7, title: 'Approval needed · REQ-000009', body: 'Payment Release Assistant wants to release £2,000,000', url: '/approvals/requests/r9', tag: 'r9',
        subscriptions: [
          { id: 's-phone', ...phone.sub, endpoint: 'https://fcm.googleapis.com/fcm/send/phone' },
          { id: 's-laptop', ...laptop.sub, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/laptop' },
          { id: 's-old', ...old.sub, endpoint: 'https://web.push.apple.com/old' },
        ] }],
    }
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body })
      if (url.endsWith('/rpc/push_claim')) return new Response(JSON.stringify(claimed), { status: 200 })
      if (url.endsWith('/rpc/push_report')) return new Response('1', { status: 200 })
      if (url.includes('phone')) return new Response(null, { status: 201 })
      if (url.includes('old')) return new Response(null, { status: 410 })
      return new Response('busy', { status: 503 })
    }) as unknown as typeof fetch

    const out = await dispatch(TOKEN, fetchImpl)
    expect(out.sent).toBe(1)
    expect(JSON.parse(calls[0].body as string)).toEqual({ p_token: TOKEN })
    const reported = JSON.parse(calls.at(-1)!.body as string)
    expect(reported).toEqual({ p_token: TOKEN, p_results: { email: [], callback: [], push: [{ id: 7, delivered: ['s-phone'], gone: ['s-old'], failed: [{ id: 's-laptop', error: '503 from push service: busy' }] }] } })
    // The phone gets the alert it can read, with the link to the task.
    const toPhone = calls.find((c) => c.url.includes('phone'))!
    expect(JSON.parse(decrypt(toPhone.body as Uint8Array, phone))).toEqual({ title: claimed.messages[0].title, body: claimed.messages[0].body, url: '/approvals/requests/r9', tag: 'r9' })
  })

  it('does nothing more when the token is refused or nothing is waiting', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ code: '28000', message: 'Invalid or used dispatch token' }), { status: 401 })) as unknown as typeof fetch
    expect(await dispatch(TOKEN, refused)).toEqual({ sent: 0, results: [], emails: [], callbacks: [] })
    expect(refused).toHaveBeenCalledOnce()
  })
})
