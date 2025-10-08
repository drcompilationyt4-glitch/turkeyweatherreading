import { Page } from 'rebrowser-playwright'
import { Workers } from '../Workers'

export class UrlReward extends Workers {

    /**
     * Try clicking a selector up to maxAttempts.
     * Returns { success, reason?, popup? }.
     * Does:
     *  - wait for selector attached,
     *  - scroll into view,
     *  - check bounding box & computed style,
     *  - try page.click(), fallback to evaluate(el => el.click()),
     *  - detect popup (new Page) or navigation.
     *
     * Uses base Workers overlay helpers (hideOverlappingOverlays / restoreHiddenOverlays).
     */
    private async clickWithRetries(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000): Promise<{ success: boolean, reason?: string, popup?: Page }> {
        // helper visibility check
        const visibleCheck = async (sel: string) => {
            try {
                const handle = await page.$(sel)
                if (!handle) return { ok: false, reason: 'not-found' }

                // try scrollIntoViewIfNeeded, fallback to eval scroll
                try {
                    // @ts-ignore
                    await handle.scrollIntoViewIfNeeded?.({ timeout: 1500 })
                } catch {
                    await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (el) el.scrollIntoView({ block: 'center', inline: 'center' })
                    }, sel)
                }

                const box = await handle.boundingBox()
                const style = await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null
                    if (!el) return { display: 'none', visibility: 'hidden', opacity: '0', hidden: true }
                    const cs = window.getComputedStyle(el)
                    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, hidden: el.hasAttribute('hidden') }
                }, sel)

                if (!box || box.width === 0 || box.height === 0) return { ok: false, reason: 'zero-bounding-box' }
                if (style.hidden || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
                    return { ok: false, reason: 'css-hidden' }
                }
                return { ok: true }
            } catch (err) {
                return { ok: false, reason: 'visibility-check-error' }
            }
        }

        // context for popup detection
        // @ts-ignore
        const context = page.context ? page.context() : null

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await page.waitForSelector(selector, { state: 'attached', timeout: Math.min(3000, perAttemptTimeout) })
            } catch {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: selector not attached (attempt ${attempt}/${maxAttempts}): ${selector}`, 'warn')
            }

            const vis = await visibleCheck(selector)
            if (!vis.ok) {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: selector not visible/clickable (${vis.reason}) (attempt ${attempt}/${maxAttempts}): ${selector}`, 'warn')
                // if obviously hidden, stop retrying
                if (['css-hidden', 'not-found', 'zero-bounding-box'].includes(vis.reason || '')) {
                    // If css-hidden, attempt to hide overlays (call base helper) and then retry
                    if (vis.reason === 'css-hidden') {
                        try {
                            const hid = await this.hideOverlappingOverlays(page, selector)
                            if (hid > 0) {
                                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: hid ${hid} overlay(s) covering ${selector}`)
                            }
                        } catch {}
                    }
                    return { success: false, reason: vis.reason }
                }
                // else wait small amount and try again
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                continue
            }

            // short popup detection window
            let popupPromise: Promise<Page | null> | null = null
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1000 }).catch(() => null)
            }
            const navPromise = page.waitForNavigation({ timeout: 1000 }).catch(() => null)

            // try click
            try {
                await page.click(selector, { timeout: perAttemptTimeout })
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: page.click failed (attempt ${attempt}/${maxAttempts}) for ${selector}, trying evaluate click`, 'warn')
                try {
                    const clicked = await page.evaluate((sel) => {
                        const el = document.querySelector(sel) as HTMLElement | null
                        if (!el) return false
                        el.click()
                        return true
                    }, selector)
                    if (!clicked) {
                        this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: evaluate click couldn't find element for ${selector}`, 'warn')
                        await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                        continue
                    }
                } catch (err2) {
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: evaluate click threw for ${selector}: ${err2}`, 'error')
                    await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                    continue
                }
            }

            const popup = popupPromise ? await popupPromise : null
            const nav = await navPromise

            // restore overlays (call base helper)
            try { await this.restoreHiddenOverlays(page) } catch {}

            if (popup) {
                try { await popup.waitForLoadState('domcontentloaded', { timeout: 120000 }).catch(() => null) } catch {}
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: click opened popup for ${selector}`)
                return { success: true, popup }
            }

            if (nav) {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: click caused navigation for ${selector}`)
                return { success: true }
            }

            // assume success if no errors
            this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: click success for ${selector} (attempt ${attempt}/${maxAttempts})`)
            return { success: true }
        }

        this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: exhausted ${maxAttempts} attempts for ${selector}`, 'error')
        return { success: false, reason: 'max-retries' }
    }

    async doUrlReward(page: Page) {
        this.bot.log(this.bot.isMobile, 'URL-REWARD', 'Trying to complete UrlReward')

        try {
            // small initial wait (preserve original timing)
            await this.bot.utils.wait(2000)

            // Use a robust selector for Gamification DailySet tiles (matches your logs)
            const tileSelector = '[data-bi-id^="Gamification_DailySet_"] .pointLink:not(.contentContainer .pointLink)'

            // If the page actually contains those tiles, try to click one
            const tileExists = await page.waitForSelector(tileSelector, { state: 'visible', timeout: 50000 }).then(() => true).catch(() => false)
            if (tileExists) {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `Found dailyset tile, attempting robust click: ${tileSelector}`)

                // try up to 3 attempts and don't block server longer than allowed
                const clickResult = await this.clickWithRetries(page, tileSelector, 3, 10000)
                if (!clickResult.success) {
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', `Could not click dailyset tile after retries: ${clickResult.reason}`, 'warn')
                    // continue gracefully: maybe the task is already open or the tile is irrelevant
                } else if (clickResult.popup) {
                    // If click opened a popup, continue on the popup page so the reward flow can complete there
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', 'Click opened a popup — switching to popup page to continue flow')
                    page = clickResult.popup
                    // give popup time to load a bit
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500))
                } else {
                    // If click caused navigation or normal click, give a short delay for content to load
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500))
                }
            } else {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', 'No Gamification_DailySet tile found on this page — proceeding with UrlReward default flow')
            }

            // preserve original minimal behavior — wait then close
            await this.bot.utils.wait(2000)

            try { await page.close() } catch {}

            this.bot.log(this.bot.isMobile, 'URL-REWARD', 'Completed the UrlReward successfully')
        } catch (error) {
            try { await page.close() } catch {}
            this.bot.log(this.bot.isMobile, 'URL-REWARD', 'An error occurred:' + error, 'error')
        }
    }

}
