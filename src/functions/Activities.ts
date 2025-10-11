import { Page } from 'rebrowser-playwright'
import { MicrosoftRewardsBot } from '../index'

import { Search } from './activities/Search'
import { ABC } from './activities/ABC'
import { Poll } from './activities/Poll'
import { Quiz } from './activities/Quiz'
import { ThisOrThat } from './activities/ThisOrThat'
import { UrlReward } from './activities/UrlReward'
import { SearchOnBing } from './activities/SearchOnBing'
import { ReadToEarn } from './activities/ReadToEarn'
import { DailyCheckIn } from './activities/DailyCheckIn'

import { DashboardData, MorePromotion, PromotionalItem } from '../interface/DashboardData'
import type { ActivityHandler } from '../interface/ActivityHandler'

type ActivityKind =
    | { type: 'poll' }
    | { type: 'abc' }
    | { type: 'thisOrThat' }
    | { type: 'quiz' }
    | { type: 'urlReward' }
    | { type: 'searchOnBing' }
    | { type: 'unsupported' }

export default class Activities {
    private bot: MicrosoftRewardsBot
    private handlers: ActivityHandler[] = []

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    // Extension point: register custom activity handlers
    registerHandler(handler: ActivityHandler) {
        this.handlers.push(handler)
    }

    /**
     * Small humanization helper used after activity actions.
     * Uses bot.config.humanization if present:
     *  bot.config.humanization.enabled (bool) - disable all human delays when false
     *  bot.config.humanization.actionDelay = { min: number, max: number } - explicit ms bounds
     */
    private async humanPause(minMs = 1000, maxMs = 3000) {
        try {
            const h = this.bot?.config?.humanization
            if (h && h.enabled === false) return
            if (h && h.actionDelay && typeof h.actionDelay.min !== 'undefined' && typeof h.actionDelay.max !== 'undefined') {
                const min = Number(h.actionDelay.min)
                const max = Number(h.actionDelay.max)
                if (!Number.isNaN(min) && !Number.isNaN(max) && max >= min) {
                    await this.bot.utils.wait(this.bot.utils.randomNumber(min, max))
                    return
                }
            }
        } catch { /* ignore and use provided defaults */ }

        // fallback
        if (this.bot && this.bot.utils && typeof this.bot.utils.wait === 'function') {
            await this.bot.utils.wait(this.bot.utils.randomNumber(minMs, maxMs))
        } else {
            await new Promise(res => setTimeout(res, this.randomNumber(minMs, maxMs)))
        }
    }

    // helper used when bot.utils isn't available in some contexts
    private randomNumber(min: number, max: number) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    /**
     * Simulate natural scrolling behaviour. Random distance, occasional slight reverse.
     */
    private async humanScroll(page: Page) {
        try {
            const viewportHeight = await page.evaluate(() => (window.innerHeight || 720)) as number
            const scrollAmount = Math.floor(viewportHeight * (0.5 + Math.random() * 0.5))
            const direction = Math.random() > 0.5 ? 1 : -1
            await page.evaluate((amt) => window.scrollBy(0, amt), scrollAmount * direction)
            await this.humanPause(300, 700)
            if (Math.random() < 0.3) {
                // slight reversal to mimic human indecision
                await page.evaluate((amt) => window.scrollBy(0, amt), -Math.floor(scrollAmount * 0.2) * direction)
                await this.humanPause(100, 300)
            }
        } catch (e) {
            // ignore scroll errors
            this.bot.log(this.bot.isMobile, 'HUMANIZE', `humanScroll failed: ${e instanceof Error ? e.message : String(e)}`, 'warn')
        }
    }

    /**
     * Simulate hovering over an element selector when possible
     */
    private async humanHover(page: Page, selector: string, timeout = 3000) {
        try {
            const loc = page.locator(selector)
            await loc.waitFor({ state: 'visible', timeout }).catch(() => { /* ignore */ })
            await loc.hover({ timeout: 2000 }).catch(() => { /* ignore */ })
            await this.humanPause(150, 500)
        } catch (e) {
            // don't fail activity for hover failure
        }
    }

