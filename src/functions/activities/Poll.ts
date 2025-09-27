import { Page } from 'rebrowser-playwright'
import { Workers } from '../Workers'

export class Poll extends Workers {

    async doPoll(page: Page) {
        this.bot.log(this.bot.isMobile, 'POLL', 'Trying to complete poll')

        // Candidate selectors (ordered). Keep btoption behavior but add resilient fallbacks.
        const candidates = [
            '#btoption0', // classic ID style
            '#btoption1',
            'button[id^="btoption"]',
            'input[type="radio"]', // sometimes polls use radios
            '.wk_OptionClickClass', // common option class (used elsewhere)
            '.pollOptions button',
            '.poll-choice, .pollChoice, .pollItem, .option' // generic fallbacks
        ]

        // Bound attempts across selectors to avoid long hangs
        const maxAttempts = 3

        try {
            // short pause for UI to settle
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                this.bot.log(this.bot.isMobile, 'POLL', `Attempt ${attempt}/${maxAttempts} to find a poll option`, 'log')

                // Try each candidate selector until we find clickable options
                for (const sel of candidates) {
                    // quick presence check (short timeout)
                    const present = await page.waitForSelector(sel, { state: 'attached', timeout: 800 }).then(() => true).catch(() => false)
                    if (!present) continue

                    // gather matching elements
                    const handles = await page.$$(sel)
                    if (!handles || handles.length === 0) continue

                    // prefer buttons/inputs that are visible and have size
                    const visibleHandles: any[] = []
                    for (const h of handles) {
                        try {
                            const box = await h.boundingBox()
                            if (!box || box.width === 0 || box.height === 0) continue

                            // check computed style (display/visibility/opacity/hidden attr)
                            // Accept 'any' here to satisfy TS overloads when passing ElementHandle
                            const cs = await page.evaluate((el: any) => {
                                const style = window.getComputedStyle(el as Element)
                                return { display: style.display, visibility: style.visibility, opacity: style.opacity, hidden: (el as Element).hasAttribute && (el as Element).hasAttribute('hidden') }
                            }, h)

                            if (cs.hidden || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) continue

                            visibleHandles.push({ handle: h, box })
                        } catch {
                            continue
                        }
                    }

                    if (visibleHandles.length === 0) continue

                    // pick a random visible option (unless the selector was an explicit id)
                    const pickIndex = (sel.startsWith('#btoption')) ? 0 : this.bot.utils.randomNumber(0, visibleHandles.length - 1)
                    const picked = visibleHandles[pickIndex]
                    if (!picked) continue

                    const h = picked.handle
                    const box = picked.box

                    // ensure scrolled into view
                    try {
                        // some Playwright versions support scrollIntoViewIfNeeded on handle
                        // @ts-ignore
                        if (typeof h.scrollIntoViewIfNeeded === 'function') {
                            // @ts-ignore
                            await h.scrollIntoViewIfNeeded({ timeout: 800 })
                        } else {
                            await page.evaluate((b: { x: number, y: number, width: number, height: number }) => {
                                const elems = document.elementsFromPoint(b.x + b.width / 2, b.y + b.height / 2)
                                if (elems && elems.length) {
                                    const el = elems[0] as HTMLElement
                                    el.scrollIntoView({ block: 'center', inline: 'center' })
                                }
                            }, box)
                        }
                    } catch { /* ignore scroll failures */ }

                    // small human-like micro-wait
                    await this.bot.utils.wait(this.bot.utils.randomNumber(150, 450))

                    // coverage check using elementFromPoint center
                    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
                    const topMatch = await page.evaluate(({ x, y, sel }: { x: number, y: number, sel: string }) => {
                        const top = document.elementFromPoint(x, y)
                        if (!top) return 'none'
                        const target = document.querySelector(sel)
                        if (!target) return 'none'
                        return (top === target || target.contains(top)) ? 'self-or-contained' : 'covered'
                    }, { x: center.x, y: center.y, sel })

                    if (topMatch !== 'self-or-contained') {
                        this.bot.log(this.bot.isMobile, 'POLL', `Option appears covered or not topmost for selector "${sel}" (status=${topMatch}) — attempting to close overlays`, 'warn')
                        await this.tryCloseOverlays(page)
                        await this.bot.utils.wait(this.bot.utils.randomNumber(200, 500))
                        // try next selector / attempt
                        continue
                    }

                    // attempt click (short timeout), fallback to DOM click
                    let clicked = false
                    try {
                        await h.click({ timeout: 4000 })
                        clicked = true
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'POLL', `Native click failed for selector "${sel}" — trying DOM fallback`, 'warn')
                        try {
                            const fallback = await page.evaluate(({ sel, idx }: { sel: string, idx: number }) => {
                                const all = Array.from(document.querySelectorAll(sel))
                                const el = all[idx] as HTMLElement | undefined
                                if (!el) return false
                                el.click()
                                return true
                            }, { sel, idx: pickIndex })
                            clicked = !!fallback
                        } catch (e) {
                            this.bot.log(this.bot.isMobile, 'POLL', `DOM fallback click threw: ${e}`, 'warn')
                        }
                    }

                    if (!clicked) {
                        this.bot.log(this.bot.isMobile, 'POLL', `Click failed for selector "${sel}" — continuing to next candidate`, 'warn')
                        await this.tryCloseOverlays(page)
                        continue
                    }

                    // small human-like delay after click
                    await this.bot.utils.wait(this.bot.utils.randomNumber(800, 2200))

                    // optional: detect if poll moved to results/next step — quick check for common "result" selectors
                    const resultPresent = await page.waitForSelector('.result, .poll-result, .thankyou, .wk_OptionResult', { state: 'attached', timeout: 1000 }).then(() => true).catch(() => false)
                    if (resultPresent) {
                        this.bot.log(this.bot.isMobile, 'POLL', 'Poll appears to have completed (result detected)', 'log')
                    } else {
                        this.bot.log(this.bot.isMobile, 'POLL', 'Clicked poll option — no explicit result detected but continuing', 'log')
                    }

                    // success — close and return
                    try { await page.close() } catch { /* ignore */ }
                    this.bot.log(this.bot.isMobile, 'POLL', 'Completed the poll successfully', 'log')
                    return
                } // end candidate loop

                // nothing clickable in this attempt -> close overlays & retry
                await this.tryCloseOverlays(page)
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
            } // end attempts

            // exhausted attempts
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'POLL', 'Failed to complete poll after max attempts — skipping', 'warn')
        } catch (error) {
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'POLL', 'An error occurred:' + error, 'error')
        }
    }

    /**
     * Best-effort overlay closer used by the poll helper.
     * Conservative list of common selectors — safe to call often.
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
                '.callout .close'
            ]

            for (const sel of overlayCloseSelectors) {
                try {
                    const loc = page.locator(sel).first()
                    if (await loc.count()) {
                        if (await loc.isVisible()) {
                            try { await loc.click({ timeout: 1200 }) } catch { /* ignore */ }
                            await this.bot.utils.wait(120)
                        }
                    }
                } catch { /* ignore individual selector failures */ }
            }

            // safe corner click to dismiss small popovers
            try { await page.mouse.click(6, 6) } catch { /* ignore */ }
        } catch { /* swallow */ }
    }
}
