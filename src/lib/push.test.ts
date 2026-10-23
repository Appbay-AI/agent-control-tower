import { alertSupport, base64UrlToBytes, bytesToBase64Url, deviceName, type BrowserFacts } from '@/lib/push'

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  pixelChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
}

const facts = (over: Partial<BrowserFacts> = {}): BrowserFacts => ({
  userAgent: UA.pixelChrome, touchMac: false, standalone: false, hasServiceWorker: true, hasPush: true, hasNotification: true,
  permission: 'default', ...over,
})

describe('phone alerts: what this device can do (task 2.6)', () => {
  it('Android and desktop browsers can turn alerts on straight away', () => {
    expect(alertSupport(facts())).toBe('ok')
    expect(alertSupport(facts({ userAgent: UA.windowsEdge, permission: 'granted' }))).toBe('ok')
  })

  it('iPhone and iPad need the app on the Home Screen first (Apple\'s rule since iOS 16.4)', () => {
    expect(alertSupport(facts({ userAgent: UA.iphoneSafari, hasPush: false }))).toBe('ios-add-to-home')
    expect(alertSupport(facts({ userAgent: UA.ipadAsMac, touchMac: true }))).toBe('ios-add-to-home')
    expect(alertSupport(facts({ userAgent: UA.iphoneSafari, standalone: true }))).toBe('ok')
    // Opened from the Home Screen but on an older iOS without Web Push.
    expect(alertSupport(facts({ userAgent: UA.iphoneSafari, standalone: true, hasPush: false }))).toBe('unsupported')
  })

  it('says when the browser has no Web Push, or when alerts were refused', () => {
    expect(alertSupport(facts({ hasServiceWorker: false }))).toBe('unsupported')
    expect(alertSupport(facts({ hasNotification: false }))).toBe('unsupported')
    expect(alertSupport(facts({ permission: 'denied' }))).toBe('blocked')
  })

  it('names the device the way a person would recognise it', () => {
    expect(deviceName(UA.iphoneSafari)).toBe('iPhone · Safari')
    expect(deviceName(UA.pixelChrome)).toBe('Android · Chrome')
    expect(deviceName(UA.ipadAsMac, true)).toBe('iPad · Safari')
    expect(deviceName(UA.ipadAsMac)).toBe('Mac · Safari')
    expect(deviceName(UA.windowsEdge)).toBe('Windows · Edge')
    expect(deviceName(UA.samsung)).toBe('Android · Samsung Internet')
  })

  it('converts keys between the browser\'s bytes and the text the server stores', () => {
    const bytes = new Uint8Array([4, 255, 0, 62, 63, 250, 251])
    const text = bytesToBase64Url(bytes.buffer)
    expect(text).toBe('BP8APj_6-w')
    expect(Array.from(base64UrlToBytes(text))).toEqual(Array.from(bytes))
    expect(bytesToBase64Url(null)).toBe('')
  })
})
