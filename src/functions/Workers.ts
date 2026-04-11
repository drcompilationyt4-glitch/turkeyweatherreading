import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { DashboardData, PunchCard } from '../interface/DashboardData'

export class Workers {
    protected bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doDailySet(data: DashboardData, page: Page) {
        // V4 MODERN UI LOGIC
        if (this.bot.rewardsVersion === 'modern' && (data as any).v4Data) {
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Using Modern UI (V4) detection logic')
            const v4Data = (data as any).v4Data

            // Also try to get data from /earn page for additional activities
            let earnPageData = null
            try {
                await page
                    .goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 15000 })
                    .catch(() => { })
                await this.bot.browser.utils.wakePage(page)
                const earnHtml = await page.content()
                const earnNextData = this.bot.nextParser.parse(earnHtml)
                if (earnNextData.length > 0) {
                    earnPageData = earnNextData
                    this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Fetched additional data from /earn page')
                }
            } catch {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Could not fetch /earn page data')
            }

            // Combine both sources of data
            const combinedData = earnPageData ? [...v4Data, ...earnPageData] : v4Data

            // Get today's date in MM/DD/YYYY format
            const today = new Date()
            const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`

            const dailySetItems = this.bot.nextParser.find(combinedData, 'dailySetItems') ?? []
            const todayItems = dailySetItems.filter((x: any) => x.date === todayStr)
            const uncompleted = todayItems.filter((x: any) => !x.isCompleted && x.points > 0)

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-SET',
                `Date: ${todayStr}, Found ${dailySetItems.length} total items, ${todayItems.length} for today, ${uncompleted.length} uncompleted`
            )

            if (uncompleted.length === 0 && dailySetItems.length > 0) {
                const allUncompleted = dailySetItems.filter((x: any) => !x.isCompleted && x.points > 0)
                if (allUncompleted.length > 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `Found ${allUncompleted.length} uncompleted items (any date)`
                    )

                    const mapped = allUncompleted.map((x: any) => ({
                        title: x.title || 'Unknown Title',
                        offerId: x.offerId || 'Unknown ID',
                        destination: x.destination || x.destinationUrl,
                        hash: x.hash || '',
                        type: x.type || x.activityType || '',
                        complete: false,
                        pointProgressMax: x.points || x.pointProgressMax || 0
                    }))

                    await this.solveActivities(mapped, page, undefined, 'dailySet')
                    return
                }
            }

            if (uncompleted.length) {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', `Solving ${uncompleted.length} modern items`)
                const mapped = uncompleted.map((x: any) => ({
                    title: x.title || 'Unknown Title',
                    offerId: x.offerId || 'Unknown ID',
                    destination: x.destination || x.destinationUrl,
                    hash: x.hash || '',
                    type: x.type || x.activityType || '',
                    complete: false,
                    pointProgressMax: x.points || x.pointProgressMax || 0
                }))
                await this.solveActivities(mapped, page, undefined, 'dailySet')
            } else {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All modern daily items already completed')
            }
            return
        }

        // V3 LEGACY LOGIC
        this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Using Legacy UI (V3) detection logic')
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions?.[todayKey] ?? []
        const activitiesUncompleted = todayData.filter(x => !x?.complete && x.pointProgressMax > 0)

        if (activitiesUncompleted.length > 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                `Found ${activitiesUncompleted.length} uncompleted items`
            )
            await this.solveActivities(activitiesUncompleted, page, undefined, 'dailySet')
        }
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        // V4 MODERN UI LOGIC
        if (this.bot.rewardsVersion === 'modern' && (data as any).v4Data) {
            this.bot.logger.debug(this.bot.isMobile, 'MORE-PROMOTIONS', 'Using Modern UI (V4) detection logic')
            const v4Data = (data as any).v4Data

            // Also try to get data from /earn page for "Keep earning" activities
            let earnPageData = null
            try {
                await page
                    .goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 15000 })
                    .catch(() => { })
                await this.bot.browser.utils.wakePage(page)
                const earnHtml = await page.content()
                const earnNextData = this.bot.nextParser.parse(earnHtml)
                if (earnNextData.length > 0) {
                    earnPageData = earnNextData
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'MORE-PROMOTIONS',
                        'Fetched /earn page data for Keep earning'
                    )
                }
            } catch {
                this.bot.logger.debug(this.bot.isMobile, 'MORE-PROMOTIONS', 'Could not fetch /earn page data')
            }

            const combinedData = earnPageData ? [...v4Data, ...earnPageData] : v4Data

            const allWithOfferId = this.findAllWithOfferId(combinedData)
            this.bot.logger.debug(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Found ${allWithOfferId.length} items with offerId in Next.js data`
            )

            let moreActivities = this.bot.nextParser.find(combinedData, 'moreActivities') ?? []
            if (!moreActivities.length) {
                moreActivities =
                    this.bot.nextParser.find(combinedData, 'moreActivities') ??
                    this.bot.nextParser.find(combinedData, 'more_activity') ??
                    allWithOfferId.filter((x: any) => x.destination && !x.isCompleted)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Found ${moreActivities.length} moreActivities items`
            )

            const panelDataRaw = this.bot.panelData as any
            this.bot.logger.debug(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Panel data keys: ${panelDataRaw ? Object.keys(panelDataRaw).join(', ') : 'undefined'}`
            )

            const userInfoData = panelDataRaw?.userInfo
            this.bot.logger.debug(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `UserInfo keys: ${userInfoData ? Object.keys(userInfoData).join(', ') : 'undefined'}`
            )

            let panelFlyoutPromos: any[] = []

            if (panelDataRaw?.flyoutResult?.morePromotions) {
                panelFlyoutPromos = panelDataRaw.flyoutResult.morePromotions
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Found ${panelFlyoutPromos.length} items in flyoutResult.morePromotions`
                )
            }

            if (userInfoData?.promotions) {
                const userInfoPromos = userInfoData.promotions

                const transformedPromos = userInfoPromos.map((p: any) => {
                    const attrs = p.attributes || {}
                    const isComplete = attrs.complete === 'True' || attrs.complete === true
                    return {
                        title: attrs.title || p.name || 'Unknown Title',
                        offerId: attrs.offerid || p.name || 'Unknown ID',
                        destination: attrs.destination || '',
                        complete: isComplete,
                        isCompleted: isComplete,
                        points: parseInt(attrs.max) || 0,
                        pointProgressMax: parseInt(attrs.max) || 0,
                        activityType: 0
                    }
                })

                const existingIds = new Set(panelFlyoutPromos.map((p: any) => p.offerId))
                const newPromos = transformedPromos.filter((p: any) => !existingIds.has(p.offerId))
                panelFlyoutPromos = [...panelFlyoutPromos, ...newPromos]

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Combined ${panelFlyoutPromos.length} items from flyoutResult + userInfo.promotions`
                )
            }

            const panelUncompleted = panelFlyoutPromos
                .filter((p: any) => !p.isCompleted && !p.complete && p.offerId)
                .map((p: any) => ({
                    title: p.title || 'Unknown Title',
                    offerId: p.offerId || p.name || 'Unknown ID',
                    destination: p.destinationUrl || p.destination || '',
                    hash: p.hash || '',
                    complete: false,
                    pointProgressMax: p.points || p.pointProgressMax || 0,
                    activityType: p.activityType || 0,
                    isLocked: false
                }))

            if (panelUncompleted.length) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Panel flyout items to solve: ${panelUncompleted.map((m: any) => `${m.title} (${m.offerId})`).join(', ')}`
                )
            }

            const mappedMoreActivities = moreActivities
                .filter((x: any) => !x.isLocked && x.points > 0)
                .filter((x: any) => !x.isCompleted)
                .map((x: any) => ({
                    title: x.title || 'Unknown Title',
                    offerId: x.offerId || 'Unknown ID',
                    destination: x.destination || x.destinationUrl,
                    hash: x.hash || '',
                    complete: false,
                    pointProgressMax: x.points || x.pointProgressMax || 0,
                    activityType: x.activityType || 0,
                    isLocked: x.isLocked || false
                }))

            const allUncompleted = [...mappedMoreActivities, ...panelUncompleted]

            if (allUncompleted.length) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Solving ${allUncompleted.length} modern items`
                )
                await this.solveActivities(allUncompleted, page, undefined, 'morePromotions')
            } else {
                this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All modern more items already completed')
            }
            return
        }

        // V3 LEGACY LOGIC
        this.bot.logger.debug(this.bot.isMobile, 'MORE-PROMOTIONS', 'Using Legacy UI (V3) detection logic')
        const morePromotions = data.morePromotions ?? []
        const activitiesUncompleted = morePromotions.filter(x => !x?.complete && x.pointProgressMax > 0)

        if (activitiesUncompleted.length > 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Found ${activitiesUncompleted.length} uncompleted items`
            )
            await this.solveActivities(activitiesUncompleted as any, page, undefined, 'morePromotions')
        }
    }

    public async doAppPromotions(data: any) { }

    private findAllWithOfferId(data: any, results: any[] = []): any[] {
        if (!data) return results
        if (Array.isArray(data)) {
            for (const item of data) {
                this.findAllWithOfferId(item, results)
            }
        } else if (typeof data === 'object') {
            if (data.offerId && data.destination) {
                results.push(data)
            }
            for (const key in data) {
                this.findAllWithOfferId(data[key], results)
            }
        }
        return results
    }

    protected async solveActivities(
        activities: any[],
        page: Page,
        punchCard?: PunchCard,
        context: 'dailySet' | 'morePromotions' | 'punchCard' | 'other' = 'other'
    ) {
        const isDailySetContext = context === 'dailySet'

        for (const activity of activities) {
            if (activity.isLocked) {
                this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Skipping locked: ${activity.title}`)
                continue
            }

            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Solving: ${activity.title}`)

            // For daily set, ensure the section is expanded before any navigation/search
            if (isDailySetContext) {
                await this.expandDailySetIfNeeded(page, context)
            }

            // Navigation logic
            try {
                const currentUrl = page.url()
                const isDailyActivity =
                    isDailySetContext ||
                    activity?.source === 'dailySet' ||
                    (activity?.title?.toLowerCase?.().includes('daily set') ?? false) ||
                    (activity?.name?.toLowerCase?.().includes('daily') ?? false)

                if (!isDailyActivity) {
                    if (!currentUrl.includes('/earn')) {
                        this.bot.logger.info(this.bot.isMobile, 'NAVIGATION', `NAVIGATING TO EARN PAGE FOR: ${activity.title}`)
                        await page.goto('https://rewards.bing.com/earn', {
                            waitUntil: 'domcontentloaded',
                            timeout: 15000
                        }).catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                        await this.bot.browser.utils.wakePage(page)
                    }
                } else {
                    if (!currentUrl.includes('rewards.bing.com') || currentUrl.includes('/earn')) {
                        await page.goto('https://rewards.bing.com/', {
                            waitUntil: 'networkidle',
                            timeout: 20000
                        }).catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                        await this.bot.browser.utils.wakePage(page)
                    }
                }
            } catch (navError) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'NAVIGATION',
                    `Navigation failed: ${navError instanceof Error ? navError.message : String(navError)}`
                )
            }

            try {
                const url = activity.destinationUrl ?? activity.destination

                if (url) {
                    const escapedTitle = activity.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

                    const selectors = [
                        `text=/.*${escapedTitle}.*/i`,
                        `text=/.*${escapedTitle}.*/i >> xpath=ancestor::*[self::button or self::a or @role="button" or @onclick or @tabindex][1]`,
                        `a[href*="${activity.offerId}"]`,
                        `a[data-bi-id*="${activity.offerId}"]`,
                        `*:text("${activity.title}")`,
                        `a[href*="${encodeURIComponent(url).substring(0, 15)}"]`
                    ]

                    let cardElement: any = null
                    const maxDashboardAttempts = 2

                    for (let dashboardAttempt = 1; dashboardAttempt <= maxDashboardAttempts; dashboardAttempt++) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Dashboard attempt ${dashboardAttempt}/${maxDashboardAttempts} for ${activity.title}`
                        )

                        await page.goto('https://rewards.bing.com/', {
                            waitUntil: 'networkidle',
                            timeout: 20000
                        }).catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                        await this.bot.browser.utils.wakePage(page)

                        // Re‑expand after page reload (important for daily set)
                        if (isDailySetContext) {
                            await this.expandDailySetIfNeeded(page, context)
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Starting incremental search for: ${activity.title}`
                        )

                        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { })
                        await this.bot.utils.wait(300)

                        const isDashboardPage = !page.url().includes('/earn')

                        for (let loopIteration = 0; loopIteration < 35; loopIteration++) {
                            // Check visible elements
                            for (const selector of selectors) {
                                try {
                                    const elements = page.locator(selector)
                                    const count = await elements.count()

                                    for (let i = 0; i < count; i++) {
                                        const el = elements.nth(i)

                                        const isInViewport = await el.evaluate((element: HTMLElement) => {
                                            const rect = element.getBoundingClientRect()
                                            return rect.top >= 0
                                                && rect.left >= 0
                                                && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight)
                                                && rect.right <= (window.innerWidth || document.documentElement.clientWidth)
                                        }).catch(() => false)

                                        if (isInViewport) {
                                            const text = await el.innerText().catch(() => '')
                                            const href = await el.getAttribute('href').catch(() => null)
                                            if (
                                                text.toLowerCase().includes(activity.title.toLowerCase()) ||
                                                (href && href.includes(activity.offerId))
                                            ) {
                                                cardElement = el
                                                this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `✅ Found card on iteration ${loopIteration}`)
                                                break
                                            }
                                        }
                                    }

                                    if (cardElement) break
                                } catch { }
                            }

                            if (cardElement) break

                            // Fallback expand inside scroll (in case something collapsed it)
                            if (isDashboardPage && isDailySetContext) {
                                await this.expandDailySetIfNeeded(page, context)

                                for (const selector of selectors) {
                                    try {
                                        const elements = page.locator(selector)
                                        const count = await elements.count()

                                        for (let i = 0; i < count; i++) {
                                            const el = elements.nth(i)

                                            const isInViewport = await el.evaluate((element: HTMLElement) => {
                                                const rect = element.getBoundingClientRect()
                                                return rect.top >= 0
                                                    && rect.left >= 0
                                                    && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight)
                                            }).catch(() => false)

                                            if (isInViewport) {
                                                const text = await el.innerText().catch(() => '')
                                                if (text.toLowerCase().includes(activity.title.toLowerCase())) {
                                                    cardElement = el
                                                    this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', '✅ Found card inside expanded Daily Set!')
                                                    break
                                                }
                                            }
                                        }

                                        if (cardElement) break
                                    } catch { }
                                }

                                if (cardElement) break
                            }

                            await page.evaluate(() => window.scrollBy({
                                top: 65,
                                left: 0,
                                behavior: 'smooth'
                            })).catch(() => { })

                            await this.bot.utils.wait(500)
                        }

                        if (!cardElement) {
                            this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Completed full search loop, card not found`)
                        }

                        if (cardElement) break

                        if (dashboardAttempt < maxDashboardAttempts) {
                            this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Card not found, refreshing dashboard`)
                            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { })
                            await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                            await this.bot.browser.utils.wakePage(page)
                        }
                    }

                    if (cardElement) {
                        this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Card found for: ${activity.title}`)

                        await cardElement.scrollIntoViewIfNeeded().catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

                        if (!this.bot.isMobile) {
                            await this.bot.utils.wait(this.bot.utils.humanHoverDelay())
                            await cardElement.hover().catch(() => { })
                            await this.bot.utils.wait(500)

                            await page
                                .evaluate(
                                    (sel: any) => {
                                        const el = document.querySelector(sel)
                                        if (el) {
                                            ;['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(evt => {
                                                el.dispatchEvent(
                                                    new MouseEvent(evt, {
                                                        bubbles: true,
                                                        cancelable: true,
                                                        view: window
                                                    })
                                                )
                                            })
                                        }
                                    },
                                    (cardElement as any)._selector
                                )
                                .catch(() => { })
                        }

                        await this.bot.utils.wait(this.bot.utils.humanClickDelay())

                        const [newPage] = await Promise.all([
                            page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
                            cardElement.click({ delay: this.bot.utils.randomDelay(200, 500) }).catch(() => {
                                return page.evaluate(targetUrl => {
                                    window.open(targetUrl, '_blank')
                                }, url)
                            })
                        ])

                        if (newPage) {
                            await newPage.waitForLoadState('domcontentloaded').catch(() => { })
                            await this.bot.utils.wait(this.bot.utils.humanNavigationDelay())
                            this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `New tab opened for: ${activity.title}`)

                            const pageUrl = newPage.url()
                            if (
                                pageUrl.includes('bing.com') &&
                                (
                                    activity.title.toLowerCase().includes('search on bing') ||
                                    activity.title.toLowerCase().includes('explore on bing') ||
                                    activity.title.toLowerCase().includes('search bing')
                                )
                            ) {
                                try {
                                    const { SearchOnBing } = await import('./activities/browser/SearchOnBing.js')
                                    const searchOnBing = new SearchOnBing(this.bot)
                                    await searchOnBing.doSearchOnBing(activity, newPage)
                                } catch (searchError) {
                                    this.bot.logger.warn(
                                        this.bot.isMobile,
                                        'SEARCH-ON-BING',
                                        `Failed to handle search activity: ${searchError instanceof Error ? searchError.message : String(searchError)}`
                                    )
                                }
                            } else {
                                if (this.bot.rewardsVersion === 'modern') {
                                    await this.completeActivity(activity, newPage)
                                }
                            }

                            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
                            await newPage.close().catch(() => { })
                        } else {
                            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
                        }
                    } else {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Card NOT found on dashboard for: ${activity.title}. Navigating directly.`
                        )
                        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanNavigationDelay())

                        if (this.bot.rewardsVersion === 'modern') {
                            await this.completeActivity(activity, page)
                        }

                        await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
                    }
                }

                this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Finished attempt for: ${activity.title}`)
            } catch {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Failed: ${activity.title}`)
            }
        }
    }

    public async doSpecialPromotions(data: DashboardData) { }
    public async doPunchCards(data: DashboardData, page: Page) { }

    protected async expandDailySetIfNeeded(
        page: Page,
        context: 'dailySet' | 'morePromotions' | 'punchCard' | 'other' = 'other'
    ): Promise<void> {
        if (context !== 'dailySet') return

        try {
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Trying simple Daily Set expand...')

            const expandButton = page.locator(
                'button[aria-label="Daily set"][aria-expanded="false"]:has(svg)'
            ).first()

            const exists = await expandButton.count()

            if (exists === 0) {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Expand button not found or already expanded')
                return
            }

            const isVisible = await expandButton.isVisible().catch(() => false)
            if (!isVisible) {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Expand button not visible')
                return
            }

            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Clicking Daily Set expand button')

            await expandButton.scrollIntoViewIfNeeded().catch(() => { })
            await this.bot.utils.wait(200)

            await expandButton.click({ delay: this.bot.isMobile ? 150 : 50 }).catch(() => { })

            await this.bot.utils.wait(1000)

            // Optional verification (lightweight)
            const expanded = await expandButton.getAttribute('aria-expanded').catch(() => null)

            if (expanded === 'true') {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', '✅ Daily Set expanded')
            } else {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Expand click sent, no state change detected')
            }

        } catch (e) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-SET',
                `Expand failed: ${e instanceof Error ? e.message : String(e)}`
            )
        }
    }
    public async claimReadyPoints(page: Page): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', 'Trying to open Ready to claim card')

            const readyText = page.getByText('Ready to claim').first()

            if (await readyText.count() === 0) {
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', 'No Ready to claim card found')
                return
            }

            // Step 1: Click the card
            await readyText.click().catch(() => { })
            await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

            // Step 2: Look specifically for "Claim points" button
            const claimBtn = page.getByText(/^claim points$/i)

            if (await claimBtn.count() === 0) {
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', 'No "Claim points" button found (probably 0 points)')

                // Close popup if possible
                await page.goBack().catch(() => { })
                return
            }

            this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', '"Claim points" button found, attempting to claim...')

            // Step 3: Click it
            await claimBtn.click().catch(() => { })
            await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

            this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', 'Claim attempt finished', 'green')

        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-POINTS',
                `Claim skipped: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
    private async completeActivity(activity: any, page: Page): Promise<boolean> {
        const offerId = activity.offerId

        if (!offerId) {
            this.bot.logger.warn(this.bot.isMobile, 'ACTIVITY', 'No offerId found')
            return false
        }

        this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Completing: ${activity.title} (${offerId})`)

        try {
            const url = activity.destination || activity.destinationUrl
            if (url) {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { })
                await this.bot.utils.wait(3000)

                const pageText = await page.innerText('body').catch(() => '')

                if (pageText.toLowerCase().includes('quiz') || pageText.toLowerCase().includes('poll')) {
                    this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', 'Detected quiz/poll, attempting interaction')
                    await page.click('button, [role="button"]', { timeout: 2000 }).catch(() => { })
                    await this.bot.utils.wait(2000)
                }

                const panelData = this.bot.panelData
                const todayKey = this.bot.utils.getFormattedDate()

                const userInfo = (panelData as any)?.userInfo
                const panelPromotion =
                    userInfo?.promotions?.find((p: any) => p.offerId === offerId || p.name === offerId) ||
                    panelData?.flyoutResult?.dailySetPromotions?.[todayKey]?.find((p: any) => p.offerId === offerId) ||
                    panelData?.flyoutResult?.morePromotions?.find((p: any) => p.offerId === offerId)

                const jsonData = {
                    ActivityCount: 1,
                    ActivityType: panelPromotion?.activityType ?? activity.activityType ?? 0,
                    ActivitySubType: '',
                    OfferId: offerId,
                    AuthKey: panelPromotion?.hash ?? activity.hash ?? '',
                    Channel: panelData?.channel ?? 'BingRewards',
                    PartnerId: panelData?.partnerId ?? 'BingRewards',
                    UserId: panelData?.userId ?? ''
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Calling reportActivity API | offerId=${offerId} | ActivityType=${jsonData.ActivityType}`
                )

                const context = page.context() as any
                const cookies = await context.cookies()
                const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ')

                const request: any = {
                    url: 'https://www.bing.com/msrewards/api/v1/reportactivity',
                    method: 'POST',
                    headers: {
                        ...(this.bot.fingerprint?.headers ?? {}),
                        Cookie: cookieHeader,
                        'Content-Type': 'application/json',
                        Origin: 'https://www.bing.com',
                        Referer: url
                    },
                    data: JSON.stringify(jsonData)
                }

                try {
                    const response = await this.bot.axios.request(request)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'ACTIVITY',
                        `reportActivity response | offerId=${offerId} | status=${response.status}`
                    )
                } catch (apiError) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'ACTIVITY',
                        `reportActivity API call failed | offerId=${offerId} | error=${apiError instanceof Error ? apiError.message : String(apiError)}`
                    )
                }

                this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Completed: ${activity.title}`, 'green')
                return true
            }

            // No URL - try API
            const panelData = this.bot.panelData
            const todayKey = this.bot.utils.getFormattedDate()

            const panelPromotion =
                panelData?.flyoutResult?.morePromotions?.find(p => p.offerId === offerId) ||
                panelData?.flyoutResult?.dailySetPromotions?.[todayKey]?.find(p => p.offerId === offerId)

            const formData = new URLSearchParams({
                id: offerId,
                hash: activity.hash || panelPromotion?.hash || '',
                timeZone: '60',
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: '',
                __RequestVerificationToken: ''
            })

            const context = page.context() as any
            const cookies = await context.cookies()
            const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ')

            const request: any = {
                url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                method: 'POST',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                data: formData.toString()
            }

            const response = await this.bot.axios.request(request)

            if (response.status === 200) {
                const result = response.data
                const earnedCredits = result?.EarnedCredits || result?.earnedCredits || 0
                const activityComplete = result?.ActivityComplete || result?.activityComplete || false
                const errorCode = result?.ErrorDetail?.ErrorCode || result?.errorDetail?.errorCode
                const v3ResultCode = result?.result?.resultCode ?? result?.resultCode

                if (
                    activityComplete ||
                    earnedCredits > 0 ||
                    errorCode === 'I_SUCCESS' ||
                    errorCode === 0 ||
                    v3ResultCode === 0
                ) {
                    if (earnedCredits > 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'CLAIM POINTS',
                            `Found ${earnedCredits} points`,
                            'green'
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'CLAIM POINTS',
                            `Claimed ${earnedCredits} points for: ${activity.title}`,
                            'green'
                        )
                    } else {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'CLAIM POINTS',
                            `Completed: ${activity.title} | No points awarded`,
                            'yellow'
                        )
                    }
                    return true
                }
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVITY',
                `API returned status ${response.status} for: ${activity.title}`
            )
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM POINTS',
                `Not available on this account: ${activity.title}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'ACTIVITY',
                `Failed to complete: ${activity.title} - ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }
}