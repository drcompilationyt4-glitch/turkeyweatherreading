import { randomBytes } from 'crypto'
import { AxiosRequestConfig } from 'axios'
import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'
import { DashboardData } from '../../interface/DashboardData'

/**
 * DailyCheckIn
 *
 * - Keeps your original claim logic exactly.
 * - Adds robust HTTP retries/backoff and safe return values.
 * - Adds a click helper for the dashboard "daily set" tile used elsewhere in your runner.
 */
export class DailyCheckIn extends Workers {
    // Humanized defaults (ms)
    private static readonly DEFAULT_MIN_DELAY_MS = 1000
    private static readonly DEFAULT_MAX_DELAY_MS = 2200
    private static readonly DEFAULT_RETRIES = 3
    private static readonly DEFAULT_BASE_BACKOFF_MS = 800
    private static readonly DEFAULT_AXIOS_TIMEOUT_MS = 180000

    /**
     * Main API claim method — preserved logic but more defensive.
     * Returns a result object rather than throwing.
     */
    public async doDailyCheckIn(accessToken: string, data: DashboardData): Promise<{ success: boolean, claimedPoints: number, error?: string }> {
        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'Starting Daily Check In', 'log')

        try {
            if (!accessToken) {
                this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'No access token provided — aborting', 'error')
                return { success: false, claimedPoints: 0, error: 'no-access-token' }
            }

            // Determine geo locale safely (fallback to 'us')
            let geoLocale =
                data && data.userProfile && data.userProfile.attributes && data.userProfile.attributes.country
                    ? data.userProfile.attributes.country
                    : 'us'
            geoLocale =
                (this.bot.config?.searchSettings?.useGeoLocaleQueries && typeof geoLocale === 'string' && geoLocale.length === 2)
                    ? geoLocale.toLowerCase()
                    : 'us'

