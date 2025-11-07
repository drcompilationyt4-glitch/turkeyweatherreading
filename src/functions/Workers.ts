import fs from 'fs'
import { Page } from 'rebrowser-playwright'
import { DashboardData, MorePromotion, PromotionalItem, PunchCard } from '../interface/DashboardData'
import { MicrosoftRewardsBot } from '../index'
import JobState from '../util/JobState'
import Retry from '../util/Retry'
import { AdaptiveThrottler } from '../util/AdaptiveThrottler'

interface BaseActivity {
    title: string
    offerId?: string
    name?: string
    complete: boolean
    pointProgressMax: number
    promotionType?: string
    destinationUrl?: string
    exclusiveLockedFeatureStatus?: string
}

export class Workers {
    public bot: MicrosoftRewardsBot
    private jobState: JobState | null

    constructor(bot: MicrosoftRewardsBot) {
        if (!bot) throw new Error('Workers requires a bot instance')
        this.bot = bot

        // Defensive JobState init (it might not exist or fail)
        try {
            this.jobState = new JobState(this.bot.config)
        } catch (err) {
            this.jobState = null
            this.bot?.log?.(this.bot?.isMobile, 'WORKERS', `JobState init failed: ${err instanceof Error ? err.message : err}`, 'warn')
        }

        // bind commonly passed methods to preserve `this` when used as callbacks
        this.doDailySet = this.doDailySet.bind(this)
        this.doPunchCard = this.doPunchCard.bind(this)
        this.doMorePromotions = this.doMorePromotions.bind(this)
        this.solveActivities = this.solveActivities.bind(this)
    }

    /* =========================
       JobState helpers
       ========================= */

    private isJobStateEnabled(): boolean {
        try {
            return !!(this.bot && this.bot.config && this.bot.config.jobState && this.bot.config.jobState.enabled !== false)
        } catch {
            return false
        }
    }

    private jobStateIsDone(email: string, day: string, offerId?: string): boolean {
        if (!offerId) return false
        if (!this.jobState || typeof (this.jobState as any).isDone !== 'function') return false
        try {
            return (this.jobState as any).isDone(email, day, offerId)
        } catch {
            return false
        }
    }

    private jobStateMarkDone(email: string, day: string, offerId?: string) {
        if (!offerId) return
        if (!this.jobState || typeof (this.jobState as any).markDone !== 'function') return
        try {
            ;(this.jobState as any).markDone(email, day, offerId)
        } catch (e) {
            this.bot?.log?.(this.bot?.isMobile, 'WORKERS', `jobState.markDone failed: ${e instanceof Error ? e.message : e}`, 'warn')
        }
    }

    /* =========================
       Selector builders & overlays (advanced)
       ========================= */

