import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'
import { RETRY_LIMITS, TIMEOUTS } from '../../constants'
// Preferred: use Playwright types (install playwright as a devDependency if needed).
// npm i -D playwright
import type { Locator } from 'playwright' // <-- changed from '@playwright/test'

// If you prefer not to add playwright as a dependency, replace the above line with:
// type Locator = any

export class ABC extends Workers {
    // Defaults (ms)
    private static readonly DEFAULT_MIN_DELAY_MS = 1500
    private static readonly DEFAULT_MAX_DELAY_MS = 5000

    async doABC(page: Page) {
        this.bot.log(this.bot.isMobile, 'ABC', 'Trying to complete poll')

        const maxIterations = (RETRY_LIMITS && typeof RETRY_LIMITS.ABC_MAX === 'number') ? RETRY_LIMITS.ABC_MAX : 15
        const dashboardWait = (TIMEOUTS && typeof TIMEOUTS.DASHBOARD_WAIT === 'number') ? TIMEOUTS.DASHBOARD_WAIT : 120000
        const longTimeout = (TIMEOUTS && typeof TIMEOUTS.LONG === 'number') ? TIMEOUTS.LONG : 5000

        try {
            let $ = await this.bot.browser.func.loadInCheerio(page)

            let i
            for (i = 0; i < maxIterations && !$('span.rw_icon').length; i++) {
                // Random human-like pause before interacting
                await this.randomSleep()

                // Wait for answer options to appear
                try {
                    await page.waitForSelector('.wk_OptionClickClass', { state: 'attached', timeout: dashboardWait })
                } catch { /* non-fatal, will re-check below */ }

                // Prefer Playwright locator (more robust) but fall back to Cheerio if needed
                let answersLocator = page.locator('.wk_OptionClickClass')
                let answerCount = (await answersLocator.count()) || 0

                if (answerCount === 0) {
                    // Try Cheerio approach (legacy main branch) to find ids
                    const answers = $('.wk_OptionClickClass')
                    if (answers && answers.length) {
                        // If cheerio found answers but Playwright did not, try clicking by id
                        const idx = this.bot.utils.randomNumber(0, Math.min(answers.length - 1, 2))
                        const answerId = answers[idx]?.attribs?.['id']
                        if (answerId) {
                            try {
                                await page.waitForSelector(`#${answerId}`, { state: 'visible', timeout: dashboardWait })
                                await this.clickBySelectorRobust(page, `#${answerId}`)
                            } catch {
                                this.bot.log(this.bot.isMobile, 'ABC', `Failed to click answer by id ${answerId}`, 'warn')
                            }
                        }
                    } else {
                        this.bot.log(this.bot.isMobile, 'ABC', 'No answers found on question — retrying', 'warn')
                        await this.bot.utils.wait(1000)
                        page = await this.bot.browser.utils.getLatestTab(page)
                        $ = await this.bot.browser.func.loadInCheerio(page)
                        continue
                    }
                } else {
                    // Choose a random answer index from what's actually present
                    const idx = this.bot.utils.randomNumber(0, Math.max(0, answerCount - 1))
                    const chosenAnswer = answersLocator.nth(idx)

                    // Try to click the answer robustly (bounded retries)
                    const clicked = await this.clickLocatorRobust(page, chosenAnswer, 3)
                    if (!clicked) {
                        this.bot.log(this.bot.isMobile, 'ABC',
                            `Chosen answer could not be clicked after 3 attempts (idx=${idx}) — skipping question`, 'warn')
                        // refresh and continue to avoid getting stuck on the same question
                        await this.bot.utils.wait(500)
                        page = await this.bot.browser.utils.getLatestTab(page)
                        $ = await this.bot.browser.func.loadInCheerio(page)
                        continue
                    }
                }

                // small random pause after clicking an answer
                await this.randomSleep()

                // Click the "next" / submit button robustly
                const nextBtnLocator = page.locator('div.wk_button').first()
                const nextClicked = await this.clickLocatorRobust(page, nextBtnLocator, 3)
                if (!nextClicked) {
                    this.bot.log(this.bot.isMobile, 'ABC',
                        'Next button could not be clicked after 3 attempts — attempting to continue', 'warn')
                }

                // wait for tab to update and load next question
                page = await this.bot.browser.utils.getLatestTab(page)
                $ = await this.bot.browser.func.loadInCheerio(page)

                // short pause after page load
                await this.randomSleep()
            }

            // final wait + close
            await this.bot.utils.wait(longTimeout + 1000)
            try { await page.close() } catch { /* ignore */ }

            if (i === maxIterations) {
                this.bot.log(this.bot.isMobile, 'ABC', `Failed to solve quiz, exceeded max iterations of ${maxIterations}`, 'warn')
            } else {
                this.bot.log(this.bot.isMobile, 'ABC', 'Completed the ABC successfully')
            }

        } catch (error) {
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'ABC', 'An error occurred:' + error, 'error')
        }
    }

    /**
     * Try to click a Playwright Locator robustly.
     */
    private async clickLocatorRobust(page: Page, locator: Locator, maxAttempts = 3): Promise<boolean> {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const count = await locator.count()
                if (count === 0) {
                    this.bot.log(this.bot.isMobile, 'ABC', `Locator has no nodes (attempt ${attempt}/${maxAttempts})`, 'warn')
                    await this.bot.utils.wait(400)
                    continue
                }

                // ensure visible and scroll into view
                try { await locator.first().scrollIntoViewIfNeeded() } catch { /* ignore */ }
                await this.randomSleepShort()

                // element handle required for coverage check
                const handle = await locator.first().elementHandle()
                if (!handle) {
                    this.bot.log(this.bot.isMobile, 'ABC', `Failed to get elementHandle (attempt ${attempt})`, 'warn')
                    await this.bot.utils.wait(400)
                    continue
                }

                // bounding box = not offscreen
                const box = await handle.boundingBox()
                if (!box) {
                    this.bot.log(this.bot.isMobile, 'ABC', `Element boundingBox returned null (offscreen?) (attempt ${attempt})`, 'warn')
                    await this.tryCloseOverlays(page)
                    await this.bot.utils.wait(400)
                    continue
                }

                // coverage check using elementFromPoint at center of bounding rect
                const isClickable = await page.evaluate((el) => {
                    const rect = (el as HTMLElement).getBoundingClientRect()
                    const cx = rect.left + rect.width / 2
                    const cy = rect.top + rect.height / 2
                    const top = document.elementFromPoint(cx, cy)
                    return top === el || (el.contains && el.contains(top))
                }, handle)

                if (!isClickable) {
                    this.bot.log(this.bot.isMobile, 'ABC',
                        `Element appears covered by overlay (attempt ${attempt}) — trying to close overlays`, 'warn')
                    await this.tryCloseOverlays(page)
                    await this.bot.utils.wait(500 + this.bot.utils.randomNumber(0, 500))
                    continue
                }

                // try clicking with a short timeout
                await locator.first().click({ timeout: 5000 })
                return true
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'ABC',
                    `clickLocatorRobust attempt ${attempt}/${maxAttempts} failed: ${err}`, 'warn')
                // try to close overlays and retry
                await this.tryCloseOverlays(page)
                await this.bot.utils.wait(300 + this.bot.utils.randomNumber(0, 700))
            }
        }

        // all attempts failed
        return false
    }

    private async clickBySelectorRobust(page: Page, selector: string, maxAttempts = 3): Promise<boolean> {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await page.waitForSelector(selector, { state: 'visible', timeout: 2000 })
                await page.click(selector, { timeout: 5000 }).catch(() => { throw new Error('click failed') })
                return true
            } catch (e) {
                await this.tryCloseOverlays(page)
                await this.bot.utils.wait(200 + this.bot.utils.randomNumber(0, 600))
            }
        }
        return false
    }

    /**
     * Best-effort overlay / popup closer.
     */
    private async tryCloseOverlays(page: Page) {
        try {
            // Common overlay selectors and "close" buttons
            const overlayCloseSelectors = [
                'button[aria-label="Close"]',
                'button[title="Close"]',
                '.modal .close',
                '.ms-Callout-beakCurtain',
                '.more_btn_popup .close',
                '.close-button',
                '.dialog .close',
                '.overlay .close'
            ]

            for (const sel of overlayCloseSelectors) {
                try {
                    const loc = page.locator(sel).first()
                    if (await loc.count()) {
                        if (await loc.isVisible()) {
                            try { await loc.click({ timeout: 2000 }) } catch { /* ignore */ }
                            await this.bot.utils.wait(200)
                        }
                    }
                } catch { /* ignore individual selector failures */ }
            }

            // Extra: click outside to dismiss small popovers (click page corner)
            try { await page.mouse.click(10, 10) } catch { /* ignore */ }
        } catch { /* swallow */ }
    }

    /**
     * Sleep for a random (longer) interval between actions.
     */
    private async randomSleep() {
        const minMs = (this.bot.config as any)?.abcMinDelayMs ?? ABC.DEFAULT_MIN_DELAY_MS
        const maxMs = (this.bot.config as any)?.abcMaxDelayMs ?? ABC.DEFAULT_MAX_DELAY_MS
        const ms = this.bot.utils.randomNumber(minMs, maxMs)
        this.bot.log(this.bot.isMobile, 'ABC', `Sleeping for ${ms} ms`, 'log')
        await this.bot.utils.wait(ms)
    }

    /**
     * Smaller random pause used for micro-delays before clicks.
     */
    private async randomSleepShort() {
        const minShort = (this.bot.config as any)?.abcMinShortDelayMs ?? 300
        const maxShort = (this.bot.config as any)?.abcMaxShortDelayMs ?? 1200
        const ms = this.bot.utils.randomNumber(minShort, maxShort)
        await this.bot.utils.wait(ms)
    }
}
