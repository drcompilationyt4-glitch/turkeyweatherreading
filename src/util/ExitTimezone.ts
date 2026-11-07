import type { Browser } from 'patchright'

export interface GeoEndpoint {
    url: string
    field: string
}

// Public IP-geolocation endpoints that answer without an API key, tried in order
export const GEO_ENDPOINTS: GeoEndpoint[] = [
    { url: 'https://ipinfo.io/json', field: 'timezone' },
    { url: 'https://get.geojs.io/v1/ip/geo.json', field: 'timezone' },
    { url: 'https://ipapi.co/json/', field: 'timezone' }
]

const lookups = new Map<string, Promise<string | null>>()

export function isValidTimezone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value })
        return true
    } catch {
        return false
    }
}

/** Minutes behind UTC in `timeZone` at `date`, signed like Date#getTimezoneOffset (Toronto in winter = 300). */
export function timezoneOffsetMinutes(timeZone: string, date = new Date()): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date)
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value ?? 0)
    const wallClockAsUtc = Date.UTC(
        part('year'),
        part('month') - 1,
        part('day'),
        part('hour'),
        part('minute'),
        part('second')
    )
    const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000
    return Math.round((wholeSeconds - wallClockAsUtc) / 60000)
}

/**
 * Timezone of the IP the browser exits from, looked up through the browser itself so a proxy is
 * honoured. A US/Canadian IP paired with the server's UTC clock is a classic automation tell.
 * Looked up once per process and proxy; a failed lookup is retried on the next browser.
 */
export function resolveExitTimezone(
    browser: Browser,
    proxyKey: string,
    endpoints: GeoEndpoint[] = GEO_ENDPOINTS
): Promise<string | null> {
    let lookup = lookups.get(proxyKey)
    if (!lookup) {
        lookup = lookupTimezone(browser, endpoints)
        lookups.set(proxyKey, lookup)
        void lookup.then(timezone => {
            if (!timezone) lookups.delete(proxyKey)
        })
    }
    return lookup
}

async function lookupTimezone(browser: Browser, endpoints: GeoEndpoint[]): Promise<string | null> {
    try {
        const context = await browser.newContext()
        try {
            const page = await context.newPage()
            for (const endpoint of endpoints) {
                try {
                    const response = await page.goto(endpoint.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    if (!response?.ok()) continue
                    const body = JSON.parse(await response.text()) as Record<string, unknown>
                    const timezone = body[endpoint.field]
                    if (isValidTimezone(timezone)) return timezone
                } catch {
                    // try the next endpoint
                }
            }
            return null
        } finally {
            await context.close().catch(() => {})
        }
    } catch {
        return null
    }
}
