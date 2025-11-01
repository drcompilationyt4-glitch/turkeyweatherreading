import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'

export class UrlReward extends Workers {

    /**
     * Local conservative overlay hider used if Workers doesn't provide one.
     * Returns number of elements hidden.
     */
    private async localHideOverlappingOverlays(page: Page, selector: string): Promise<number> {
        try {
            return await page.evaluate((sel) => {
                try {
                    const target = document.querySelector(sel) as HTMLElement | null;
                    if (!target) return 0;
                    const tBox = target.getBoundingClientRect();
                    const elems = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
                    let hidden = 0;
                    for (const el of elems) {
                        try {
                            if (el === target) continue;
                            const style = window.getComputedStyle(el);
                            if (!style) continue;
                            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) continue;
                            const pos = style.position;
                            if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
                            const r = el.getBoundingClientRect();
                            if (r.width === 0 || r.height === 0) continue;
                            const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom);
                            if (overlap) {
                                el.setAttribute('data-qa-hidden-temp', 'true');
                                (el as HTMLElement).style.setProperty('display', 'none', 'important');
                                hidden++;
                            }
                        } catch { /* ignore per-element errors */ }
                    }
                    return hidden;
                } catch { return 0 }
            }, selector)
        } catch { return 0 }
    }

    /**
     * Local restore for previously hidden overlays.
     */
    private async localRestoreHiddenOverlays(page: Page): Promise<void> {
        try {
            await page.evaluate(() => {
                try {
                    const elems = Array.from(document.querySelectorAll('[data-qa-hidden-temp]')) as HTMLElement[];
                    for (const el of elems) {
                        try {
                            el.removeAttribute('data-qa-hidden-temp');
                            el.style.removeProperty('display');
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            })
        } catch { /* ignore */ }
    }

    /**
     * Try clicking a selector up to maxAttempts. Returns { success, reason?, popup? }.
     * Uses base Workers helpers hideOverlappingOverlays/restoreHiddenOverlays when available, otherwise falls back to local versions.
     */
    private async clickWithRetries(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000): Promise<{ success: boolean, reason?: string, popup?: Page }> {
        const visibleCheck = async (sel: string) => {
            try {
                const handle = await page.$(sel)
                if (!handle) return { ok: false, reason: 'not-found' }

                try { await (handle as any).scrollIntoViewIfNeeded?.({ timeout: 1500 }) } catch {
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

        // detect whether Workers provides overlays helpers
        const hasHideHelper = typeof (this as any).hideOverlappingOverlays === 'function'
        const hasRestoreHelper = typeof (this as any).restoreHiddenOverlays === 'function'

        // @ts-ignore
        const context = page.context ? page.context() : null

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await page.waitForSelector(selector, { state: 'attached', timeout: Math.min(3000, perAttemptTimeout) }).catch(() => null)

                const vis = await visibleCheck(selector)
                if (!vis.ok) {
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: selector not visible/clickable (${vis.reason}) (attempt ${attempt}/${maxAttempts}): ${selector}`, 'warn')

                    if (vis.reason === 'css-hidden') {
                        try {
                            const hid = hasHideHelper ? await (this as any).hideOverlappingOverlays(page, selector) : await this.localHideOverlappingOverlays(page, selector)
                            if (hid > 0) this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: hid ${hid} overlay(s) covering ${selector}`)
                        } catch {}
                        // retry after hiding overlays
                        await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                        continue
                    }

                    if (['not-found', 'zero-bounding-box'].includes(vis.reason || '')) {
                        return { success: false, reason: vis.reason }
                    }

                    // other transient reasons, retry
                    await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                    continue
                }

                // short popup detection window
                let popupPromise: Promise<Page | null> | null = null
                if (context) {
                    popupPromise = context.waitForEvent('page', { timeout: 1000 }).catch(() => null)
                }
                const navPromise = page.waitForNavigation({ timeout: 1000 }).catch(() => null)

                // try native click first
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

                // restore overlays
                try { if (hasRestoreHelper) await (this as any).restoreHiddenOverlays(page); else await this.localRestoreHiddenOverlays(page) } catch {}

                if (popup) {
                    try { await popup.waitForLoadState('domcontentloaded', { timeout: 120000 }).catch(() => null) } catch {}
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: click opened popup for ${selector}`)
                    return { success: true, popup }
                }

                if (nav) {
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: click caused navigation for ${selector}`)
                    return { success: true }
                }

                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: click success for ${selector} (attempt ${attempt}/${maxAttempts})`)
                return { success: true }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: error on attempt ${attempt}/${maxAttempts} for ${selector}: ${err}`, 'warn')
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                continue
            }
        }

        this.bot.log(this.bot.isMobile, 'URL-REWARD', `clickWithRetries: exhausted ${maxAttempts} attempts for ${selector}`, 'error')
        return { success: false, reason: 'max-retries' }
    }

    async doUrlReward(page: Page) {
        this.bot.log(this.bot.isMobile, 'URL-REWARD', 'Trying to complete UrlReward')

        try {
            await this.bot.utils.wait(2000)

            const tileSelector = '[data-bi-id^="Gamification_DailySet_"] .pointLink:not(.contentContainer .pointLink)'
            const tileExists = await page.waitForSelector(tileSelector, { state: 'visible', timeout: 50000 }).then(() => true).catch(() => false)

            if (tileExists) {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', `Found Gamification_DailySet tile — attempting robust click: ${tileSelector}`)

                const result = await this.clickWithRetries(page, tileSelector, 3, 10000)
                if (!result.success) {
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', `Could not click dailyset tile after retries: ${result.reason}`, 'warn')
                } else if (result.popup) {
                    this.bot.log(this.bot.isMobile, 'URL-REWARD', 'Click opened a popup — switching to popup page to continue flow')
                    page = result.popup
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500))
                } else {
                    // navigation or normal click
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500))
                }
            } else {
                this.bot.log(this.bot.isMobile, 'URL-REWARD', 'No Gamification_DailySet tile found — proceeding with default minimal flow')
            }

            await this.bot.utils.wait(2000)
            try { await page.close() } catch {}

            this.bot.log(this.bot.isMobile, 'URL-REWARD', 'Completed the UrlReward successfully')
        } catch (error) {
            try { await page.close() } catch {}
            this.bot.log(this.bot.isMobile, 'URL-REWARD', 'An error occurred:' + error, 'error')
        }
    }
}
