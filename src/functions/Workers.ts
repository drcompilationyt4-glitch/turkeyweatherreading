import { Page } from 'rebrowser-playwright'
import { DashboardData, MorePromotion, PromotionalItem, PunchCard } from '../interface/DashboardData'
import { MicrosoftRewardsBot } from '../index'
import JobState from '../util/JobState'
import Retry from '../util/Retry'
import { AdaptiveThrottler } from '../util/AdaptiveThrottler'


// Common interface for shared properties
interface BaseActivity {
    title: string;
    offerId?: string;
    name?: string;
    complete: boolean;
    pointProgressMax: number;
    promotionType?: string;
    destinationUrl?: string;
    exclusiveLockedFeatureStatus?: string;
}

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
    private async buildSelectorsForActivity(page: Page, activity: BaseActivity, punchCard?: PunchCard): Promise<string[]> {
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
     */
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
                        if (!(pos === 'fixed' || pos === 'absolute' || pos === 'sticky')) continue
                        const r = el.getBoundingClientRect()
                        if (!r || r.width === 0 || r.height === 0) continue
                        const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom)
                        if (!overlap) continue
                        el.setAttribute('data-qa-hidden-temp', 'true')
                        el.style.setProperty('display', 'none', 'important')
                        hidden++
                    } catch {
                        // ignore element-level errors
                    }
                }
                return hidden
            }, selector)
        } catch {
            return 0
        }
    }

    /**
     * Restore overlays hidden by hideOverlappingOverlays.
     * Returns number restored.
     */
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

    /**
     * Simulate human-like mouse movement to a target element.
     * Uses bezier curves for natural paths, with randomness in speed and path.
     */
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
            await page.mouse.move(0, 0)
        }
    }

    /**
     * Simulate human-like hover over an element with random duration and small movements.
     */
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

    /**
     * Simulate human-like scrolling with variable speed, pauses, and overscroll.
     */
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

    /**
     * Robust click with human-like behavior, multiple strategies, and popup/navigation detection.
     */
    private async robustTryClickSelector(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000): Promise<{ success: boolean; reason?: string; popup?: Page }> {
        const context = page.context ? page.context() : null

        const tryOnce = async (sel: string, timeout: number): Promise<{ success: boolean; reason?: string; popup?: Page }> => {
            if (Math.random() < 0.6) await this.humanScroll(page)
            await this.bot.utils.waitRandom(400, 1200)

            try {
                await page.waitForSelector(sel, { state: 'attached', timeout: Math.min(2500, timeout) + Math.random() * 500 })
            } catch { /* continue */ }

            try {
                const handle = await page.$(sel)
                if (!handle) return { success: false, reason: 'not-found' }

                await this.humanScroll(page)
                try {
                    await handle.scrollIntoViewIfNeeded?.({ timeout: 1500 + Math.random() * 1000 })
                } catch {
                    await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: Math.random() < 0.5 ? 'smooth' : 'auto' })
                    }, sel)
                }
                await this.bot.utils.waitRandom(300, 800)

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
                }
            } catch {
                // ignore visibility-check errors
            }

            await this.humanHover(page, sel)

            let popupPromise: Promise<Page | null> | null = null
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1500 + Math.random() * 1000 }).catch(() => null)
            }
            const navPromise = page.waitForNavigation({ timeout: 1500 + Math.random() * 1000 }).catch(() => null)

            let clickedOk = false
            try {
                const locator = page.locator(sel).first()
                await locator.scrollIntoViewIfNeeded?.({ timeout: 1500 + Math.random() * 500 }).catch(() => null)
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
                    await locator.click({ timeout: perAttemptTimeout, force: Math.random() < 0.2, position: { x: Math.random() * 10 - 5, y: Math.random() * 10 - 5 } }).then(() => {
                        clickedOk = true
                    }).catch(() => null)
                } catch {
                    // final fail
                }
            }

            await this.bot.utils.waitRandom(200, 600)
            try {
                await this.restoreHiddenOverlays(page)
            } catch { /* ignore */ }

            if (!clickedOk) return { success: false, reason: 'click-failed' }

            await this.bot.utils.waitRandom(300, 900)
            const popup = popupPromise ? await popupPromise : null
            const nav = await navPromise

            if (popup) {
                try {
                    await popup.waitForLoadState('domcontentloaded', { timeout: 10000 + Math.random() * 5000 })
                } catch {}
                return { success: true, popup }
            }

            if (nav) return { success: true }

            return { success: true }
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await tryOnce(selector, perAttemptTimeout)
            if (result.success) return result
            if (['click-failed', 'visibility-check-error', 'css-hidden', 'zero-bounding-box', 'not-found'].includes(result.reason || '')) {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900) * (1 + attempt * 0.5))
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

    async doDailySet(page: Page, data: DashboardData) {
        const today = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[today] ?? []

        const activitiesUncompleted = (todayData?.filter(x => !x.complete && x.pointProgressMax > 0) ?? []).filter(x => {
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

        if (!this.bot.isMobile && this.bot.config.workers?.bundleDailySetWithSearch && this.bot.config.workers?.doDesktopSearch) {
            try {
                await this.bot.utils.waitRandom(1200, 2600)
                await this.bot.activities.doSearch(page, data)
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'DAILY-SET', `Post-DailySet search failed: ${e instanceof Error ? e.message : e}`, 'warn')
            }
        }
    }

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

            await page.goto(punchCard.parentPromotion.destinationUrl, { referer: this.bot.config.baseURL, timeout: 120000 + Math.random() * 20000 })
            await page.waitForLoadState('networkidle', { timeout: 5000 + Math.random() * 3000 }).catch(() => {})

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

    async doMorePromotions(page: Page, data: DashboardData) {
        const morePromotions = data.morePromotions

        if (data.promotionalItem) {
            morePromotions.push(data.promotionalItem as unknown as MorePromotion)
        }

        const activitiesUncompleted = morePromotions
            ?.filter(x => !x.complete && x.pointProgressMax > 0 && x.exclusiveLockedFeatureStatus !== 'locked')
            ?.map(x => ({ ...x, title: x.title || 'Untitled', offerId: x.offerId, name: x.name, complete: x.complete, pointProgressMax: x.pointProgressMax })) ?? []

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
     * Solve activities with robust selector candidates, click logic, and human-like behavior.
     */
    /**
     * Solve activities with robust selector candidates, click logic, and human-like behavior.
     */
    /**
     * Solve activities with robust selector candidates, click logic, and human-like behavior.
     */
    // File: src/functions/Workers.ts
// Method: public async solveActivities(...)
    public async solveActivities(activityPage: Page, activities: BaseActivity[], punchCard?: PunchCard) {
        const activityInitial = activityPage.url();

        const retry = new Retry(this.bot.config.retryPolicy);
        const throttle = new AdaptiveThrottler();

        // Shuffle activities safely
        const shuffledActivities = [...activities].sort(() => Math.random() - 0.5);

        for (const activity of shuffledActivities) {
            try {
                activityPage = await this.bot.browser.utils.getLatestTab(activityPage);

                const pages = activityPage.context().pages();
                if (pages.length > 3) {
                    await activityPage.close();
                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage);
                }

                await this.bot.browser.utils.humanizePage(activityPage);
                const m1 = throttle.getDelayMultiplier();
                await this.bot.utils.waitRandom(Math.floor(800 * m1), Math.floor(1400 * m1));

                if (activityPage.url() !== activityInitial) {
                    await activityPage.goto(activityInitial, { timeout: 30000 + Math.random() * 10000 }).catch(() => {});
                    await this.bot.utils.waitRandom(1000, 3000);
                }

                for (let i = 0; i < Math.floor(1 + Math.random() * 3); i++) {
                    await this.humanScroll(activityPage);
                    await this.bot.utils.waitRandom(500, 1500);
                }

                let selectors: string[] = [];
                if (punchCard) {
                    try {
                        const derived = await this.bot.browser.func.getPunchCardActivity(activityPage, activity as PromotionalItem);
                        if (derived) selectors.push(derived);
                    } catch { /* ignore */ }
                }

                const built = await this.buildSelectorsForActivity(activityPage, activity, punchCard);
                selectors = selectors.concat(built);
                selectors = Array.from(new Set(selectors)).filter(Boolean);

                await activityPage.waitForLoadState('networkidle', { timeout: 5000 + Math.random() * 2000 }).catch(() => {});
                await this.bot.utils.wait(1500 + Math.random() * 1000);

                let clickedResult: { success: boolean; reason?: string; popup?: Page } | null = null;
                const maxCandidatesToTry = 5;
                let candidateCount = 0;

                for (const sel of selectors) {
                    if (candidateCount >= maxCandidatesToTry) break;
                    candidateCount++;

                    await this.humanHover(activityPage, sel);

                    const res = await this.robustTryClickSelector(activityPage, sel, 3, 10000);
                    if (res.success) {
                        clickedResult = res;
                        break;
                    } else {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Could not click selector "${sel}" for "${activity.title}" | reason: ${res.reason}`, 'warn');
                    }
                }

                if (!clickedResult || !clickedResult.success) {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Could not click any selectors (tried ${candidateCount})`, 'warn');
                    await this.bot.utils.wait(500 + Math.random() * 500);
                    throttle.record(false);
                    continue;
                }

                if (clickedResult.popup) {
                    activityPage = clickedResult.popup;
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500) + Math.random() * 1000);
                } else {
                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage);
                    await this.bot.utils.wait(1000 + Math.random() * 1000);
                }

                await this.bot.utils.waitRandom(800, 2200);
                if (Math.random() < 0.7) await this.humanScroll(activityPage);

                const typeLabel = this.bot.activities?.getTypeLabel ? this.bot.activities.getTypeLabel(activity as PromotionalItem | MorePromotion) : activity.promotionType || 'unknown';
                if (typeLabel !== 'Unsupported') {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "${typeLabel}" title: "${activity.title}"`);
                    const timeoutMs = this.bot.utils.stringToMs(this.bot.config?.globalTimeout ?? '30s') * 2 + Math.random() * 10000;
                    const runWithTimeout = (p: Promise<void>) => Promise.race([
                        p,
                        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('activity-timeout')), timeoutMs))
                    ]);

                    try {
                        await retry.run(async () => {
                            try {
                                await runWithTimeout(this.bot.activities.run(activityPage, activity as PromotionalItem | MorePromotion));
                                throttle.record(true);
                            } catch (e) {
                                await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_timeout_${activity.title || activity.offerId || 'unknown'}`);
                                throttle.record(false);
                                throw e;
                            }
                        }, () => true);
                    } catch (e) {
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Activity "${activity.title}" failed after retries: ${e instanceof Error ? e.message : e}`, 'error');
                    }
                } else {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Unsupported type: "${activity.promotionType}"!`, 'warn');
                }

                await this.bot.browser.utils.humanizePage(activityPage);
                {
                    const m = throttle.getDelayMultiplier();
                    // FIXED: use this.bot.utils instead of this.utils
                    await this.bot.utils.waitRandom(Math.floor(1200 * m), Math.floor(2600 * m));
                }
                if (Math.random() < 0.4) await this.humanHover(activityPage, 'body');
            } catch (error) {
                await this.bot.browser.utils.captureDiagnostics(activityPage, `activity_error_${activity.title || activity.offerId || 'unknown'}`);
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `An error occurred: ${error}`, 'error');
            }
        }
    }

}