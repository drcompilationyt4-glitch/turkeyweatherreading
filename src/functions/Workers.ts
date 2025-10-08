// src/Workers.ts
import { Page } from 'rebrowser-playwright'

import { DashboardData, MorePromotion, PromotionalItem, PunchCard } from '../interface/DashboardData'
import { MicrosoftRewardsBot } from '../index'
import JobState from '../util/JobState'
import Retry from '../util/Retry'
import { AdaptiveThrottler } from '../util/AdaptiveThrottler'

export class Workers {
    public bot: MicrosoftRewardsBot
    private jobState: JobState

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.jobState = new JobState(this.bot.config)
    }

    /* =========================
       Utility helpers
       ========================= */

    /**
     * Return candidate selectors for an activity.
     * Tries:
     *  - [data-bi-id^="offerId"] .pointLink:not(.contentContainer .pointLink)
     *  - [data-bi-id*="namePart"] .pointLink...
     *  - any .pointLink whose ancestor data-bi-id looks like daily/gamification/global
     *  - .pointLink with nearby text/title matching activity.title
     */
    private async buildSelectorsForActivity(page: Page, activity: PromotionalItem | MorePromotion, punchCard?: PunchCard): Promise<string[]> {
        const candidates: string[] = []

        // Preferred pattern from logs and page: data-bi-id^="..."
        if (activity.offerId) {
            candidates.push(`[data-bi-id^="${activity.offerId}"] .pointLink:not(.contentContainer .pointLink)`)
            const esc = (activity.offerId || '').replace(/"/g, '\\"')
            candidates.push(`[data-bi-id^="${esc}"] .pointLink:not(.contentContainer .pointLink)`)
        }

        // If activity.name present, try using it
        if (activity.name) {
            const nameSafe = (activity.name || '').replace(/"/g, '\\"')
            candidates.push(`[data-bi-id^="${nameSafe}"] .pointLink:not(.contentContainer .pointLink)`)
            candidates.push(`[data-bi-id*="${nameSafe}"] .pointLink:not(.contentContainer .pointLink)`)
        }

        // Heuristic: use any .pointLink elements whose ancestor data-bi-id contains daily/gamification/global
        try {
            const heuristic = await page.evaluate(() => {
                const out: string[] = []
                const dailyRe = /dailyset|daily|global_daily|gamification_daily|dailyglobal|global_dailyset|global_daily/i
                const els = Array.from(document.querySelectorAll('.pointLink:not(.contentContainer .pointLink)')) as HTMLElement[]
                const seen = new Set<string>()
                for (const el of els) {
                    let anc: HTMLElement | null = el
                    let dataId = ''
                    while (anc && anc !== document.body) {
                        if ((anc as HTMLElement).hasAttribute && (anc as HTMLElement).hasAttribute('data-bi-id')) {
                            dataId = (anc as HTMLElement).getAttribute('data-bi-id') || ''
                            if (dailyRe.test(dataId)) break
                        }
                        anc = anc.parentElement
                    }
                    if (dataId && dailyRe.test(dataId)) {
                        const esc = dataId.replace(/"/g, '\\"')
                        const sel = `[data-bi-id="${esc}"] .pointLink:not(.contentContainer .pointLink)`
                        if (!seen.has(sel)) { seen.add(sel); out.push(sel) }
                    }
                }
                return out
            })

            for (const s of heuristic) {
                if (!candidates.includes(s)) candidates.push(s)
            }
        } catch {
            // ignore page-eval errors
        }

        // Fallback: generic .pointLink elements (limited)
        candidates.push('.pointLink:not(.contentContainer .pointLink)')
        candidates.push('.pointLink')

        // final unique list
        return Array.from(new Set(candidates))
    }

    /**
     * Hide fixed/overlay elements overlapping a selector (best-effort).
     * Marks hidden elements with data-qa-hidden-temp so we can restore them.
     * Returns number of elements hidden.
     *
     * Protected so subclasses can call when needed.
     */
    protected async hideOverlappingOverlays(page: Page, selector: string): Promise<number> {
        try {
            return await page.evaluate((sel) => {
                const target = document.querySelector(sel) as HTMLElement | null;
                if (!target) return 0;
                const tBox = target.getBoundingClientRect();
                if (!tBox) return 0;
                const all = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
                let hidden = 0;
                for (const el of all) {
                    try {
                        if (el === target) continue;
                        const style = window.getComputedStyle(el);
                        if (!style) continue;
                        if (style.display === 'none' || parseFloat(style.opacity || '1') === 0) continue;
                        const pos = style.position;
                        if (!(pos === 'fixed' || pos === 'absolute' || pos === 'sticky')) continue;
                        const r = el.getBoundingClientRect();
                        if (!r || r.width === 0 || r.height === 0) continue;
                        const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom);
                        if (!overlap) continue;
                        // hide & mark
                        el.setAttribute('data-qa-hidden-temp', 'true');
                        (el as HTMLElement).style.setProperty('display', 'none', 'important');
                        hidden++;
                    } catch {
                        // ignore element-level errors
                    }
                }
                return hidden;
            }, selector);
        } catch {
            return 0;
        }
    }

    /**
     * Restore overlays hidden by hideOverlappingOverlays.
     * Returns number restored.
     */
    protected async restoreHiddenOverlays(page: Page): Promise<number> {
        try {
            return await page.evaluate(() => {
                const hidden = Array.from(document.querySelectorAll('[data-qa-hidden-temp]')) as HTMLElement[];
                for (const el of hidden) {
                    try {
                        el.removeAttribute('data-qa-hidden-temp');
                        (el as HTMLElement).style.removeProperty('display');
                    } catch { /* ignore per-element */ }
                }
                return hidden.length;
            });
        } catch {
            return 0;
        }
    }

    /**
     * Robust click that attempts several strategies, detects popup/navigation,
     * and will try up to maxAttempts. Default attempts = 3.
     *
     * Returns { success, reason?, popup? } where popup is the new Page if one opened.
     */
    private async robustTryClickSelector(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000): Promise<{ success: boolean, reason?: string, popup?: Page }> {
        // context for popup detection
        // @ts-ignore
        const context = page.context ? page.context() : null

        const tryOnce = async (sel: string, timeout: number): Promise<{ success: boolean, reason?: string, popup?: Page }> => {
            // short attached wait
            try { await page.waitForSelector(sel, { state: 'attached', timeout: Math.min(2500, timeout) }) } catch { /* continue */ }

            // Scroll into view & basic visibility checks; try to hide overlays if CSS-hidden
            try {
                const handle = await page.$(sel)
                if (!handle) return { success: false, reason: 'not-found' }

                try { await handle.scrollIntoViewIfNeeded?.({ timeout: 1500 }) } catch {
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

                if (!box || box.width === 0 || box.height === 0) return { success: false, reason: 'zero-bounding-box' }
                if (style.hidden || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
                    const hid = await this.hideOverlappingOverlays(page, sel)
                    if (hid === 0) return { success: false, reason: 'css-hidden' }
                    // continue to click after hiding overlays
                }
            } catch {
                // ignore visibility-check errors and still attempt click
            }

            // prepare popup/navigation watchers
            let popupPromise: Promise<Page | null> | null = null
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1500 }).catch(() => null)
            }
            const navPromise = page.waitForNavigation({ timeout: 1500 }).catch(() => null)

            // Try click strategies
            let clickedOk = false
            try {
                const locator = page.locator(sel).first()
                await locator.scrollIntoViewIfNeeded?.({ timeout: 1500 }).catch(() => null)
                await locator.click({ timeout }).then(() => { clickedOk = true }).catch(() => null)

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
                                await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2).catch(() => null)
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
                    await locator.click({ timeout: perAttemptTimeout, force: true }).then(() => { clickedOk = true }).catch(() => null)
                } catch {
                    // final fail
                }
            }

            // restore overlays (best-effort)
            try { await this.restoreHiddenOverlays(page) } catch { /* ignore */ }

            if (!clickedOk) return { success: false, reason: 'click-failed' }

            // detect popup/navigation
            const popup = popupPromise ? await popupPromise : null
            const nav = await navPromise

            if (popup) {
                try { await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null) } catch {}
                return { success: true, popup }
            }

            if (nav) return { success: true }

            // assume success otherwise
            return { success: true }
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await tryOnce(selector, perAttemptTimeout)
            if (result.success) return result
            if (['click-failed', 'visibility-check-error', 'css-hidden', 'zero-bounding-box', 'not-found'].includes(result.reason || '')) {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                continue
            } else {
                return result
            }
        }

        return { success: false, reason: 'max-retries' }
    }

    /* =========================
       Public flows (DailySet / PunchCard / MorePromotions)
       ========================= */

    // Daily Set
    async doDailySet(page: Page, data: DashboardData) {
        const today = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[today] ?? []

        const activitiesUncompleted = (todayData?.filter(x => !x.complete && x.pointProgressMax > 0) ?? [])
            .filter(x => {
                if (this.bot.config.jobState?.enabled === false) return true
                const email = this.bot.currentAccountEmail || 'unknown'
                return !this.jobState.isDone(email, today, x.offerId)
            })

        if (!activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'DAILY-SET', 'All Daily Set items have already been completed')
            return
        }

        this.bot.log(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(page, activitiesUncompleted)

        if (this.bot.config.jobState?.enabled !== false) {
            const email = this.bot.currentAccountEmail || 'unknown'
            for (const a of activitiesUncompleted) {
                this.jobState.markDone(email, today, a.offerId)
            }
        }

        page = await this.bot.browser.utils.getLatestTab(page)
        await this.bot.browser.func.goHome(page)
        this.bot.log(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')

        // Optional: bundle with desktop search
        if (!this.bot.isMobile && this.bot.config.workers?.bundleDailySetWithSearch && this.bot.config.workers?.doDesktopSearch) {
            try {
                await this.bot.utils.waitRandom(1200, 2600)
                await this.bot.activities.doSearch(page, data)
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'DAILY-SET', `Post-DailySet search failed: ${e instanceof Error ? e.message : e}`, 'warn')
            }
        }
    }

    // Punch Card
    async doPunchCard(page: Page, data: DashboardData) {
        const punchCardsUncompleted = data.punchCards?.filter(x => x.parentPromotion && !x.parentPromotion.complete) ?? []

        if (!punchCardsUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', 'All "Punch Cards" have already been completed')
            return
        }

        for (const punchCard of punchCardsUncompleted) {
            if (!punchCard.parentPromotion?.title) {
                this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `Skipped punchcard "${punchCard.name}" | Reason: Parent promotion is missing!`, 'warn')
                continue
            }

            page = await this.bot.browser.utils.getLatestTab(page)

            const activitiesUncompleted = punchCard.childPromotions.filter(x => !x.complete)

            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `Started solving "Punch Card" items for punchcard: "${punchCard.parentPromotion.title}"`)

            await page.goto(punchCard.parentPromotion.destinationUrl, { referer: this.bot.config.baseURL, timeout: 120000 })
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { })

            await this.solveActivities(page, activitiesUncompleted, punchCard)

            page = await this.bot.browser.utils.getLatestTab(page)
            const pages = page.context().pages()

            if (pages.length > 3) {
                await page.close()
            } else {
                await this.bot.browser.func.goHome(page)
            }

            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `All items for punchcard: "${punchCard.parentPromotion.title}" have been completed`)
        }

        this.bot.log(this.bot.isMobile, 'PUNCH-CARD', 'All "Punch Card" items have been completed')
    }

    // More Promotions
    async doMorePromotions(page: Page, data: DashboardData) {
        const morePromotions = data.morePromotions

        if (data.promotionalItem) {
            morePromotions.push(data.promotionalItem as unknown as MorePromotion)
        }

        const activitiesUncompleted = morePromotions?.filter(x => !x.complete && x.pointProgressMax > 0 && x.exclusiveLockedFeatureStatus !== 'locked') ?? []

        if (!activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have already been completed')
            return
        }

        this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'Started solving "More Promotions" items')

        page = await this.bot.browser.utils.getLatestTab(page)
        await this.solveActivities(page, activitiesUncompleted)
        page = await this.bot.browser.utils.getLatestTab(page)
        await this.bot.browser.func.goHome(page)

        this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')
    }

    /**
     * Solve all the different types of activities.
     * - Uses robust selector candidates and robust click logic.
     * - Limits attempts so we don't waste server time.
     * - Uses Retry + AdaptiveThrottler to slow down/backoff on failures.
     */
    private async solveActivities(activityPage: Page, activities: PromotionalItem[] | MorePromotion[], punchCard?: PunchCard) {
        const activityInitial = activityPage.url()

        const retry = new Retry(this.bot.config.retryPolicy)
        const throttle = new AdaptiveThrottler()

        for (const activity of activities) {
            try {
                // Reselect the worker page
                activityPage = await this.bot.browser.utils.getLatestTab(activityPage)

                const pages = activityPage.context().pages()
                if (pages.length > 3) {
                    await activityPage.close()
                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage)
                }

                // humanize small gestures & throttle
                await this.bot.browser.utils.humanizePage(activityPage)
                {
                    const m = throttle.getDelayMultiplier()
                    await this.bot.utils.waitRandom(Math.floor(800 * m), Math.floor(1400 * m))
                }

                if (activityPage.url() !== activityInitial) {
                    await activityPage.goto(activityInitial).catch(() => { /* ignore navigation error */ })
                }

                // Build selector candidates
                let selectors: string[] = []
                if (punchCard) {
                    try {
                        const derived = await this.bot.browser.func.getPunchCardActivity(activityPage, activity)
                        if (derived) selectors.push(derived)
                    } catch { /* ignore */ }
                }

                const built = await this.buildSelectorsForActivity(activityPage, activity as PromotionalItem, punchCard)
                selectors = selectors.concat(built)
                selectors = Array.from(new Set(selectors)).filter(Boolean)

                // Wait for DOM to settle
                await activityPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { })
                await this.bot.utils.wait(1500)

                // Try clicking candidates (limit total candidate attempts)
                let clickedResult: { success: boolean, reason?: string, popup?: Page } | null = null
                const maxCandidatesToTry = 5
                let candidateCount = 0

                for (const sel of selectors) {
                    if (candidateCount >= maxCandidatesToTry) break
                    candidateCount++

                    const res = await this.robustTryClickSelector(activityPage, sel, 3, 10000)
                    if (res.success) {
                        clickedResult = res
                        break
                    } else {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Could not click selector "${sel}" for "${activity.title}" | reason: ${res.reason}`, 'warn')
                    }
                }

                if (!clickedResult || !clickedResult.success) {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Could not click any selectors (tried ${candidateCount})`, 'warn')
                    await this.bot.utils.wait(500)
                    throttle.record(false)
                    continue
                }

                // If click opened popup, switch to it; otherwise get latest tab
                if (clickedResult.popup) {
                    activityPage = clickedResult.popup
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500))
                } else {
                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage)
                    await this.bot.utils.wait(1000)
                }

                // Determine type label for logs
                const typeLabel = this.bot.activities?.getTypeLabel ? this.bot.activities.getTypeLabel(activity) : (activity as PromotionalItem).promotionType || 'unknown'
                if (typeLabel !== 'Unsupported') {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "${typeLabel}" title: "${activity.title}"`)
                    // Run activity inside retry & throttling; enforce a generous timeout
                    const timeoutMs = this.bot.utils.stringToMs(this.bot.config?.globalTimeout ?? '30s') * 2
                    const runWithTimeout = (p: Promise<void>) => Promise.race([
                        p,
                        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('activity-timeout')), timeoutMs))
                    ])

                    try {
                        await retry.run(async () => {
                            try {
                                await runWithTimeout(this.bot.activities.run(activityPage, activity))
                                throttle.record(true)
                            } catch (e) {
                                await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_timeout_${activity.title || activity.offerId}`)
                                throttle.record(false)
                                throw e
                            }
                        }, () => true)
                    } catch (e) {
                        // activity failed after retries
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Activity "${activity.title}" failed after retries: ${e instanceof Error ? e.message : e}`, 'error')
                    }
                } else {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Unsupported type: "${(activity as PromotionalItem).promotionType}"!`, 'warn')
                }

                // Cooldown with jitter
                await this.bot.browser.utils.humanizePage(activityPage)
                {
                    const m = throttle.getDelayMultiplier()
                    await this.bot.utils.waitRandom(Math.floor(1200 * m), Math.floor(2600 * m))
                }
            } catch (error) {
                await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_error_${activity.title || activity.offerId}`)
                this.bot.log(this.bot.isMobile, 'ACTIVITY', 'An error occurred:' + error, 'error')
            }
        }
    }
}