    /**
     * Central dispatch entry point.
     * First tries custom registered handlers, then falls back to built-in classifiers.
     */
    async run(page: Page, activity: MorePromotion | PromotionalItem): Promise<void> {
        // Try custom handlers first
        for (const h of this.handlers) {
            try {
                if (h.canHandle(activity)) {
                    await h.run(page, activity)
                    await this.humanPause(800, 1500)
                    return
                }
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Custom handler ${(h.id || 'unknown')} failed: ${e instanceof Error ? e.message : e}`, 'error')
            }
        }

        const kind = this.classifyActivity(activity)
        try {
            switch (kind.type) {
                case 'poll':
                    await this.doPoll(page)
                    break
                case 'abc':
                    await this.doABC(page)
                    break
                case 'thisOrThat':
                    await this.doThisOrThat(page)
                    break
                case 'quiz':
                    await this.doQuiz(page)
                    break
                case 'searchOnBing':
                    await this.doSearchOnBing(page, activity)
                    break
                case 'urlReward':
                    await this.doUrlReward(page)
                    break
                default:
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Unsupported type: "${String((activity as { promotionType?: string }).promotionType)}"!`, 'warn')
                    break
            }
            // small pause after each handled activity
            await this.humanPause()
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'ACTIVITY', `Dispatcher error for "${activity.title}": ${e instanceof Error ? e.message : e}`, 'error')
        }
    }

    public getTypeLabel(activity: MorePromotion | PromotionalItem): string {
        const k = this.classifyActivity(activity)
        switch (k.type) {
            case 'poll': return 'Poll'
            case 'abc': return 'ABC'
            case 'thisOrThat': return 'ThisOrThat'
            case 'quiz': return 'Quiz'
            case 'searchOnBing': return 'SearchOnBing'
            case 'urlReward': return 'UrlReward'
            default: return 'Unsupported'
        }
    }

    private classifyActivity(activity: MorePromotion | PromotionalItem): ActivityKind {
        const type = (activity.promotionType || '').toLowerCase()
        if (type === 'quiz') {
            const max = activity.pointProgressMax
            const url = (activity.destinationUrl || '').toLowerCase()
            if (max === 10) {
                if (url.includes('pollscenarioid')) return { type: 'poll' }
                return { type: 'abc' }
            }
            if (max === 50) return { type: 'thisOrThat' }
            return { type: 'quiz' }
        }
        if (type === 'urlreward') {
            const name = (activity.name || '').toLowerCase()
            if (name.includes('exploreonbing')) return { type: 'searchOnBing' }
            return { type: 'urlReward' }
        }
        return { type: 'unsupported' }
    }

    // ---- activity wrappers (instantiate per-call so they get fresh bot reference) ----

    /**
     * doSearch now supports an optional numSearches parameter.
     * If provided, activities will attempt to perform up to that many searches in this call.
     */
    async doSearch(page: Page, data: DashboardData, numSearches?: number): Promise<void> {
        // small pre-search humanization: scroll + optional hover on the search field
        await this.humanScroll(page)
        await this.humanHover(page, '#sb_form_q')

        // instantiate and delegate to the Search activity
        const search = new Search(this.bot)

        try {
            // If caller provided a hint for number of searches, forward it.
            // Search.doSearch should be updated to accept the optional third parameter.
            // We keep compatibility with existing signature by checking function length
            // but prefer passing numSearches when available.
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            if (typeof (search.doSearch) === 'function') {
                // attempt to call with numSearches; if upstream doesn't accept it, it should ignore the extra arg
                // calling with explicit three args is safe in JS/TS if function ignores extras
                // ensure reasonable guard on numSearches (positive integer)
                let n: number | undefined = undefined
                if (typeof numSearches === 'number' && Number.isInteger(numSearches) && numSearches > 0) n = Math.min(Math.max(1, numSearches), 50) // cap

                await (search as any).doSearch(page, data, n)
            } else {
                // fallback: call old signature
                await (search as any).doSearch(page, data)
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'ACTIVITY', `doSearch wrapper error: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }

        // small post-search humanization
        if (Math.random() < 0.5) await this.humanScroll(page)
        if (Math.random() < 0.3) await this.humanHover(page, '#b_results .b_algo h2')

        await this.humanPause(1000, 2000)
    }

    async doABC(page: Page): Promise<void> {
        const abc = new ABC(this.bot)
        await this.humanScroll(page)
        await this.humanHover(page, '.rwds_svg')
        await abc.doABC(page)
        if (Math.random() < 0.4) await this.humanScroll(page)
        await this.humanPause(1500, 3000)
    }

    async doPoll(page: Page): Promise<void> {
        const poll = new Poll(this.bot)
        await this.humanScroll(page)
        await this.humanHover(page, '.bt_option')
        await poll.doPoll(page)
        if (Math.random() < 0.4) await this.humanHover(page, '.bt_vote')
        await this.humanPause(1000, 2000)
    }

    async doThisOrThat(page: Page): Promise<void> {
        const thisOrThat = new ThisOrThat(this.bot)
        await this.humanScroll(page)
        await this.humanHover(page, '.wk_choicesCont')
        await thisOrThat.doThisOrThat(page)
        if (Math.random() < 0.4) await this.humanScroll(page)
        await this.humanPause(1200, 2500)
    }

    async doQuiz(page: Page): Promise<void> {
        const quiz = new Quiz(this.bot)
        await this.humanScroll(page)
        await this.humanHover(page, '.wk_QuestionPane')
        await quiz.doQuiz(page)
        if (Math.random() < 0.4) await this.humanHover(page, '.wk_QuestionPane')
        await this.humanPause(1000, 2000)
    }

    async doUrlReward(page: Page): Promise<void> {
        const urlReward = new UrlReward(this.bot)
        await this.humanScroll(page)
        await this.humanHover(page, 'a[href*="rewards.microsoft.com"]')
        await urlReward.doUrlReward(page)
        if (Math.random() < 0.4) await this.humanScroll(page)
        await this.humanPause(1000, 2000)
    }

    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem): Promise<void> {
        const searchOnBing = new SearchOnBing(this.bot)
        await this.humanScroll(page)
        await this.humanHover(page, '#sb_form_q')
        await searchOnBing.doSearchOnBing(page, activity)
        await this.humanPause(1000, 2000)
    }

    async doReadToEarn(accessToken: string, data: DashboardData): Promise<void> {
        const readToEarn = new ReadToEarn(this.bot)
        // API-based: quicker pauses
        await readToEarn.doReadToEarn(accessToken, data)
        await this.humanPause(500, 1500)
    }

    async doDailyCheckIn(accessToken: string, data: DashboardData): Promise<void> {
        const dailyCheckIn = new DailyCheckIn(this.bot)
        await dailyCheckIn.doDailyCheckIn(accessToken, data)
        await this.humanPause(500, 1500)
    }
}
