import { api } from '@/lib/api'

// Task 2.6: phone alerts (Web Push) and installing the app.

export type AlertSupport =
  | 'ok' // can turn alerts on here
  | 'ios-add-to-home' // iPhone/iPad in a browser tab: Apple allows alerts only for apps added to the Home Screen
  | 'unsupported' // this browser has no Web Push
  | 'blocked' // the person (or the browser) said no; only the browser's settings can change that

export interface BrowserFacts {
  userAgent: string
  touchMac: boolean // iPadOS reports itself as a Mac with a touch screen
  standalone: boolean // opened from the Home Screen / as an installed app
  hasServiceWorker: boolean
  hasPush: boolean
  hasNotification: boolean
  permission: NotificationPermission | null
}

export function browserFacts(): BrowserFacts {
  const nav = navigator as Navigator & { standalone?: boolean }
  return {
    userAgent: nav.userAgent,
    touchMac: /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1,
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPush: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : null,
  }
}

export const isIos = (f: Pick<BrowserFacts, 'userAgent' | 'touchMac'>) => /iPhone|iPad|iPod/.test(f.userAgent) || f.touchMac

export function alertSupport(f: BrowserFacts): AlertSupport {
  if (isIos(f) && !f.standalone) return 'ios-add-to-home'
  if (!f.hasServiceWorker || !f.hasPush || !f.hasNotification) return 'unsupported'
  if (f.permission === 'denied') return 'blocked'
  return 'ok'
}

/** A short name for the device, shown to the person and stored with the subscription, e.g. "Android · Chrome". */
export function deviceName(ua: string, touchMac = false): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || touchMac ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

export function bytesToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return ''
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i])

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(message)), ms) })])
    .finally(() => clearTimeout(timer))
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // The app's service worker (it also holds the offline copy); wait up to 10 seconds for it.
  const ready = navigator.serviceWorker.ready
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('The app is still installing. Try again in a moment.')), 10_000))
  return Promise.race([ready, timeout])
}

/** This device's subscription, if alerts are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** Turns alerts on for this device. Must be called straight from a tap or click (browsers require it). */
export async function turnOnAlerts(): Promise<PushSubscription> {
  // Ask first, while the tap is still "fresh": Safari refuses the request after other awaits.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Alerts are blocked for this site. Allow notifications in the browser or phone settings, then try again.'
      : 'Alerts were not allowed.')
  }
  const key = await api.pushPublicKey()
  if (!key) throw new Error('Alerts are not set up on this server yet.')
  const serverKey = base64UrlToBytes(key)
  const reg = await registration()
  let sub = await reg.pushManager.getSubscription()
  // Subscribed with an older server key: start again, or alerts would never arrive.
  if (sub && !sameKey(sub.options.applicationServerKey, serverKey)) {
    await sub.unsubscribe()
    sub = null
  }
  // The browser asks its push service (Google, Apple or Mozilla) for an address; offline, that can wait for ever.
  sub ??= await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey }), 20_000,
    "The phone's push service didn't answer. Check the connection and try again.")
  const f = browserFacts()
  await api.pushSubscribe({
    endpoint: sub.endpoint,
    p256dh: bytesToBase64Url(sub.getKey('p256dh')),
    auth: bytesToBase64Url(sub.getKey('auth')),
    device: deviceName(f.userAgent, f.touchMac),
  })
  return sub
}

export async function turnOffAlerts(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await api.pushUnsubscribe(sub.endpoint)
  await sub.unsubscribe()
}

// ---------------------------------------------------------------------------
// Installing the app (Android and desktop Chrome/Edge offer a prompt; iPhone uses Share → Add to Home Screen)
// ---------------------------------------------------------------------------
interface InstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let installPrompt: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

/** Called once at start-up: the browser may offer installation before any screen is ready to show the button. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e as InstallPromptEvent
    listeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = null
    listeners.forEach((l) => l())
  })
}

export const canInstall = () => installPrompt !== null
export function onInstallChange(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
export async function install(): Promise<boolean> {
  if (!installPrompt) return false
  await installPrompt.prompt()
  const { outcome } = await installPrompt.userChoice
  installPrompt = null
  listeners.forEach((l) => l())
  return outcome === 'accepted'
}