    private async buildSelectorsForActivity(page: Page, activity: BaseActivity, punchCard?: PunchCard): Promise<string[]> {
        const candidates: string[] = []

        // If punch card helper available, prefer it first (keeps punch-card behavior)
        if (punchCard) {
            try {
                const derived = await this.bot.browser.func.getPunchCardActivity(page, activity as any)
                if (derived) candidates.push(derived)
            } catch { /* ignore */ }
        }

        // Special-case prefix style selectors used in original working code.
        // This helps catch items that the *= matching missed.
        const name = (activity.name || '').trim()
        if (name) {
            const lname = name.toLowerCase()
            // These names commonly use prefix matching on the site; add ^=
            if (lname.includes('membercenter') || lname.includes('exploreonbing') || lname.includes('searchonbing')) {
                candidates.push(`[data-bi-id^="${name}"] .pointLink:not(.contentContainer .pointLink)`)
                candidates.push(`[data-bi-id^="${name}"]`)
            }
            // generic name-based contains matches
            const nameSafe = name.replace(/"/g, '\\"')
            candidates.push(`[data-bi-id*="${nameSafe}"] .pointLink:not(.contentContainer .pointLink)`)
            candidates.push(`[data-bi-id*="${nameSafe}"]`)
        }

        // offerId candidates (also include prefix ^ for parity with the working code)
        if (activity.offerId) {
            const offer = activity.offerId
            candidates.push(`[data-bi-id^="${offer}"] .pointLink:not(.contentContainer .pointLink)`)
            candidates.push(`[data-bi-id^="${offer}"]`)
            candidates.push(`[data-bi-id*="${offer}"] .pointLink:not(.contentContainer .pointLink)`)
            candidates.push(`[data-bi-id*="${offer}"]`)
            const esc = (activity.offerId || '').replace(/"/g, '\\"')
            candidates.push(`[data-bi-id*="${esc}"] .pointLink:not(.contentContainer .pointLink)`)
            candidates.push(`[data-bi-id*="${esc}"]`)
        }

        // destination URL - sometimes the card contains an <a href> that is clickable
        if (activity.destinationUrl) {
            try {
                const urlSafe = (activity.destinationUrl || '').replace(/"/g, '\\"')
                candidates.push(`a[href*="${urlSafe}"]`)
                try {
                    const u = new URL(activity.destinationUrl)
                    const hostFrag = u.hostname
                    if (hostFrag) candidates.push(`a[href*="${hostFrag}"]`)
                } catch { /* ignore */ }
            } catch { /* ignore */ }
        }

        // try matching by visible title text by scanning DOM (expensive but effective)
        if (activity.title) {
            try {
                const title = activity.title
                const derived = await page.evaluate((t) => {
                    const out: string[] = []
                    const text = t.trim().toLowerCase()
                    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-bi-id], a, button')) as HTMLElement[]
                    const seen = new Set<string>()
                    for (const el of candidates) {
                        try {
                            if (!el.innerText) continue
                            if (el.innerText.toLowerCase().includes(text)) {
                                let anc: HTMLElement | null = el
                                while (anc && anc !== document.body) {
                                    if (anc.hasAttribute && anc.hasAttribute('data-bi-id')) {
                                        const id = anc.getAttribute('data-bi-id') || ''
                                        const esc = id.replace(/"/g, '\\"')
                                        const sel = `[data-bi-id*="${esc}"] .pointLink:not(.contentContainer .pointLink), [data-bi-id*="${esc}"]`
                                        if (!seen.has(sel)) { seen.add(sel); out.push(sel) }
                                        break
                                    }
                                    anc = anc.parentElement
                                }
                                if (el.tagName.toLowerCase() === 'a') {
                                    const href = (el as HTMLAnchorElement).href || ''
                                    if (href) {
                                        const sel = `a[href*="${href}"]`
                                        if (!seen.has(sel)) { seen.add(sel); out.push(sel) }
                                    }
                                }
                            }
                        } catch { /* skip element */ }
                    }
                    return out
                }, title)
                for (const s of derived) {
                    if (!candidates.includes(s)) candidates.push(s)
                }
            } catch {
                // ignore DOM inspection failure
            }
        }

        // generic fallbacks
        candidates.push('.pointLink:not(.contentContainer .pointLink)')
        candidates.push('.pointLink')
        candidates.push('a:not(.contentContainer a)')
        candidates.push('[data-bi-id] .pointLink:not(.contentContainer .pointLink)')
        candidates.push('[data-bi-id]')

        return Array.from(new Set(candidates)).filter(Boolean)
    }

    protected async hideOverlappingOverlays(page: Page, selector: string): Promise<number> {
        try {
            return await page.evaluate((sel) => {
                const target = document.querySelector(sel) as HTMLElement | null
                if (!target) return 0
                const tBox = target.getBoundingClientRect()
                if (!tBox) return 0
                const all = Array.from(document.querySelectorAll('body *')) as HTMLElement[]
                let hidden = 0
                for (const el of all) {
                    try {
                        if (el === target) continue
                        const style = window.getComputedStyle(el)
                        if (!style) continue
                        if (style.display === 'none' || parseFloat(style.opacity || '1') === 0) continue
                        const pos = style.position
                        const zIndex = parseInt(style.zIndex || '0') || 0
                        if (!(pos === 'fixed' || pos === 'absolute' || pos === 'sticky' || zIndex > 0)) continue
                        const r = el.getBoundingClientRect()
                        if (!r || r.width === 0 || r.height === 0) continue
                        const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom)
                        if (!overlap) continue
                        el.setAttribute('data-qa-hidden-temp', 'true')
                        el.style.setProperty('display', 'none', 'important')
                        hidden++
                    } catch { /* ignore per-element errors */ }
                }
                return hidden
            }, selector)
        } catch {
            return 0
        }
    }

    protected async restoreHiddenOverlays(page: Page): Promise<number> {
        try {
            return await page.evaluate(() => {
                const hidden = Array.from(document.querySelectorAll('[data-qa-hidden-temp]')) as HTMLElement[]
                for (const el of hidden) {
                    try {
                        el.removeAttribute('data-qa-hidden-temp')
                        el.style.removeProperty('display')
                    } catch { /* ignore per-element */ }
                }
                return hidden.length
            })
        } catch {
            return 0
        }
    }

    /* =========================
       Humanization helpers
       ========================= */

    private async humanMouseMove(page: Page, selector: string): Promise<void> {
        try {
            const handle = await page.$(selector)
            if (!handle) return
            const box = await handle.boundingBox()
            if (!box) return

            const viewport = page.viewportSize() || { width: 1280, height: 720 }
            const startX = Math.random() * viewport.width
            const startY = Math.random() * viewport.height

            const targetX = box.x + box.width / 2 + (Math.random() * 10 - 5)
            const targetY = box.y + box.height / 2 + (Math.random() * 10 - 5)

            const control1X = startX + (targetX - startX) * (0.3 + Math.random() * 0.4)
            const control1Y = startY + (targetY - startY) * (0.3 + Math.random() * 0.4)
            const control2X = startX + (targetX - startX) * (0.6 + Math.random() * 0.4)
            const control2Y = startY + (targetY - startY) * (0.6 + Math.random() * 0.4)

            const steps = Math.floor(20 + Math.random() * 20)
            const duration = 300 + Math.random() * 700
            const stepTime = duration / steps

            await page.mouse.move(startX, startY)
            for (let i = 1; i <= steps; i++) {
                const t = i / steps
                const x = (1 - t) ** 3 * startX + 3 * (1 - t) ** 2 * t * control1X + 3 * (1 - t) * t ** 2 * control2X + t ** 3 * targetX
                const y = (1 - t) ** 3 * startY + 3 * (1 - t) ** 2 * t * control1Y + 3 * (1 - t) * t ** 2 * control2Y + t ** 3 * targetY
                await page.mouse.move(x, y)
                await this.bot.utils.wait(stepTime * (0.8 + Math.random() * 0.4))
            }
        } catch {
            await page.mouse.move(0, 0).catch(() => {})
        }
    }

    private async humanHover(page: Page, selector: string): Promise<void> {
        await this.humanMouseMove(page, selector)
        const hoverTime = 200 + Math.random() * 800
        await this.bot.utils.wait(hoverTime)

        const box = await (await page.$(selector))?.boundingBox()
        if (box) {
            for (let i = 0; i < 3; i++) {
                const offsetX = Math.random() * 4 - 2
                const offsetY = Math.random() * 4 - 2
                await page.mouse.move(box.x + box.width / 2 + offsetX, box.y + box.height / 2 + offsetY)
                await this.bot.utils.wait(50 + Math.random() * 100)
            }
        }
    }

    private async humanScroll(page: Page): Promise<void> {
        try {
            const viewportHeight = (page.viewportSize()?.height || 720) / 2
            const scrollAmount = viewportHeight * (0.5 + Math.random() * 0.5)
            const direction = Math.random() > 0.5 ? 1 : -1
            await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount * direction)
            await this.bot.utils.wait(300 + Math.random() * 700)
            if (Math.random() < 0.3) {
                await page.evaluate((amount) => window.scrollBy(0, amount), -scrollAmount * direction * 0.2)
                await this.bot.utils.wait(100 + Math.random() * 200)
            }
        } catch { /* ignore */ }
    }

    /* =========================
       Visibility & scroll helpers
       ========================= */

    private async ensureSelectorVisible(page: Page, selector: string, maxTries = 4): Promise<void> {
        for (let attempt = 1; attempt <= maxTries; attempt++) {
            try {
                const found = await page.$(selector)
                if (found) {
                    await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (!el) return
                        function findScrollParent(node: HTMLElement | null): HTMLElement | null {
                            while (node && node !== document.body) {
                                const style = window.getComputedStyle(node)
                                const overflowY = style.overflowY || ''
                                if (/(auto|scroll|overlay)/i.test(overflowY) && node.scrollHeight > node.clientHeight) return node
                                node = node.parentElement
                            }
                            return document.scrollingElement as HTMLElement
                        }
                        const sp = findScrollParent(el.parentElement)
                        if (sp) {
                            const elRect = el.getBoundingClientRect()
                            const spRect = sp.getBoundingClientRect()
                            const offset = (elRect.top - spRect.top) - (spRect.height / 2) + (elRect.height / 2)
                            sp.scrollBy({ top: offset, behavior: 'auto' })
                        }
                        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' })
                    }, selector).catch(() => {})
                    await this.bot.utils.waitRandom(200, 600)

                    const box = await (await page.$(selector))?.boundingBox()
                    const style = await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (!el) return null
                        const cs = window.getComputedStyle(el)
                        return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, hidden: el.hasAttribute('hidden') }
                    }, selector)
                    if (box && box.height > 0 && box.width > 0 && style && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0) {
                        await this.bot.utils.waitRandom(150, 400)
                        return
                    }
                }

                const viewport = page.viewportSize() || { width: 1280, height: 720 }
                const step = Math.max(200, Math.floor(viewport.height * 0.6))
                await page.evaluate((s) => window.scrollBy(0, s), step).catch(() => {})
                await this.bot.utils.waitRandom(300, 900)

                if (attempt === maxTries - 1) {
                    await page.reload({ timeout: 30000 }).catch(() => {})
                    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
                    await this.bot.utils.waitRandom(800, 1400)
                }
            } catch {
                // swallow and retry
            }
        }
        this.bot.log(this.bot.isMobile, 'ACTIVITY', `ensureSelectorVisible: selector "${selector}" not visible after ${maxTries} tries`, 'log')
    }

    private async findAndScrollToSelector(page: Page, selector: string, maxSteps = 20): Promise<boolean> {
        try {
            let count = await page.locator(selector).count().catch(() => 0)
            if (count > 0) {
                await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {})
                return true
            }

            const viewport = page.viewportSize() || { width: 1280, height: 720 }
            const step = Math.max(200, Math.floor(viewport.height * 0.6))
            let prevScroll = -1
            for (let i = 0; i < maxSteps; i++) {
                await page.evaluate((s) => window.scrollBy(0, s), step).catch(() => {})
                await this.bot.utils.waitRandom(250, 700)
                count = await page.locator(selector).count().catch(() => 0)
                if (count > 0) {
                    await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {})
                    await this.bot.utils.waitRandom(200, 500)
                    return true
                }
                const pos = await page.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight } ))
                if (pos && typeof pos.y === 'number' && typeof pos.max === 'number' && pos.y >= pos.max - 2) break
                if (i % 3 === 2) {
                    await page.evaluate((s) => window.scrollBy(0, -Math.floor(s / 4)), step).catch(() => {})
                    await this.bot.utils.waitRandom(150, 400)
                }
                const curr = await page.evaluate(() => window.scrollY).catch(() => 0)
                if (curr === prevScroll) break
                prevScroll = curr
            }

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
            await this.bot.utils.waitRandom(500, 900)
            const finalCount = await page.locator(selector).count().catch(() => 0)
            if (finalCount > 0) {
                await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {})
                await this.bot.utils.waitRandom(200, 500)
                return true
            }
        } catch {
            // ignore
        }
        return false
    }

    /* =========================
       Robust click helper (used by solveActivities)
       ========================= */

    private async robustTryClickSelector(page: Page, selector: string, maxAttempts = 2, perAttemptTimeout = 10000): Promise<{ success: boolean; reason?: string; popup?: Page }> {
        const context = page.context ? page.context() : null

        const tryOnce = async (sel: string, timeout: number): Promise<{ success: boolean; reason?: string; popup?: Page }> => {
            await this.bot.utils.waitRandom(300, 900)

            // ensure selector is present/visible - try to find and scroll to it first
            try { await this.findAndScrollToSelector(page, sel, 12) } catch { /* continue */ }
            try { await page.waitForSelector(sel, { state: 'attached', timeout: Math.min(2000, timeout) + Math.random() * 500 }).catch(() => {}) } catch { /* continue */ }

            try {
                const handle = await page.$(sel)
                if (!handle) return { success: false, reason: 'not-found' }

                // ensure visible by scrolling container/window
                await this.ensureSelectorVisible(page, sel)
                await this.bot.utils.waitRandom(200, 500)

                const box = await handle.boundingBox()
                const style = await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null
                    if (!el) return { display: 'none', visibility: 'hidden', opacity: '0', hidden: true }
                    const cs = window.getComputedStyle(el)
                    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, hidden: el.hasAttribute('hidden') }
                }, sel)

                if (!box || box.width === 0 || box.height === 0) return { success: false, reason: 'zero-bounding-box' }
                if (style.hidden || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.01) {
                    let hid = 0
                    for (let i = 0; i < 2; i++) {
                        hid = await this.hideOverlappingOverlays(page, sel)
                        if (hid > 0) break
                        await this.bot.utils.waitRandom(300, 700)
                    }
                    if (hid === 0) return { success: false, reason: 'css-hidden' }
                }
            } catch {
                // ignore visibility-check errors
            }

            await this.humanHover(page, sel)

            let popupPromise: Promise<Page | null> | null = null
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1200 + Math.random() * 800 }).catch(() => null)
            }
            const navPromise = page.waitForNavigation({ timeout: 1200 + Math.random() * 800 }).catch(() => null)

            let clickedOk = false
            try {
                const locator = page.locator(sel).first()
                await locator.scrollIntoViewIfNeeded?.({ timeout: 1200 + Math.random() * 400 }).catch(() => null)
                await locator.click({ timeout, position: { x: Math.random() * 10 - 5, y: Math.random() * 10 - 5 } }).then(() => {
                    clickedOk = true
                }).catch(() => null)

                if (!clickedOk) {
                    const evalClicked = await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (!el) return false
                        el.click()
                        return true
                    }, sel).catch(() => false)

                    if (evalClicked) clickedOk = true
                    else {
                        const h = await page.$(sel)
                        if (h) {
                            const b = await h.boundingBox()
                            if (b) {
                                const offsetX = Math.random() * b.width * 0.8 + b.width * 0.1
                                const offsetY = Math.random() * b.height * 0.8 + b.height * 0.1
                                await page.mouse.click(b.x + offsetX, b.y + offsetY).catch(() => null)
                                clickedOk = true
                            }
                        }
                    }
                }
            } catch {
                // swallow
            }

            if (!clickedOk) {
                try {
                    const locator = page.locator(selector).first()
                    await locator.click({ timeout: perAttemptTimeout, force: true, position: { x: Math.random() * 10 - 5, y: Math.random() * 10 - 5 } }).then(() => {
                        clickedOk = true
                    }).catch(() => null)
                } catch {
                    // final fail
                }
            }

            await this.bot.utils.waitRandom(200, 600)
            try { await this.restoreHiddenOverlays(page) } catch { /* ignore */ }

            if (!clickedOk) {
                try {
                    await page.screenshot({ path: `debug_click_failed_${Date.now()}.png`, fullPage: false }).catch(() => {})
                    const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
                    fs.writeFileSync(`debug_page_${Date.now()}.html`, html)
                } catch { /* ignore */ }
                return { success: false, reason: 'click-failed' }
            }

            await this.bot.utils.waitRandom(400, 1000)
            const popup = popupPromise ? await popupPromise : null
            const nav = await navPromise

            if (popup) {
                try { await popup.waitForLoadState('domcontentloaded', { timeout: 10000 + Math.random() * 2000 }) } catch {}
                return { success: true, popup }
            }

            if (nav) return { success: true }
            return { success: true }
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await tryOnce(selector, perAttemptTimeout)
            if (result.success) return result
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800) * (1 + attempt * 0.4))
        }

        try {
            const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
            fs.writeFileSync(`debug_page_final_${Date.now()}.html`, html)
        } catch { /* ignore */ }

        return { success: false, reason: 'max-retries' }
    }

    /* =========================
       Bounded re-run helper (2 passes)
       ========================= */

    private async tryCompleteAll(page: Page, activities: BaseActivity[], punchCard?: PunchCard): Promise<{ completedOfferIds: string[]; remainingActivities: BaseActivity[] }> {
        const maxPasses = 2
        const giveUp = false
        let remaining = [...activities]
        const completedSet = new Set<string>()

        for (let pass = 1; pass <= maxPasses && remaining.length > 0; pass++) {
            this.bot.log(this.bot.isMobile, 'WORKERS', `Attempt pass ${pass} to complete ${remaining.length} remaining activities`, 'log')
            const completedThisPass = await this.solveActivities(page, remaining as any, punchCard)
            for (const id of completedThisPass) completedSet.add(id)
            remaining = remaining.filter(a => !(a.offerId && completedSet.has(a.offerId)))
            if (remaining.length > 0 && pass < maxPasses) {
                await this.bot.utils.waitRandom(800, 1800)
            }
        }

        const completedOfferIds = Array.from(completedSet)

        if (remaining.length > 0) {
            this.bot.log(this.bot.isMobile, 'WORKERS',
                `After ${maxPasses} passes, ${remaining.length} activities remain: ${remaining.map(r => r.offerId || r.title).join(', ')}`, 'warn')

            if (giveUp && this.isJobStateEnabled()) {
                const email = this.bot.currentAccountEmail || 'unknown'
                const today = this.bot.utils.getFormattedDate()
                for (const a of remaining) {
                    if (a.offerId) {
                        this.jobStateMarkDone(email, today, a.offerId)
                        this.bot.log(this.bot.isMobile, 'WORKERS', `Giving up and marking offerId done (giveUp=true): ${a.offerId}`, 'warn')
                    }
                }
                remaining = []
            }
        }

        return { completedOfferIds, remainingActivities: remaining }
    }

    /* =========================
       Public flows (merged & robust)
       ========================= */

    async doDailySet(page: Page, data: DashboardData, maxActivities?: number) {
        const today = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[today] ?? []

        const activitiesUncompleted = (todayData?.filter(x => !x.complete && x.pointProgressMax > 0) ?? []).filter(x => {
            if (!this.isJobStateEnabled()) return true
            const email = this.bot.currentAccountEmail || 'unknown'
            return !this.jobStateIsDone(email, today, x.offerId)
        })

        if (!activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'DAILY-SET', 'All Daily Set items have already been completed')
            return
        }

        this.bot.log(this.bot.isMobile, 'DAILY-SET',
            `Started solving "Daily Set" items${maxActivities ? ` (max ${maxActivities} this run)` : ''}`)

        const activitiesToProcess = maxActivities ? activitiesUncompleted.slice(0, maxActivities) : activitiesUncompleted

        const { completedOfferIds, remainingActivities } = await this.tryCompleteAll(page, activitiesToProcess, undefined)
        this.bot.log(this.bot.isMobile, 'WORKERS', `remainingActivities: ${remainingActivities.map(a => a.title).join(', ')}`, 'log')

        if (this.isJobStateEnabled() && !maxActivities && completedOfferIds.length) {
            const email = this.bot.currentAccountEmail || 'unknown'
            for (const offerId of completedOfferIds) {
                this.jobStateMarkDone(email, today, offerId)
                this.bot.log(this.bot.isMobile, 'WORKERS', `Marked DailySet offerId done: ${offerId}`, 'log')
            }
        }

        page = await this.bot.browser.utils.getLatestTab(page)
        await this.bot.browser.func.goHome(page)

        if (maxActivities && activitiesToProcess.length < activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'DAILY-SET',
                `Completed ${activitiesToProcess.length} Daily Set items this iteration (${activitiesUncompleted.length - activitiesToProcess.length} remaining)`)
        } else {
            this.bot.log(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed (or remaining were left after 2 passes)')
        }

        if (!this.bot.isMobile && this.bot.config.workers?.bundleDailySetWithSearch &&
            this.bot.config.workers?.doDesktopSearch && !maxActivities) {
            try {
                await this.bot.utils.waitRandom(1200, 2600)
                await this.bot.activities.doSearch(page, data)
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'DAILY-SET', `Post-DailySet search failed: ${e instanceof Error ? e.message : e}`, 'warn')
            }
        }
    }

    async doPunchCard(page: Page, data: DashboardData, maxActivities?: number) {
        const punchCardsUncompleted = data.punchCards?.filter(x => x.parentPromotion && !x.parentPromotion.complete) ?? []
        if (!punchCardsUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', 'All "Punch Cards" have already been completed')
            return
        }

        let totalProcessed = 0
        const maxCardsToProcess = maxActivities ? Math.min(maxActivities, punchCardsUncompleted.length) : punchCardsUncompleted.length

        for (const punchCard of punchCardsUncompleted.slice(0, maxCardsToProcess)) {
            if (!punchCard.parentPromotion?.title) {
                this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `Skipped punchcard "${punchCard.name}" | Reason: Parent promotion is missing!`, 'warn')
                continue
            }

            page = await this.bot.browser.utils.getLatestTab(page)
            const activitiesUncompleted = punchCard.childPromotions.filter(x => !x.complete)
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD',
                `Started solving "Punch Card" items for punchcard: "${punchCard.parentPromotion.title}"`)

            await page.goto(punchCard.parentPromotion.destinationUrl, { referer: this.bot.config.baseURL, timeout: 120000 + Math.random() * 20000 })
            await page.waitForLoadState('networkidle', { timeout: 5000 + Math.random() * 3000 }).catch(() => {})

            const { completedOfferIds, remainingActivities } = await this.tryCompleteAll(page, activitiesUncompleted, punchCard)

            if (this.isJobStateEnabled() && !maxActivities && completedOfferIds.length) {
                const email = this.bot.currentAccountEmail || 'unknown'
                const today = this.bot.utils.getFormattedDate()
                for (const offerId of completedOfferIds) {
                    this.jobStateMarkDone(email, today, offerId)
                    this.bot.log(this.bot.isMobile, 'WORKERS', `Marked PunchCard offerId done: ${offerId}`, 'log')
                }
            }

            page = await this.bot.browser.utils.getLatestTab(page)
            const pages = page.context().pages()
            if (pages.length > 3) {
                await page.close()
            } else {
                await this.bot.browser.func.goHome(page)
            }

            this.bot.log(this.bot.isMobile, 'PUNCH-CARD',
                `Completed items for punchcard: "${punchCard.parentPromotion.title}" (completed ${completedOfferIds.length}, remaining ${remainingActivities.length})`)
            totalProcessed++
            if (maxActivities && totalProcessed >= maxActivities) break
        }

        if (maxActivities && totalProcessed < punchCardsUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD',
                `Completed ${totalProcessed} punch cards this iteration (${punchCardsUncompleted.length - totalProcessed} remaining)`)
        } else {
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', 'All "Punch Card" items have been completed (or left after 2 passes)')
        }
    }

    async doMorePromotions(page: Page, data: DashboardData, maxActivities?: number) {
        const morePromotions = data.morePromotions ?? []
        if (data.promotionalItem) morePromotions.push(data.promotionalItem as unknown as MorePromotion)

        const activitiesUncompleted = morePromotions
            ?.filter(x => !x.complete && x.pointProgressMax > 0 && x.exclusiveLockedFeatureStatus !== 'locked')
            ?.map(x => ({ ...x, title: x.title || 'Untitled', offerId: x.offerId, name: x.name, complete: x.complete, pointProgressMax: x.pointProgressMax })) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have already been completed')
            return
        }

        this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS',
            `Started solving "More Promotions" items${maxActivities ? ` (max ${maxActivities} this run)` : ''}`)

        const activitiesToProcess = maxActivities ? activitiesUncompleted.slice(0, maxActivities) : activitiesUncompleted

        page = await this.bot.browser.utils.getLatestTab(page)
        const { completedOfferIds, remainingActivities } = await this.tryCompleteAll(page, activitiesToProcess, undefined)
        page = await this.bot.browser.utils.getLatestTab(page)
        await this.bot.browser.func.goHome(page)

        if (this.isJobStateEnabled() && !maxActivities && completedOfferIds.length) {
            const email = this.bot.currentAccountEmail || 'unknown'
            const today = this.bot.utils.getFormattedDate()
            for (const offerId of completedOfferIds) {
                this.jobStateMarkDone(email, today, offerId)
                this.bot.log(this.bot.isMobile, 'WORKERS', `Marked MorePromotions offerId done: ${offerId}`, 'log')
            }
        }

        if (remainingActivities.length > 0) {
            this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS',
                `After 2 passes ${remainingActivities.length} MorePromotion items remain: ${remainingActivities.map(r => r.offerId || r.title).join(', ')}`, 'warn')
        }

        if (maxActivities && activitiesToProcess.length < activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS',
                `Completed ${activitiesToProcess.length} More Promotion items this iteration (${activitiesUncompleted.length - activitiesToProcess.length} remaining)`)
        } else {
            this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed (or left after 2 passes)')
        }
    }

    /**
     * solveActivities returns an array of offerIds that actually completed successfully.
     * This is the merged, robust implementation.
     */
    public async solveActivities(activityPage: Page, activities: BaseActivity[] | PromotionalItem[] | MorePromotion[], punchCard?: PunchCard, maxActivities?: number): Promise<string[]> {
        const activityInitial = activityPage.url()
        const throttle = new AdaptiveThrottler()

        let activitiesToProcess = [...activities].sort(() => Math.random() - 0.5)
        if (maxActivities && maxActivities > 0) {
            activitiesToProcess = activitiesToProcess.slice(0, maxActivities)
            this.bot.log(this.bot.isMobile, 'ACTIVITY', `Processing ${activitiesToProcess.length} of ${activities.length} activities this iteration`)
        }

        let processedCount = 0
        const completedOfferIds: string[] = []

        for (const activity of activitiesToProcess) {
            processedCount++
            try {
                // Use centralized tab lifecycle management (main branch style)
                activityPage = await this.manageTabLifecycle(activityPage, activityInitial)

                // Humanize + initial throttle (main branch style)
                await this.bot.browser.utils.humanizePage(activityPage)
                await this.applyThrottle(throttle, 700, 1300)

                // occasional small scrolls
                for (let i = 0; i < Math.floor(1 + Math.random() * 2); i++) {
                    await this.humanScroll(activityPage)
                    await this.bot.utils.waitRandom(400, 1200)
                }

                // Build selectors (use punchCard helper if provided)
                let selectors: string[] = []
                if (punchCard) {
                    try {
                        const derived = await this.bot.browser.func.getPunchCardActivity(activityPage, activity as PromotionalItem)
                        if (derived) selectors.push(derived)
                    } catch { /* ignore */ }
                }

                const built = await this.buildSelectorsForActivity(activityPage, activity as BaseActivity, punchCard)
                selectors = selectors.concat(built)
                selectors = Array.from(new Set(selectors)).filter(Boolean)

                await activityPage.waitForLoadState('networkidle', { timeout: 5000 + Math.random() * 2000 }).catch(() => {})
                await this.bot.utils.waitRandom(800, 1600)

                for (const sel of selectors) {
                    try {
                        const count = await activityPage.locator(sel).count().catch(() => 0)
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Selector "${sel}" matches ${count} elements`, 'log')
                    } catch {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Selector "${sel}" count failed`, 'log')
                    }
                }

                let clickedResult: { success: boolean; reason?: string; popup?: Page } | null = null
                const maxCandidatesToTry = 6
                let candidateCount = 0

                for (const sel of selectors) {
                    if (candidateCount >= maxCandidatesToTry) break
                    candidateCount++

                    const found = await this.findAndScrollToSelector(activityPage, sel, 18)
                    if (!found) {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Selector "${sel}" not found after scrolling`, 'log')
                    }

                    await this.humanHover(activityPage, sel)

                    const res = await this.robustTryClickSelector(activityPage, sel, 2, 10000)
                    if (res.success) {
                        clickedResult = res
                        break
                    } else {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Could not click selector "${sel}" for "${(activity as any).title}" | reason: ${res.reason}`, 'warn')

                        try {
                            if (sel.includes('.pointLink') || sel.includes('[data-bi-id')) {
                                const containerSelMatch = sel.match(/^\s*([^\s\.]+?\[data-bi-id[^\]]+\][^\s]*)/i)
                                let containerSel = ''
                                if (containerSelMatch && containerSelMatch[1]) containerSel = containerSelMatch[1]
                                if (!containerSel && sel.includes('.pointLink')) {
                                    containerSel = sel.replace(/\.pointLink.*/, '')
                                }
                                if (containerSel && containerSel !== sel) {
                                    await this.findAndScrollToSelector(activityPage, containerSel, 12)
                                    await this.humanHover(activityPage, containerSel)
                                    const res2 = await this.robustTryClickSelector(activityPage, containerSel, 2, 10000)
                                    if (res2.success) {
                                        clickedResult = res2
                                        break
                                    } else {
                                        this.bot.log(this.bot.isMobile, 'ACTIVITY',
                                            `Fallback container click also failed "${containerSel}" for "${(activity as any).title}" | reason: ${res2.reason}`, 'warn')
                                    }
                                }
                            }
                        } catch { /* ignore fallback errors */ }
                    }
                }

                if (!clickedResult || !clickedResult.success) {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY',
                        `Skipped activity "${(activity as any).title}" | Reason: Could not click any selectors (tried ${candidateCount})`, 'warn')
                    await this.bot.utils.wait(400 + Math.random() * 400)
                    throttle.record(false)
                    continue
                }

                if (clickedResult.popup) {
                    activityPage = clickedResult.popup
                    await this.bot.utils.wait(this.bot.utils.randomNumber(900, 2000) + Math.random() * 800)
                } else {
                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage)
                    await this.bot.utils.wait(800 + Math.random() * 900)
                }

                await this.bot.utils.waitRandom(700, 1600)
                if (Math.random() < 0.7) await this.humanScroll(activityPage)

                const typeLabel = this.bot.activities?.getTypeLabel ? this.bot.activities.getTypeLabel(activity as PromotionalItem | MorePromotion) : (activity as any).promotionType || 'unknown'

                if (typeLabel !== 'Unsupported') {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY',
                        `Processing activity ${processedCount}/${activitiesToProcess.length}: "${typeLabel}" - "${(activity as any).title}"`)

                    const retry = new Retry(this.bot.config.retryPolicy)
                    let succeeded = false

                    for (let attempt = 1; attempt <= 2 && !succeeded; attempt++) {
                        try {
                            const timeoutMs = this.bot.utils.stringToMs(this.bot.config?.globalTimeout ?? '30s') * 2 + Math.random() * 8000
                            const runWithTimeout = (p: Promise<void>) => Promise.race([
                                p,
                                new Promise<void>((_, rej) => setTimeout(() => rej(new Error('activity-timeout')), timeoutMs))
                            ])

                            await retry.run(async () => {
                                try {
                                    // Use dedicated handler that implements all promotion types (quiz variants, urlreward/search, etc.)
                                    await runWithTimeout(this.runActivityByType(activityPage, activity as PromotionalItem | MorePromotion))
                                    throttle.record(true)
                                } catch (e) {
                                    await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_timeout_${(activity as any).title || (activity as any).offerId || 'unknown'}`)
                                    throttle.record(false)
                                    throw e
                                }
                            }, () => true)

                            succeeded = true
                        } catch (e) {
                            await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_error_${(activity as any).title || (activity as any).offerId || 'unknown'}`)
                            throttle.record(false)
                            if (attempt < 2) {
                                await this.bot.utils.waitRandom(500, 1200)
                            } else {
                                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Activity "${(activity as any).title}" failed after 2 attempts: ${e instanceof Error ? e.message : e}`, 'error')
                            }
                        }
                    }

                    if (succeeded && (activity as any).offerId) completedOfferIds.push((activity as any).offerId)
                } else {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY',
                        `Skipped activity "${(activity as any).title}" | Reason: Unsupported type: "${(activity as any).promotionType}"!`, 'warn')
                }

                // humanize and a stable throttle pause (use helper)
                await this.bot.browser.utils.humanizePage(activityPage)
                await this.applyThrottle(throttle, 1000, 2000)

                if (Math.random() < 0.4) await this.humanHover(activityPage, 'body')
            } catch (error) {
                await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_error_${(activity as any).title || (activity as any).offerId || 'unknown'}`)
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `An error occurred: ${error}`, 'error')
            }
        }

        this.bot.log(this.bot.isMobile, 'ACTIVITY',
            `Completed processing ${processedCount} activities this iteration`)

        return completedOfferIds
    }

    /* =========================
       Helpful small flow helpers (from main branch)
       ========================= */

    private async manageTabLifecycle(page: Page, initialUrl: string): Promise<Page> {
        page = await this.bot.browser.utils.getLatestTab(page)

        const pages = page.context().pages()
        if (pages.length > 3) {
            await page.close()
            page = await this.bot.browser.utils.getLatestTab(page)
        }

        if (page.url() !== initialUrl) {
            try {
                await page.goto(initialUrl, { timeout: 30000 }).catch(() => {})
            } catch { /* ignore */ }
        }

        return page
    }

    private async applyThrottle(throttle: AdaptiveThrottler, min: number, max: number): Promise<void> {
        const multiplier = throttle.getDelayMultiplier()
        await this.bot.utils.waitRandom(Math.floor(min * multiplier), Math.floor(max * multiplier))
    }

    /**
     * Run an activity by inspecting its promotionType/pointProgressMax/name/destinationUrl
     * and calling the appropriate handler on this.bot.activities. This preserves the
     * semantics of your reference implementation but keeps the robust interleaving/retry logic.
     */
    private async runActivityByType(page: Page, activity: PromotionalItem | MorePromotion | any): Promise<void> {
        // Some defensive normalization
        const promotionType = (activity.promotionType || '').toLowerCase()
        const name = (activity.name || '').toLowerCase()
        const dest = (activity.destinationUrl || '').toLowerCase()
        const points = Number(activity.pointProgressMax || 0)

        // IMPORTANT: At this point the click that opened the activity has already happened
        // in solveActivities; activity `page` should already be the new tab or navigated tab.

        switch (promotionType) {
            case 'quiz':
                // Distinguish quiz subtypes by points or destinationUrl
                if (points === 10) {
                    // Poll vs ABC
                    if (dest.includes('pollscenarioid')) {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "Poll" title: "${activity.title}"`)
                        await this.bot.activities.doPoll(page)
                    } else {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "ABC" title: "${activity.title}"`)
                        await this.bot.activities.doABC(page)
                    }
                } else if (points === 50) {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "ThisOrThat" title: "${activity.title}"`)
                    await this.bot.activities.doThisOrThat(page)
                } else {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "Quiz" title: "${activity.title}"`)
                    await this.bot.activities.doQuiz(page)
                }
                break

            case 'urlreward':
            case 'url_reward':
            case 'visit':
                // SearchOnBing is often a subtype of urlreward
                if (name.includes('exploreonbing') || name.includes('searchonbing') || dest.includes('searchonbing')) {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "SearchOnBing" title: "${activity.title}"`)
                    await this.bot.activities.doSearchOnBing(page, activity)
                } else {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "UrlReward" title: "${activity.title}"`)
                    await this.bot.activities.doUrlReward(page)
                }
                break

            // If your system uses other promotionType values, handle them here:
            case 'poll':
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "Poll" (explicit) title: "${activity.title}"`)
                await this.bot.activities.doPoll(page)
                break

            case 'abc':
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "ABC" (explicit) title: "${activity.title}"`)
                await this.bot.activities.doABC(page)
                break

            case 'thisorthat':
            case 'this-or-that':
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "ThisOrThat" (explicit) title: "${activity.title}"`)
                await this.bot.activities.doThisOrThat(page)
                break

            case 'search':
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "Search" title: "${activity.title}"`)
                await this.bot.activities.doSearchOnBing(page, activity)
                break

            // Add any other explicit known types here...

            default:
                // Fallback: if activities.run exists, prefer that generic handler
                if (typeof this.bot.activities.run === 'function') {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Falling back to generic activity runner for title: "${activity.title}" (type: "${promotionType}")`)
                    await this.bot.activities.run(page, activity)
                } else {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `No handler for activity "${activity.title}" (type: "${promotionType}")`, 'warn')
                }
                break
        }

        // Small cooldown to allow navigation or points to register
        await this.bot.utils.waitRandom(400, 900)
    }
}
