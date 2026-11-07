import type { Page } from 'patchright'

export const REWARDS_DASHBOARD_URL = 'https://rewards.bing.com/dashboard'

/**
 * Points waiting in the dashboard's "Ready to claim" state, read from its embedded Next.js flight data
 * ({"pointClaim":{"points":N}} - escaped inside self.__next_f.push strings). The last occurrence wins,
 * as later chunks carry the current state. Returns null when the dashboard doesn't expose it.
 */
export function claimablePointsFromHtml(html: string): number | null {
    const matches = [...html.matchAll(/pointClaim\\*"\s*:\s*\{[^{}]*?\\*"points\\*"\s*:\s*(\d+)/g)]
    const last = matches.at(-1)?.[1]
    return last === undefined ? null : Number(last)
}

/** Fetches the Rewards dashboard with the page's own session cookies (no navigation). */
export async function readPointClaim(page: Page): Promise<{ html: string; claimable: number | null }> {
    const response = await page.request.get(REWARDS_DASHBOARD_URL, { timeout: 20000 })
    if (!response.ok()) throw new Error(`Dashboard request failed | status=${response.status()}`)
    const html = await response.text()
    return { html, claimable: claimablePointsFromHtml(html) }
}
