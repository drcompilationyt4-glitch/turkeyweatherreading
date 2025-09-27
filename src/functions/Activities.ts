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

        await this.bot.utils.wait(this.bot.utils.randomNumber(minMs, maxMs))
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

    async doSearch(page: Page, data: DashboardData): Promise<void> {
        const search = new Search(this.bot)
        await search.doSearch(page, data)
        await this.humanPause(1000, 2000)
    }

    async doABC(page: Page): Promise<void> {
        const abc = new ABC(this.bot)
        await abc.doABC(page)
        await this.humanPause(1500, 3000)
    }

    async doPoll(page: Page): Promise<void> {
        const poll = new Poll(this.bot)
        await poll.doPoll(page)
        await this.humanPause(1000, 2000)
    }

    async doThisOrThat(page: Page): Promise<void> {
        const thisOrThat = new ThisOrThat(this.bot)
        await thisOrThat.doThisOrThat(page)
        await this.humanPause(1200, 2500)
    }

    async doQuiz(page: Page): Promise<void> {
        const quiz = new Quiz(this.bot)
        await quiz.doQuiz(page)
        await this.humanPause(1000, 2000)
    }

    async doUrlReward(page: Page): Promise<void> {
        const urlReward = new UrlReward(this.bot)
        await urlReward.doUrlReward(page)
        await this.humanPause(1000, 2000)
    }

    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem): Promise<void> {
        const searchOnBing = new SearchOnBing(this.bot)
        await searchOnBing.doSearchOnBing(page, activity)
        await this.humanPause(1000, 2000)
    }

    async doReadToEarn(accessToken: string, data: DashboardData): Promise<void> {
        const readToEarn = new ReadToEarn(this.bot)
        await readToEarn.doReadToEarn(accessToken, data)
        await this.humanPause(1000, 2000)
    }

    async doDailyCheckIn(accessToken: string, data: DashboardData): Promise<void> {
        const dailyCheckIn = new DailyCheckIn(this.bot)
        await dailyCheckIn.doDailyCheckIn(accessToken, data)
        await this.humanPause(1000, 2000)
    }
}
