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
                const earnHtml = await page.content()
                const earnNextData = this.bot.nextParser.parse(earnHtml)
                if (earnNextData.length > 0) {
                    earnPageData = earnNextData
                    this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Fetched additional data from /earn page')
                }
            } catch (e) {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Could not fetch /earn page data')
            }

            // Combine both sources of data
            const combinedData = earnPageData ? [...v4Data, ...earnPageData] : v4Data

            // Get today's date in MM/DD/YYYY format (matching V4 API format)
            const today = new Date()
            const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`

            // Filter by today's date and uncompleted status
            const dailySetItems = this.bot.nextParser.find(combinedData, 'dailySetItems') ?? []
            const todayItems = dailySetItems.filter((x: any) => x.date === todayStr)
            const uncompleted = todayItems.filter((x: any) => !x.isCompleted && x.points > 0)

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-SET',
                `Date: ${todayStr}, Found ${dailySetItems.length} total items, ${todayItems.length} for today, ${uncompleted.length} uncompleted`
            )

            // If no items from /earn page, also check all items (not just today)
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
                    await this.solveActivities(mapped, page)
                    return
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-SET',
                `Date: ${todayStr}, Found ${dailySetItems.length} total items, ${todayItems.length} for today, ${uncompleted.length} uncompleted`
            )

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
                await this.solveActivities(mapped, page)
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
            await this.solveActivities(activitiesUncompleted, page)
        }
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        // V4 MODERN UI LOGIC
        if (this.bot.rewardsVersion === 'modern' && (data as any).v4Data) {
            this.bot.logger.debug(this.bot.isMobile, 'MORE-PROMOTIONS', 'Using Modern UI (V4) detection logic')
            let v4Data = (data as any).v4Data

            // Also try to get data from /earn page for "Keep earning" activities
            let earnPageData = null
            try {
                await page
                    .goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 15000 })
                    .catch(() => { })
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
            } catch (e) {
                this.bot.logger.debug(this.bot.isMobile, 'MORE-PROMOTIONS', 'Could not fetch /earn page data')
            }

            // Combine both sources of data
            const combinedData = earnPageData ? [...v4Data, ...earnPageData] : v4Data

            // Debug: Find ALL objects with offerId
            const allWithOfferId = this.findAllWithOfferId(combinedData)
            this.bot.logger.debug(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                `Found ${allWithOfferId.length} items with offerId in Next.js data`
            )

            // Try multiple keys
            let moreActivities = this.bot.nextParser.find(combinedData, 'moreActivities') ?? []
            if (!moreActivities.length) {
                // Try alternative keys
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

            // Get morePromotions from panel flyout data (contains "Do you know the answer?" etc)
            // Note: API response structure - check both userInfo.promotions and flyoutResult.morePromotions
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

            // Try multiple sources for morePromotions
            let panelFlyoutPromos: any[] = []

            // Try flyoutResult.morePromotions (original path)
            if (panelDataRaw?.flyoutResult?.morePromotions) {
                panelFlyoutPromos = panelDataRaw.flyoutResult.morePromotions
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Found ${panelFlyoutPromos.length} items in flyoutResult.morePromotions`
                )
            }

            // Also try userInfo.promotions (contains "Do you know the answer?" and other activities)
            // Combine with flyoutResult.morePromotions
            if (userInfoData?.promotions) {
                const userInfoPromos = userInfoData.promotions

                // Transform userInfo.promotions to match expected format
                // Structure: { name, attributes: { offerid, title, complete, max, destination } }
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

                // Combine both arrays, avoiding duplicates by offerId
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

            // Map moreActivities to same format
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

            // Combine both sources
            const allUncompleted = [...mappedMoreActivities, ...panelUncompleted]

            if (allUncompleted.length) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'MORE-PROMOTIONS',
                    `Solving ${allUncompleted.length} modern items`
                )
                await this.solveActivities(allUncompleted, page)
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
            await this.solveActivities(activitiesUncompleted as any, page)
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

    protected async solveActivities(activities: any[], page: Page, punchCard?: PunchCard) {
        // ✅ ✅ ✅ FIXED ORDER: NAVIGATE FIRST BEFORE ANYTHING ELSE ✅ ✅ ✅

        for (const activity of activities) {
            // Skip locked activities
            if (activity.isLocked) {
                this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Skipping locked: ${activity.title}`)
                continue
            }

            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Solving: ${activity.title}`)

            // ✅ NAVIGATE FIRST BEFORE ANY SCROLLING / CARD SEARCHING
            try {
                const isDailyActivity = activity.title.toLowerCase().includes('daily') || (activity?.name?.toLowerCase() || '').includes('daily')

                if (!isDailyActivity) {
                    // ALWAYS go to earn page for non-daily activities FIRST
                    if (!page.url().includes('/earn')) {
                        this.bot.logger.info(this.bot.isMobile, 'NAVIGATION', `NAVIGATING TO EARN PAGE FOR: ${activity.title}`)

                        // Direct navigation instead of clicking tab (more reliable)
                        await page.goto('https://rewards.bing.com/earn', {
                            waitUntil: 'domcontentloaded',
                            timeout: 15000
                        }).catch(() => { })

                        await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                    }
                } else {
                    // For daily activities stay on dashboard
                    if (!page.url().includes('rewards.bing.com') || page.url().includes('/earn')) {
                        await page.goto('https://rewards.bing.com/', {
                            waitUntil: 'networkidle',
                            timeout: 20000
                        }).catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                    }

                    // ✅ Auto expand Daily set if it's collapsed
                    try {
                        const dailySetContainer = page.locator(':text("Daily set")').locator('..')
                        if (await dailySetContainer.count() > 0) {
                            const collapsedArrow = dailySetContainer.locator('svg[viewBox*="0 0 20 20"]:has(path[d*="M6 8l4 4 4-4"]), button:has(svg[style*="rotate(180deg)"])')
                            if (await collapsedArrow.count() > 0) {
                                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Daily set is collapsed, expanding...')
                                await collapsedArrow.click({ timeout: 2000 }).catch(() => { })
                                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
                            }
                        }
                    } catch (expandError) {
                        this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', `Expand handler skipped: ${expandError instanceof Error ? expandError.message : String(expandError)}`)
                    }
                }
            } catch (navError) {
                this.bot.logger.warn(this.bot.isMobile, 'NAVIGATION', `Navigation failed: ${navError instanceof Error ? navError.message : String(navError)}`)
            }

            try {
                const url = activity.destinationUrl ?? activity.destination

                if (url) {
                    // Optimized Desktop V4 Selectors
                    const selectors = [
                        // ✅ ✅ ✅ FIRST PRIORITY: CLICK DIRECTLY ON THE TEXT ELEMENT ✅ ✅ ✅
                        // Finds ANY element (p, span, div, anything) that contains the activity title text
                        // Case insensitive, partial match - clicks exactly where the text is on screen
                        `text=/.*${activity.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*/i`,

                        // Then try closest clickable parent as fallback
                        `text=/.*${activity.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*/i >> xpath=ancestor::*[self::button or self::a or @role="button" or @onclick or @tabindex][1]`,

                        // Original selectors fallbacks
                        `a[href*="${activity.offerId}"]`,
                        `a[data-bi-id*="${activity.offerId}"]`,
                        `*:text("${activity.title}")`,
                        `a[href*="${encodeURIComponent(url).substring(0, 15)}"]`
                    ]

                    // ✅ 3 ITERATION DASHBOARD RETRY LOOP
                    let cardElement = null
                    const maxDashboardAttempts = 3

                    for (let dashboardAttempt = 1; dashboardAttempt <= maxDashboardAttempts; dashboardAttempt++) {

                        // Always go back to dashboard first on each attempt
                        this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Dashboard attempt ${dashboardAttempt}/${maxDashboardAttempts} for ${activity.title}`)

                        await page.goto('https://rewards.bing.com/', {
                            waitUntil: 'networkidle',
                            timeout: 20000
                        }).catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())

                        // ✅ NEW HUMAN-LIKE INCREMENTAL SCROLL + CHECK LOOP ✅
                        this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Starting incremental search for: ${activity.title}`)

                        // Start at absolute top of page
                        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { })
                        await this.bot.utils.wait(300)

                        const isDashboardPage = page.url() === 'https://rewards.bing.com/' || !page.url().includes('/earn')

                        // Loop: Check -> Expand (if needed) -> Check -> Scroll small amount
                        for (let loopIteration = 0; loopIteration < 35; loopIteration++) {

                            // 🔍 FIRST: Check if target is already visible RIGHT NOW
                            for (const selector of selectors) {
                                try {
                                    const elements = page.locator(selector)
                                    const count = await elements.count()
                                    for (let i = 0; i < count; i++) {
                                        const el = elements.nth(i)

                                        // ✅ Check if element is actually in viewport before clicking
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

                            // 📅 ONLY ON DASHBOARD: Check for Daily Set toggle and expand if collapsed
                            if (isDashboardPage) {
                                // ✅ Use proper geometric targeting expand method
                                await this.expandDailySetIfNeeded(page)

                                // ✅ ALWAYS re-check for target card AFTER attempting expand
                                // This catches cards that were just revealed when Daily Set opened
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
                                                    this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `✅ Found card inside expanded Daily Set!`)
                                                    break
                                                }
                                            }
                                        }
                                        if (cardElement) break
                                    } catch { }
                                }

                                if (cardElement) break
                            }

                            // 📜 Scroll down ONLY 65px (very small human-like increment)
                            await page.evaluate(() => window.scrollBy({
                                top: 65,
                                left: 0,
                                behavior: 'smooth'
                            })).catch(() => { })

                            // ⏱️ Wait for elements to render and lazy load
                            await this.bot.utils.wait(500)
                        }

                        if (!cardElement) {
                            this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Completed full search loop, card not found`)
                        }

                        if (cardElement) break

                        // Refresh page before next attempt (unless last attempt)
                        if (dashboardAttempt < maxDashboardAttempts) {
                            this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Card not found, refreshing dashboard`)
                            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { })
                            await this.bot.utils.wait(this.bot.utils.humanPageLoadDelay())
                        }
                    }

                    if (cardElement) {
                        this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Card found for: ${activity.title}`)

                        await cardElement.scrollIntoViewIfNeeded().catch(() => { })
                        await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

                        // DESKTOP SPECIFIC: Trigger human-like events
                        if (!this.bot.isMobile) {
                            await this.bot.utils.wait(this.bot.utils.humanHoverDelay())
                            await cardElement.hover().catch(() => { })
                            await this.bot.utils.wait(500)

                            // Manually dispatch events
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
                            page
                                .context()
                                .waitForEvent('page', { timeout: 10000 })
                                .catch(() => null),
                            cardElement.click({ delay: this.bot.utils.randomDelay(200, 500) }).catch(() => {
                                return page.evaluate(targetUrl => {
                                    window.open(targetUrl, '_blank')
                                }, url)
                            })
                        ])

                        if (newPage) {
                            await newPage.waitForLoadState('domcontentloaded').catch(() => { })
                            await this.bot.utils.wait(this.bot.utils.humanNavigationDelay())
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `New tab opened for: ${activity.title}`
                            )

                            // ✅ Handle SearchOnBing / Explore on Bing activities
                            const pageUrl = newPage.url()
                            if (pageUrl.includes('bing.com') && (
                                activity.title.toLowerCase().includes('search on bing') ||
                                activity.title.toLowerCase().includes('explore on bing') ||
                                activity.title.toLowerCase().includes('search bing')
                            )) {
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
                                // Try to complete via API for V4 (even without hash, try using panel data)
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

                        // Try to complete via API for V4 (even without hash, try using panel data)
                        if (this.bot.rewardsVersion === 'modern') {
                            await this.completeActivity(activity, page)
                        }

                        await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
                    }
                }

                this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Finished attempt for: ${activity.title}`)
            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Failed: ${activity.title}`)
            }
        }
    }

    public async doSpecialPromotions(data: DashboardData) { }
    public async doPunchCards(data: DashboardData, page: Page) { }

    /**
     * Expand Daily Set section - Using Playwright locators (not native DOM selectors)
     */
    /**
     * Expand Daily Set section - Targeting icon buttons and aria-labels directly
     */
    protected async expandDailySetIfNeeded(page: Page): Promise<void> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Scanning for Daily Set expand button...')

            // ✅ Ensure we're at the top of the page (optional, but safe for consistency)
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { })
            await this.bot.utils.wait(this.bot.isMobile ? 1000 : 600)

            // ✅ STRATEGY 1: Direct targeting by aria-label and expanded state
            // Matches: aria-label="Daily set" (case insensitive) AND aria-expanded="false"
            const directButton = page.locator('button[aria-label="Daily set" i][aria-expanded="false"]').first()

            if (await directButton.count() > 0 && await directButton.isVisible().catch(() => false)) {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Found button via direct aria-label match!')
                await this.clickButton(page, directButton)
                return
            }

            // ✅ STRATEGY 2: Find button with SVG inside that is collapsed
            // This catches the chevron button even if aria-label varies slightly
            const svgButtons = page.locator('button:has(svg)[aria-expanded="false"]')
            const svgCount = await svgButtons.count()

            if (svgCount > 0) {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', `Found ${svgCount} collapsed buttons with SVGs. Filtering by proximity to "Daily set".`)

                // Get bounding box of "Daily set" text to use as reference
                const headerBox = await page.locator(':has-text("Daily set")').first().boundingBox().catch(() => null)

                let bestButton: any = null
                let minDistance = 99999

                for (let i = 0; i < svgCount; i++) {
                    const btn = svgButtons.nth(i)
                    if (!(await btn.isVisible().catch(() => false))) continue

                    const box = await btn.boundingBox().catch(() => null)
                    if (!box) continue

                    // If we have a header reference, calculate distance
                    if (headerBox) {
                        const dist = Math.hypot(
                            (box.x + box.width / 2) - (headerBox.x + headerBox.width / 2),
                            (box.y + box.height / 2) - (headerBox.y + headerBox.height / 2)
                        )

                        // Prioritize buttons close to the header (within 200px)
                        if (dist < 200 && dist < minDistance) {
                            minDistance = dist
                            bestButton = btn
                        }
                    } else {
                        // Fallback: if no header found, just take the first visible SVG button
                        bestButton = btn
                        break
                    }
                }

                if (bestButton) {
                    this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Found button via SVG + Proximity match!')
                await this.clickButton(page, bestButton)
                    return
                }
            }

            // ✅ STRATEGY 3: Broad search for any collapsed button near "Daily set"
            // Checks all buttons on page, filters by text/label and position
            const allCollapsed = page.locator('button[aria-expanded="false"]')
            const totalCount = await allCollapsed.count()

            if (totalCount > 0) {
                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', `Checking ${totalCount} collapsed buttons...`)

                const headerBox = await page.locator(':has-text("Daily set")').first().boundingBox().catch(() => null)

                // We look for a button that is on the same line as "Daily set"
                // We iterate backwards to find the right-most one first (often the chevron)
                for (let i = totalCount - 1; i >= 0; i--) {
                    const btn = allCollapsed.nth(i)
                    if (!(await btn.isVisible().catch(() => false))) continue

                    const box = await btn.boundingBox().catch(() => null)
                    if (!box) continue

                    // Check Y-alignment with "Daily set" header
                    if (headerBox) {
                        const yDiff = Math.abs(box.y - headerBox.y)
                        if (yDiff < 50) { // Same row
                            // Check if it's NOT "See more tasks"
                            const btnText = await btn.innerText().catch(() => '')
                            const btnLabel = await btn.getAttribute('aria-label').catch(() => '')

                            if (!btnText.includes('See more') && !(btnLabel || '').includes('See more')) {
                                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Found button via Broad Y-alignment search!')
                await this.clickButton(page, btn)
                                return
                            }
                        }
                    }
                }
            }

            this.bot.logger.warn(this.bot.isMobile, 'DAILY-SET', 'No valid expand button found.')

        } catch (e) {
            this.bot.logger.error(this.bot.isMobile, 'DAILY-SET', `Expand failed: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    /**
     * Helper to click and verify
     */
    private async clickButton(page: Page, locator: any): Promise<void> {
        try {
            const box = await locator.boundingBox()
            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
                await this.bot.utils.wait(50)
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: this.bot.isMobile ? 150 : 50 })

                this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Click sent.')
                await this.bot.utils.wait(1500) // Wait for animation

                // Verify
                const itemsVisible = await page.locator(':has-text("Daily set") >> a, :has-text("Daily set") >> [role="listitem"]').count().catch(() => 0)
                if (itemsVisible > 0) {
                    this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', '✅ Daily Set items visible', 'green')
                } else {
                    this.bot.logger.debug(this.bot.isMobile, 'DAILY-SET', 'Clicked button, checking for content...')
                }
            }
        } catch (e) {
            this.bot.logger.error(this.bot.isMobile, 'DAILY-SET', `Click failed: ${e}`)
        }
    }

    public async claimReadyPoints(page: Page): Promise<void> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'CLAIM-POINTS', 'Checking Ready to claim widget')

            // Check if widget exists on page
            const widgetExists = await page.locator(':text("Ready to claim")').count() > 0

            if (!widgetExists) {
                this.bot.logger.debug(this.bot.isMobile, 'CLAIM-POINTS', 'Ready to claim widget does NOT exist on dashboard')
                return
            }

            // Get points value
            const pointsText = await page.locator(':text("Ready to claim") ~ div span, :text("Ready to claim") + div span').innerText().catch(() => '0')
            const points = parseInt(pointsText.trim()) || 0

            if (points <= 0) {
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', `Ready to claim widget shows ${points} points, nothing to collect`)
                return
            }

            this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', `Ready to claim widget found, ${points} points available`)

            // Click claim button
            const claimButton = page.locator('button:text("Claim"), div[role="button"]:text("Claim")')
            if (await claimButton.count() > 0) {
                await claimButton.click({ timeout: 3000 }).catch(() => { })
                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-POINTS', `Successfully claimed ${points} points`, 'green')
            }

        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'CLAIM-POINTS', `Claim skipped: ${error instanceof Error ? error.message : String(error)}`)
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
                // For URL activities, visit the page first
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { })

                // Wait for page to load and any potential auto-complete
                await this.bot.utils.wait(3000)

                // Check if it's a quiz/poll that needs interaction
                const pageText = await page.innerText('body').catch(() => '')

                // If it's a quiz/poll, try to find and click answers (basic)
                if (pageText.toLowerCase().includes('quiz') || pageText.toLowerCase().includes('poll')) {
                    this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', 'Detected quiz/poll, attempting interaction')
                    // Try clicking common quiz buttons
                    await page.click('button, [role="button"]', { timeout: 2000 }).catch(() => { })
                    await this.bot.utils.wait(2000)
                }

                // Now call the API to report completion
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

            // Try desktop API endpoint (form data) - works for URL activities
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

                // Check for V3/V4 success format
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