            // human-like randomized delay before attempting the claim
            const minDelay = (this.bot.config as any)?.dailyCheckInMinDelayMs ?? DailyCheckIn.DEFAULT_MIN_DELAY_MS
            const maxDelay = (this.bot.config as any)?.dailyCheckInMaxDelayMs ?? DailyCheckIn.DEFAULT_MAX_DELAY_MS
            const initialWait = (this.bot.utils?.randomNumber)
                ? this.bot.utils.randomNumber(minDelay, maxDelay)
                : Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay

            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Waiting ${initialWait}ms before claim (humanized)`, 'log')
            await this.bot.utils.wait(initialWait)

            // Build request payload (unchanged)
            const jsonData = {
                amount: 1,
                country: geoLocale,
                id: randomBytes(64).toString('hex'),
                type: 101,
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                }
            }

            // Base request options (unchanged headers & endpoint)
            const claimRequestBase: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Rewards-Country': geoLocale,
                    'X-Rewards-Language': 'en'
                },
                data: JSON.stringify(jsonData),
                // Let us inspect non-2xx statuses ourselves
                validateStatus: () => true
            }

            const maxRetries = (this.bot.config as any)?.dailyCheckInRetries ?? DailyCheckIn.DEFAULT_RETRIES
            const baseBackoff = (this.bot.config as any)?.dailyCheckInBackoffMs ?? DailyCheckIn.DEFAULT_BASE_BACKOFF_MS
            const axiosTimeout = (this.bot.config as any)?.axiosTimeoutMs ?? DailyCheckIn.DEFAULT_AXIOS_TIMEOUT_MS

            let attempt = 0
            let lastError: any = null
            let claimedPoint = 0

            while (attempt < maxRetries) {
                attempt++
                try {
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Attempt ${attempt} to claim daily check-in`, 'log')

                    const requestOpts: AxiosRequestConfig = {
                        ...claimRequestBase,
                        timeout: axiosTimeout
                    }

                    const resp = await this.bot.axios.request(requestOpts)
                    const status = resp?.status ?? 0
                    const respData = resp?.data ?? {}

                    // If server indicates success (2xx) — parse points defensively
                    if (status >= 200 && status < 300) {
                        const p = respData?.response?.activity?.p ?? respData?.response?.activity?.points ?? respData?.p ?? respData?.points
                        const numeric = Number.isFinite(Number(p)) ? Number(p) : (parseInt(p as any) || 0)
                        claimedPoint = numeric

                        if (claimedPoint > 0) {
                            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Claim succeeded; awarded ${claimedPoint} points`, 'log')
                        } else {
                            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'Claim response received but no points were returned (possibly already claimed)', 'log')
                        }

                        return { success: true, claimedPoints: claimedPoint }
                    }

                    // 4xx (except 429) -> likely non-retriable. Log and return.
                    if (status >= 400 && status < 500 && status !== 429) {
                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Claim failed with non-retriable status ${status} — aborting retries. Response: ${JSON.stringify(respData)}`, 'error')
                        return { success: false, claimedPoints: 0, error: `http-${status}` }
                    }

                    // 429 or 5xx are considered transient -> retry
                    if (status === 429 || (status >= 500 && status < 600)) {
                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Transient server response (status ${status}), will retry if attempts remain. Response: ${JSON.stringify(respData)}`, 'warn')
                        lastError = { status, data: respData }
                    } else {
                        // Unknown status -> log & abort
                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Unexpected HTTP status ${status}; response: ${JSON.stringify(respData)}`, 'warn')
                        lastError = { status, data: respData }
                        break
                    }
                } catch (err) {
                    lastError = err
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Claim attempt ${attempt} threw an error: ${err}`, 'warn')
                }

                // Retry/backoff if attempts remain
                if (attempt < maxRetries) {
                    const backoffBase = baseBackoff * Math.pow(2, attempt - 1)
                    const jitter = (this.bot.utils?.randomNumber)
                        ? this.bot.utils.randomNumber(0, backoffBase)
                        : Math.floor(Math.random() * (backoffBase + 1))
                    const waitMs = backoffBase + jitter

                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Waiting ${waitMs}ms before next retry (${attempt + 1}/${maxRetries})`, 'log')
                    await this.bot.utils.wait(waitMs)
                    continue
                } else {
                    break
                }
            }

            // exhausted attempts
            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Failed to claim after ${maxRetries} attempts. Last error: ${JSON.stringify(lastError)}`, 'error')
            return { success: false, claimedPoints: 0, error: JSON.stringify(lastError) }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'An error occurred while attempting daily check-in: ' + error, 'error')
            return { success: false, claimedPoints: 0, error: String(error) }
        }
    }

    /**
     * UI helper: robustly click the daily-set tile on the dashboard (if present).
     *
     * This helper:
     *  - tries multiple selector candidates that map to the DailySet / Daily Offer tile(s)
     *  - attempts up to `maxAttempts` overall (so your server won't hang)
     *  - scrolls into view, checks visibility & bounding-box
     *  - checks if the element is covered using elementFromPoint
     *  - tries native page.click() with a short timeout, falls back to DOM click if needed
     *  - attempts to close common overlays between tries
     *  - detects if click opened a popup page or caused navigation and returns that info
     *
     * IMPORTANT: this does NOT attempt to click *every* dashboard card — it searches for a first
     * candidate matching “daily” patterns and tries to open it. That keeps the logic focused and fast.
     */
    public async clickDailySetTileIfPresent(page: Page, maxAttempts = 3): Promise<{ success: boolean, reason?: string, popup?: Page }> {
        // Candidate selectors ordered by specificity -> fallback.
        const candidates = [
            // classic pattern you've used previously (keeps exact behavior)
            '[data-bi-id^="Gamification_DailySet_"] .pointLink:not(.contentContainer .pointLink)',
            // variations observed in saved page & logs
            '[data-bi-id*="DailySet"] .pointLink:not(.contentContainer .pointLink)',
            '[data-bi-id*="DailyGlobalOffer"] .pointLink:not(.contentContainer .pointLink)',
            '[data-bi-id*="Daily"] .pointLink:not(.contentContainer .pointLink)',
            // generic pattern used by rewards tiles (fallback)
            '.pointLink:not(.contentContainer .pointLink)'
        ]

        // quick presence pre-check (fast, small timeout)
        let foundAny = false
        for (const sel of candidates) {
            const ok = await page.waitForSelector(sel, { state: 'attached', timeout: 50000 }).then(() => true).catch(() => false)
            if (ok) { foundAny = true; break }
        }
        if (!foundAny) {
            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'DailySet: no candidate selectors present on page', 'log')
            return { success: false, reason: 'not-found' }
        }

        // helper to check visibility + bounding box + css
        const isElementClickable = async (sel: string) => {
            try {
                const handle = await page.$(sel)
                if (!handle) return { ok: false, reason: 'not-found' }

                // try scrollIntoViewIfNeeded if available on handle
                try {
                    // @ts-ignore
                    if (typeof handle.scrollIntoViewIfNeeded === 'function') {
                        // some Playwright versions expose this on elementHandle
                        // @ts-ignore
                        await handle.scrollIntoViewIfNeeded({ timeout: 10000 })
                    } else {
                        // fallback to page.evaluate scrollIntoView
                        await page.evaluate((s) => {
                            const el = document.querySelector(s) as HTMLElement | null
                            if (el) el.scrollIntoView({ block: 'center', inline: 'center' })
                        }, sel)
                    }
                } catch { /* non-fatal */ }

                const box = await handle.boundingBox()
                if (!box || box.width === 0 || box.height === 0) return { ok: false, reason: 'zero-bounding-box' }

                const style = await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null
                    if (!el) return { display: 'none', visibility: 'hidden', opacity: '0', hidden: true }
                    const cs = window.getComputedStyle(el)
                    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, hidden: el.hasAttribute('hidden') }
                }, sel)

                if (style.hidden || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
                    return { ok: false, reason: 'css-hidden' }
                }

                // coverage check using elementFromPoint at element center
                const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
                const topTag = await page.evaluate(({ x, y, sel }) => {
                    const top = document.elementFromPoint(x, y)
                    if (!top) return null
                    // walk up from top to see if `sel` element contains it
                    const target = document.querySelector(sel)
                    if (!target) return null
                    return (top === target || target.contains(top)) ? 'self-or-contained' : 'covered'
                }, { x: center.x, y: center.y, sel })

                if (topTag === 'covered' || topTag === null) {
                    return { ok: false, reason: 'covered-by-overlay' }
                }

                return { ok: true }
            } catch (err) {
                return { ok: false, reason: 'visibility-check-error' }
            }
        }

        // get context for popup detection (if available)
        const context = (typeof (page as any).context === 'function') ? (page as any).context() : null

        // attempt loop across all candidates up to maxAttempts total
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            for (const sel of candidates) {
                const check = await isElementClickable(sel)
                if (!check.ok) {
                    // only log the failure for the first attempt to reduce spam
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `DailySet: selector "${sel}" not clickable (${check.reason}) attempt ${attempt}/${maxAttempts}`, 'warn')
                    // if the reason is structural (not-found/css-hidden/zero-bounding-box) we may skip trying same selector repeatedly
                    if (['not-found', 'css-hidden', 'zero-bounding-box'].includes(check.reason || '')) {
                        continue
                    } else {
                        // try to close overlays and retry this attempt
                        await this.tryCloseOverlays(page)
                        await this.bot.utils.wait(this.bot.utils.randomNumber(200, 700))
                        continue
                    }
                }

                // prepare popup/nav detection before click
                let popupPromise: Promise<Page | null> | null = null
                try {
                    if (context) popupPromise = context.waitForEvent('page', { timeout: 30000 }).catch(() => null)
                } catch { popupPromise = null }

                const navPromise = page.waitForNavigation({ timeout: 30000 }).catch(() => null)

                // attempt native click first (short timeout)
                let clicked = false
                try {
                    await page.click(sel, { timeout: 30000 })
                    clicked = true
                } catch (clickErr) {
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `DailySet: native click failed for "${sel}" (attempt ${attempt}), trying DOM click fallback`, 'warn')
                    // DOM click fallback
                    try {
                        const fallbackClicked = await page.evaluate((s) => {
                            const el = document.querySelector(s) as HTMLElement | null
                            if (!el) return false
                            el.click()
                            return true
                        }, sel)
                        clicked = !!fallbackClicked
                    } catch (evalErr) {
                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `DailySet: DOM click fallback threw for "${sel}": ${evalErr}`, 'warn')
                    }
                }

                if (!clicked) {
                    // try close overlays and continue with other selectors / attempts
                    await this.tryCloseOverlays(page)
                    await this.bot.utils.wait(this.bot.utils.randomNumber(200, 700))
                    continue
                }

                // wait briefly for popup/navigation detection results
                const popup = popupPromise ? await popupPromise : null
                const navResult = await navPromise

                if (popup) {
                    try { await popup.waitForLoadState('domcontentloaded', { timeout: 120000 }).catch(() => null) } catch { /* ignore */ }
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `DailySet: clicked selector "${sel}" and opened popup`, 'log')
                    return { success: true, popup }
                }

                if (navResult) {
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `DailySet: clicked selector "${sel}" and caused navigation`, 'log')
                    return { success: true }
                }

                // If neither popup nor navigation, we treat the click as success (tile may expand inline)
                this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `DailySet: clicked selector "${sel}" (attempt ${attempt}/${maxAttempts})`, 'log')
                return { success: true }
            } // end candidate loop

            // nothing worked in this attempt — close overlays and wait a bit before next attempt
            await this.tryCloseOverlays(page)
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
        } // end attempts

        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'DailySet: exhausted attempts, nothing clickable', 'warn')
        return { success: false, reason: 'max-retries' }
    }

    /**
     * Best-effort overlay / popup closer used by the UI helper above.
     */
    private async tryCloseOverlays(page: Page) {
        try {
            const overlayCloseSelectors = [
                'button[aria-label="Close"]',
                'button[title="Close"]',
                '.modal .close',
                '.ms-Callout-beakCurtain',
                '.more_btn_popup .close',
                '.close-button',
                '.dialog .close',
                '.overlay .close',
                '.callout .close',
                '.reward-popup .close'
            ]

            for (const sel of overlayCloseSelectors) {
                try {
                    const loc = page.locator(sel).first()
                    if (await loc.count()) {
                        if (await loc.isVisible()) {
                            try { await loc.click({ timeout: 1500 }) } catch { /* ignore */ }
                            await this.bot.utils.wait(150)
                        }
                    }
                } catch { /* ignore individual selector */ }
            }

            // Click a corner to dismiss small popovers (safe click)
            try { await page.mouse.click(5, 5) } catch { /* ignore */ }
        } catch { /* swallow */ }
    }
}
