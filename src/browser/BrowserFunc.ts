// src/functions/BrowserFunc.ts
import https from 'https'
import { BrowserContext, Page } from 'rebrowser-playwright'
import { CheerioAPI, load } from 'cheerio'
import { AxiosRequestConfig } from 'axios'
import * as fs from 'fs/promises'
import * as path from 'path'

import { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'

import { Counters, DashboardData, MorePromotion, PromotionalItem } from './../interface/DashboardData'
import { QuizData } from './../interface/QuizData'
import { AppUserData } from '../interface/AppUserData'
import { EarnablePoints } from '../interface/Points'


export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Helper: quiet randomized delay between 30-45 seconds to reduce race/timeout issues.
     */
    private async quietDelay() {
        const ms = 3000 + Math.floor(Math.random() * 1500) // 30,000 - 45,000 ms
        if (this.bot && this.bot.utils && typeof (this.bot.utils as any).wait === 'function') {
            await (this.bot.utils as any).wait(ms)
        } else {
            await new Promise(resolve => setTimeout(resolve, ms))
        }
    }

    /**
     * Navigate the provided page to rewards homepage
     * @param {Page} page Playwright page
     */
    async goHome(page: Page) {

        try {
            const dashboardURL = new URL(this.bot.config.baseURL)

            if (page.url() === dashboardURL.href) {
                return
            }

            await page.goto(this.bot.config.baseURL)

            // slight randomized delay after navigation
            await this.quietDelay()

            const maxIterations = 5 // Maximum iterations set to 5

            for (let iteration = 1; iteration <= maxIterations; iteration++) {
                await this.bot.utils.wait(3000)
                await this.bot.browser.utils.tryDismissAllMessages(page)

                // Check if account is suspended (multiple heuristics)
                const suspendedByHeader = await page.waitForSelector('#suspendedAccountHeader', { state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)
                let suspendedByText = false
                if (!suspendedByHeader) {
                    try {
                        const text = (await page.textContent('body')) || ''
                        suspendedByText = /account has been suspended|suspended due to unusual activity/i.test(text)
                    } catch { /* ignore */ }
                }
                if (suspendedByHeader || suspendedByText) {
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'This account appears suspended!', 'error')
                    throw new Error('Account has been suspended!')
                }

                try {
                    // If activities are found, exit the loop
                    await page.waitForSelector('#more-activities', { timeout: 120000 })
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'Visited homepage successfully')
                    break

                } catch (error) {
                    // Continue if element is not found
                }

                // Below runs if the homepage was unable to be visited
                const currentURL = new URL(page.url())

                if (currentURL.hostname !== dashboardURL.hostname) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

                    await this.bot.utils.wait(2000)
                    await page.goto(this.bot.config.baseURL)
                    // small delay after re-navigation
                    await this.quietDelay()
                } else {
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'Visited homepage successfully')
                    break
                }

                await this.bot.utils.wait(5000)
            }

        } catch (error) {
            // Log and rethrow a real Error so callers don't receive `undefined`
            this.bot.log(this.bot.isMobile, 'GO-HOME', 'An error occurred:' + error, 'error')
            throw new Error('GO-HOME error: ' + error)
        }
    }

    /**
     * Fetch user dashboard data
     * This is defensive: tries direct globals, script regexes and full-html scans.
     * Accepts optional page parameter (defaults to this.bot.homePage).
     * @returns {DashboardData} Object of user bing rewards dashboard data
     */
    async getDashboardData(page?: Page): Promise<DashboardData> {
        const target = page ?? this.bot.homePage
        const dashboardURL = new URL(this.bot.config.baseURL)
        const currentURL = new URL(target.url())

        try {
            // Should never happen since tasks are opened in a new tab!
            if (currentURL.hostname !== dashboardURL.hostname) {
                this.bot.log(this.bot.isMobile, 'DASHBOARD-DATA', 'Provided page did not equal dashboard page, redirecting to dashboard page')
                await this.goHome(target)
            }

            // Attempt reload with one retry (handles transient page/context issues)
            let lastError: unknown = null
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    await target.reload({ waitUntil: 'domcontentloaded' })
                    lastError = null
                    break
                } catch (re) {
                    lastError = re
                    const msg = (re instanceof Error ? re.message : String(re))
                    this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', `Reload failed attempt ${attempt}: ${msg}`, 'warn')
                    // If page/context closed => attempt a navigation fallback then bail
                    if (msg.includes('has been closed')) {
                        if (attempt === 1) {
                            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Page appears closed; trying one navigation fallback', 'warn')
                            try {
                                await this.goHome(target)
                            } catch {/* ignore */ }
                        } else {
                            break
                        }
                    }
                    if (attempt === 2 && lastError) throw lastError
                    await this.bot.utils.wait(1000)
                }
            }

            // slight randomized delay before extracting dashboard data
            await this.quietDelay()

            // Strategy 1: Try direct window globals first (fast and reliable if present)
            const globalDashboard = await target.evaluate(() => {
                try {
                    // @ts-ignore
                    const w: any = window
                    if (w?.dashboard) return w.dashboard
                    // some sites put it in window.__INITIAL_STATE__ or window.__STATE__
                    if (w?.__INITIAL_STATE__ && typeof w.__INITIAL_STATE__ === 'object') {
                        const s = w.__INITIAL_STATE__
                        if (s.dashboard) return s.dashboard
                        if (s?.userStatus && s?.dailySetPromotions) return s as any
                    }
                    if (w?.__STATE__ && typeof w.__STATE__ === 'object') {
                        const s = w.__STATE__
                        if (s.dashboard) return s.dashboard
                    }
                    return null
                } catch (e) {
                    return null
                }
            })

            if (globalDashboard) {
                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Found dashboard data via window global', 'log')
                return globalDashboard as DashboardData
            }

            // Strategy 2: Search scripts for common patterns (var dashboard = {...} or JSON containing "userStatus")
            const scriptsText: string[] = await target.$$eval('script', nodes => nodes.map(n => n.textContent || ''))

            // regex candidates (multi-line, non-greedy)
            const regexes: RegExp[] = [
                /var\s+dashboard\s*=\s*({[\s\S]*?});/m,
                /window\.dashboard\s*=\s*({[\s\S]*?});/m,
                /"userStatus"\s*:\s*({[\s\S]*?})/m, // find a JSON fragment containing "userStatus"
                /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/m,
                /var\s+initialState\s*=\s*({[\s\S]*?});/m
            ]

            for (const s of scriptsText) {
                if (!s) continue
                for (const rx of regexes) {
                    const m = rx.exec(s)
                    if (m && m[1]) {
                        // m[1] might be a snippet (not valid JSON) so try to parse defensively in page context where JSON.parse can run
                        try {
                            const parsed = await target.evaluate((text: string) => {
                                try {
                                    return JSON.parse(text)
                                } catch (e) {
                                    try {
                                        // eslint-disable-next-line @typescript-eslint/no-implied-eval
                                        const fn = new Function(`return (${text});`)
                                        return fn()
                                    } catch (ee) {
                                        return null
                                    }
                                }
                            }, m[1])

                            if (parsed) {
                                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Parsed dashboard data from script regex', 'log')
                                return parsed as DashboardData
                            }
                        } catch (e) {
                            // continue to other regexes
                        }
                    }
                }
            }

            // Strategy 3: As a last resort scan full HTML for a large JSON block mentioning "userStatus" or "dailySetPromotions"
            const html = await target.content()
            const fullRegex = /({[\s\S]{100,200000}?("userStatus"|"dailySetPromotions"|"availablePoints")[\s\S]{0,200000}?})/m
            const fullMatch = fullRegex.exec(html)
            if (fullMatch && fullMatch[1]) {
                try {
                    // attempt to parse in page context first (safer for non-strict JS objects)
                    const parsed = await target.evaluate((text: string) => {
                        try { return JSON.parse(text) } catch (e) {
                            try {
                                // eslint-disable-next-line @typescript-eslint/no-implied-eval
                                const fn = new Function(`return (${text});`)
                                return fn()
                            } catch (ee) {
                                return null
                            }
                        }
                    }, fullMatch[1])

                    if (parsed) {
                        this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Parsed dashboard by scanning full HTML', 'log')
                        return parsed as DashboardData
                    }
                } catch (e) {
                    // fallthrough
                }
            }

            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Dashboard data not found within script after multiple strategies', 'error')
            throw new Error('Dashboard data not found within script')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', `Error fetching dashboard data: ${error}`, 'error')
            throw new Error('GET-DASHBOARD-DATA error: ' + error)
        }

    }

    /**
     * Get search point counters
     * @returns {Counters} Object of search counter data
     */
    async getSearchPoints(): Promise<Counters> {
        const dashboardData = await this.getDashboardData() // Always fetch newest data

        return dashboardData.userStatus.counters
    }

    /**
     * Get total earnable points with web browser
     * @returns {number} Total earnable points
     */
    async getBrowserEarnablePoints(): Promise<EarnablePoints> {
        try {
            // small randomized delay to reduce rate/ordering issues
            await this.quietDelay()

            let desktopSearchPoints = 0
            let mobileSearchPoints = 0
            let dailySetPoints = 0
            let morePromotionsPoints = 0

            const data = await this.getDashboardData()

            // Desktop Search Points
            if (data.userStatus.counters.pcSearch?.length) {
                data.userStatus.counters.pcSearch.forEach(x => desktopSearchPoints += (x.pointProgressMax - x.pointProgress))
            }

            // Mobile Search Points
            if (data.userStatus.counters.mobileSearch?.length) {
                data.userStatus.counters.mobileSearch.forEach(x => mobileSearchPoints += (x.pointProgressMax - x.pointProgress))
            }

            // Daily Set (defensive access)
            try {
                const todayKey = this.bot.utils.getFormattedDate()
                const dayItems = (data.dailySetPromotions && data.dailySetPromotions[todayKey]) || []
                dayItems.forEach((x: any) => dailySetPoints += (x.pointProgressMax - x.pointProgress))
            } catch (_) { /* ignore */ }

            // More Promotions
            if (data.morePromotions?.length) {
                data.morePromotions.forEach((x: any) => {
                    // Only count points from supported activities
                    if (['quiz', 'urlreward'].includes(x.promotionType) && x.exclusiveLockedFeatureStatus !== 'locked') {
                        morePromotionsPoints += (x.pointProgressMax - x.pointProgress)
                    }
                })
            }

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-BROWSER-EARNABLE-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('GET-BROWSER-EARNABLE-POINTS error: ' + error)
        }
    }

    /**
     * Get total earnable points with mobile app
     * This returns { readToEarn, checkIn, totalEarnablePoints, fetchError? }
     */
    async getAppEarnablePoints(accessToken: string): Promise<{ readToEarn: number, checkIn: number, totalEarnablePoints: number, fetchError?: boolean }> {
        // This function now sets fetchError=true when network/parsing/certificate failures occur.
        try {
            // slight randomized delay before calling app API
            await this.quietDelay()

            const points = {
                readToEarn: 0,
                checkIn: 0,
                totalEarnablePoints: 0
            }

            const eligibleOffers = [
                'ENUS_readarticle3_30points',
                'Gamification_Sapphire_DailyCheckIn'
            ]

            const data = await this.getDashboardData()
            let geoLocale = data?.userProfile?.attributes?.country
            const useGeo = !!(this.bot?.config?.searchSettings?.useGeoLocaleQueries)
            geoLocale = (useGeo && typeof geoLocale === 'string' && geoLocale.length === 2) ? geoLocale.toLowerCase() : 'us'

            const userDataRequest: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'X-Rewards-Country': geoLocale,
                    'X-Rewards-Language': 'en'
                },
                // note: httpsAgent is added only on retry when a cert error is detected
            }

            // Try regular request first
            let userDataResponse: AppUserData | undefined
            try {
                userDataResponse = (await this.bot.axios.request(userDataRequest)).data as AppUserData
            } catch (err: any) {
                const msg = (err && (err.message || '')).toString().toLowerCase()
                const code = err && err.code

                const isCertError =
                    msg.includes('unable to verify the first certificate') ||
                    msg.includes('self signed certificate') ||
                    msg.includes('unable to get local issuer certificate') ||
                    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
                    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                    code === 'ERR_TLS_CERT_ALTNAME_INVALID'

                if (isCertError) {
                    this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'Certificate verification failed — retrying once with relaxed SSL (insecure).', 'warn')

                    const insecureRequest: AxiosRequestConfig = {
                        ...userDataRequest,
                        httpsAgent: new https.Agent({ rejectUnauthorized: false })
                    }

                    try {
                        userDataResponse = (await this.bot.axios.request(insecureRequest)).data as AppUserData
                        this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'Retry with relaxed SSL succeeded.', 'log')
                    } catch (retryErr) {
                        this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', `Retry with relaxed SSL failed: ${retryErr}`, 'error')
                        // Return fetchError so caller knows this was a fetch failure
                        return { ...points, fetchError: true }
                    }
                } else {
                    // Not a certificate error — log and return fetchError
                    this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', `Failed fetching user data: ${err}`, 'error')
                    return { ...points, fetchError: true }
                }
            }

            if (!userDataResponse || !userDataResponse.response) {
                this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'User data response missing or malformed', 'warn')
                return { ...points, fetchError: true }
            }

            const userData = userDataResponse.response
            const eligibleActivities = (userData.promotions || []).filter((x: any) => eligibleOffers.includes(x.attributes?.offerid ?? ''))

            for (const item of eligibleActivities) {
                if (item.attributes.type === 'msnreadearn') {
                    points.readToEarn = parseInt(item.attributes.pointmax ?? '') - parseInt(item.attributes.pointprogress ?? '')
                    break
                } else if (item.attributes.type === 'checkin') {
                    const checkInDay = parseInt(item.attributes.progress ?? '') % 7

                    if (checkInDay < 6 && (new Date()).getDate() != (new Date(item.attributes.last_updated ?? '')).getDate()) {
                        points.checkIn = parseInt(item.attributes['day_' + (checkInDay + 1) + '_points'] ?? '')
                    }
                    break
                }
            }

            points.totalEarnablePoints = points.readToEarn + points.checkIn

            return { ...points, fetchError: false }
        } catch (error) {
            // Log and return fetchError so caller can detect this case
            this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'An error occurred: ' + error, 'error')
            return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0, fetchError: true }
        }
    }

    /**
     * Get current point amount
     * @returns {number} Current total point amount
     */
    async getCurrentPoints(): Promise<number> {
        try {
            const data = await this.getDashboardData()

            return data.userStatus.availablePoints
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-CURRENT-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('GET-CURRENT-POINTS error: ' + error)
        }
    }

    /**
     * Parse quiz data from provided page (robust & multi-strategy)
     * - tries window globals, script regexes, application/ld+json, data-* attributes, iframe globals and full-HTML scan
     */
    async getQuizData(page: Page): Promise<QuizData> {
        try {
            // Wait briefly for the page / quiz UI to settle. Increase timeout if your environment is slow.
            try {
                await page.waitForSelector('body', { timeout: 80000 })
            } catch (e) {
                // continue — we'll still try to extract scripts even if the page is slow
            }

            // Small randomized delay to reduce race issues
            await this.quietDelay()

            // 1) Try direct access to typical global variable (fast & reliable if present)
            const directGlobal = await page.evaluate(() => {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const w: any = window as any
                    if (w?._w?.rewardsQuizRenderInfo) return w._w.rewardsQuizRenderInfo
                    if (w?.rewardsQuizRenderInfo) return w.rewardsQuizRenderInfo
                    if (w?.__INITIAL_STATE__ && typeof w.__INITIAL_STATE__ === 'object') {
                        const state = w.__INITIAL_STATE__
                        const candidates = ['rewardsQuizRenderInfo', 'quiz', 'quizData', 'rewardsQuiz']
                        for (const c of candidates) {
                            if (state[c]) return state[c]
                        }
                    }
                    if (w?.__STATE__ && typeof w.__STATE__ === 'object') {
                        const state = w.__STATE__
                        const candidates = ['rewardsQuizRenderInfo', 'quiz', 'quizData', 'rewardsQuiz']
                        for (const c of candidates) {
                            if (state[c]) return state[c]
                        }
                    }
                    return null
                } catch (err) {
                    return null
                }
            })

            if (directGlobal) {
                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Found quiz data from window global', 'log')
                return directGlobal as QuizData
            }

            // 2) Grab all scripts and try multiple regex patterns
            const scripts: string[] = await page.$$eval('script', nodes => nodes.map(n => n.textContent || ''))

            const regexes: RegExp[] = [
                /_w\.rewardsQuizRenderInfo\s*=\s*({[\s\S]*?});/m,
                /rewardsQuizRenderInfo\s*=\s*({[\s\S]*?});/m,
                /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/m,
                /var\s+quizData\s*=\s*({[\s\S]*?});/m,
                /window\.__DATA__\s*=\s*({[\s\S]*?});/m,
                /"rewardsQuizRenderInfo"\s*:\s*({[\s\S]*?})/m // sometimes embedded as json fragment
            ]

            for (const scriptText of scripts) {
                if (!scriptText) continue
                for (const rx of regexes) {
                    const m = rx.exec(scriptText)
                    if (m && m[1]) {
                        try {
                            // Parse inside page context for better compatibility
                            const parsed = await page.evaluate((text: string) => {
                                try { return JSON.parse(text) } catch (e) {
                                    try {
                                        // eslint-disable-next-line @typescript-eslint/no-implied-eval
                                        const fn = new Function(`return (${text});`)
                                        return fn()
                                    } catch (ee) {
                                        return null
                                    }
                                }
                            }, m[1])

                            if (parsed) {
                                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Found quiz data via script regex', 'log')
                                return parsed as QuizData
                            }
                        } catch (_err) {
                            // try cleaned variant: replace unquoted keys & single quotes (best-effort)
                            try {
                                const cleaned = m[1].replace(/(['"])?([a-z0-9A-Z_]+)\1\s*:/g, '"$2":').replace(/'/g, '"')
                                const parsed2 = await page.evaluate((text: string) => {
                                    try { return JSON.parse(text) } catch (e) {
                                        try {
                                            // eslint-disable-next-line @typescript-eslint/no-implied-eval
                                            const fn = new Function(`return (${text});`)
                                            return fn()
                                        } catch (ee) {
                                            return null
                                        }
                                    }
                                }, cleaned)
                                if (parsed2) {
                                    this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Parsed quiz JSON after cleaning', 'log')
                                    return parsed2 as QuizData
                                }
                            } catch (_) {
                                // continue searching other scripts/regex
                            }
                        }
                    }
                }
            }

            // 3) Check <script type="application/ld+json"> blocks (sometimes used for embedded JSON)
            const ldjson = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent || ''))
            for (const block of ldjson) {
                if (!block) continue
                try {
                    const obj = JSON.parse(block)
                    if (typeof obj === 'object' && (obj?.quiz || obj?.rewardsQuizRenderInfo || (Object.keys(obj).some(k => k.toLowerCase().includes('quiz'))))) {
                        this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Found quiz data in application/ld+json', 'log')
                        return (obj.quiz || obj.rewardsQuizRenderInfo || obj) as QuizData
                    }
                } catch (err) {
                    // ignore parse errors
                }
            }

            // 4) Search DOM data attributes on likely quiz containers
            const dataAttrJson = await page.$$eval('[data-quiz],[data-quiz-data],[data-rewards-quiz]', els =>
                els.map(e => (e.getAttribute('data-quiz') || e.getAttribute('data-quiz-data') || e.getAttribute('data-rewards-quiz')) || '').filter(Boolean)
            )
            for (const raw of dataAttrJson) {
                try {
                    const parsed = JSON.parse(raw)
                    this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Found quiz data in data-* attribute', 'log')
                    return parsed as QuizData
                } catch (e) { /* ignore */ }
            }

            // 5) As a last resort, scan the full HTML for JSON-looking blocks that mention "rewardsQuiz" or "quiz"
            const html = await page.content()
            const bigJsonRx = /({[\s\S]{20,20000}?("rewardsQuizRenderInfo"|"rewardsQuiz"|"quiz")[\s\S]{0,20000}?})/m
            const bigMatch = bigJsonRx.exec(html)
            if (bigMatch && bigMatch[1]) {
                try {
                    const parsed = await page.evaluate((text: string) => {
                        try { return JSON.parse(text) } catch (e) {
                            try {
                                // eslint-disable-next-line @typescript-eslint/no-implied-eval
                                const fn = new Function(`return (${text});`)
                                return fn()
                            } catch (ee) {
                                return null
                            }
                        }
                    }, bigMatch[1])

                    if (parsed) {
                        this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Parsed quiz data by scanning full HTML', 'log')
                        return parsed as QuizData
                    }
                } catch (e) {
                    try {
                        const cleaned = bigMatch[1].replace(/(['"])?([a-z0-9A-Z_]+)\1\s*:/g, '"$2":').replace(/'/g, '"')
                        const parsed2 = await page.evaluate((text: string) => {
                            try { return JSON.parse(text) } catch (e) {
                                try {
                                    const fn = new Function(`return (${text});`)
                                    return fn()
                                } catch (ee) {
                                    return null
                                }
                            }
                        }, cleaned)
                        if (parsed2) {
                            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Parsed quiz data after cleaning large HTML match', 'log')
                            return parsed2 as QuizData
                        }
                    } catch (_) {
                        // give up this strategy
                    }
                }
            }

            // 6) If still not found, check for iframes (some quizzes render in an iframe)
            const iframeSrcs = await page.$$eval('iframe', ifs => ifs.map(f => f.src || '').filter(Boolean))
            if (iframeSrcs.length) {
                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', `Found ${iframeSrcs.length} iframe(s) — attempting to inspect frames`, 'warn')
                try {
                    const frames = page.frames()
                    for (const f of frames) {
                        try {
                            // attempt same direct global read inside iframe
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const fGlobal = await f.evaluate(() => {
                                // @ts-ignore
                                const w: any = window
                                if (w?._w?.rewardsQuizRenderInfo) return w._w.rewardsQuizRenderInfo
                                if (w?.rewardsQuizRenderInfo) return w.rewardsQuizRenderInfo
                                return null
                            })
                            if (fGlobal) {
                                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Found quiz data inside iframe', 'log')
                                return fGlobal as QuizData
                            }
                        } catch (_) {
                            // ignore iframe evaluation errors (cross-origin etc.)
                        }
                    }
                } catch (_) {
                    // ignore
                }
            }

            // nothing found — give a clear error with helpful troubleshooting hints
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Script containing quiz data not found after multiple strategies', 'error')
            throw new Error('Script containing quiz data not found')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'An error occurred:' + error, 'error')
            throw new Error('GET-QUIZ-DATA error: ' + error)
        }
    }

    async waitForQuizRefresh(page: Page): Promise<boolean> {
        try {
            await page.waitForSelector('span.rqMCredits', { state: 'visible', timeout: 120000 })
            await this.bot.utils.wait(2000)

            return true
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'QUIZ-REFRESH', 'An error occurred:' + error, 'error')
            return false
        }
    }

    async checkQuizCompleted(page: Page): Promise<boolean> {
        try {
            await page.waitForSelector('#quizCompleteContainer', { state: 'visible', timeout: 120000 })
            await this.bot.utils.wait(2000)

            return true
        } catch (error) {
            return false
        }
    }

    async loadInCheerio(page: Page): Promise<CheerioAPI> {
        const html = await page.content()
        const $ = load(html)

        return $
    }

    async getPunchCardActivity(page: Page, activity: PromotionalItem | MorePromotion): Promise<string> {
        let selector = ''
        try {
            const html = await page.content()
            const $ = load(html)

            // slight randomized delay after loading punch-card page content
            await this.quietDelay()

            const element = $('.offer-cta').toArray().find(x => x.attribs.href?.includes(activity.offerId))
            if (element) {
                selector = `a[href*="${element.attribs.href}"]`
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-PUNCHCARD-ACTIVITY', 'An error occurred:' + error, 'error')
        }

        return selector
    }

    // Paste this function into your class. Make sure you have:
// import * as fs from 'fs/promises'
// import * as path from 'path'
// and that `saveSessionData` is in scope.

    async closeBrowser(
        browser: BrowserContext,
        email: string,
        options?: {
            backupSessionsBeforeClose?: boolean
            backupSessionPath?: string
            skipSave?: boolean
        }
    ) {
        try {
            // slight randomized delay before saving session & closing
            await this.quietDelay()

            // --- OPTIONAL BACKUP PHASE (non-destructive) ---
            const cfgBackupEnabled = !!(this.bot?.config?.backupSessionsBeforeClose)
            const doBackup = options?.backupSessionsBeforeClose ?? cfgBackupEnabled
            const skipSave = !!options?.skipSave
            const backupPath = options?.backupSessionPath ?? this.bot?.config?.backupSessionPath ?? this.bot?.config?.sessionPath
            const resolvedBackupPath = String(backupPath ?? this.bot?.config?.sessionPath ?? '.')

            if (doBackup && !skipSave && typeof saveSessionData === 'function') {
                try {
                    await saveSessionData(resolvedBackupPath, browser, email, this.bot.isMobile)
                    this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Saved session backup for ${email} to ${resolvedBackupPath}`)
                } catch (e) {
                    this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Failed saving session backup: ${e}`, 'warn')
                }
            }

            // --- CLEANUP PHASE ---
            // 1) Try to clear storage on every open page (localStorage, sessionStorage, indexedDB, service workers)
            try {
                const pages: Page[] = typeof (browser as any).pages === 'function' ? (browser as any).pages() : []

                for (const p of pages) {
                    try {
                        // Navigate to about:blank to reduce cross-origin issues
                        try { await p.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 120000 }) } catch (_) { }

                        await p.evaluate(async () => {
                            try {
                                try { localStorage.clear() } catch (_) { }
                                try { sessionStorage.clear() } catch (_) { }

                                // Delete all indexedDB databases if supported
                                try {
                                    // @ts-ignore
                                    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
                                        // @ts-ignore
                                        const dbs = await indexedDB.databases()
                                        for (const db of dbs) {
                                            try {
                                                if (db && db.name) {
                                                    const name = db.name as string
                                                    await new Promise<void>((resolve) => {
                                                        try {
                                                            const req = indexedDB.deleteDatabase(name)
                                                            req.onsuccess = () => resolve()
                                                            req.onerror = () => resolve()
                                                            req.onblocked = () => resolve()
                                                        } catch (_) {
                                                            resolve()
                                                        }
                                                    })
                                                }
                                            } catch (_) { }
                                        }
                                    }
                                } catch (_) { }

                                // Unregister service workers
                                try {
                                    if (navigator && 'serviceWorker' in navigator) {
                                        // @ts-ignore
                                        const regs = await navigator.serviceWorker.getRegistrations()
                                        for (const r of regs) {
                                            try { await r.unregister() } catch (_) { }
                                        }
                                    }
                                } catch (_) { }
                            } catch (_) { }
                        })

                        // small delay per page
                        await this.bot.utils.wait(200)

                        // attempt to close the page itself to release resources
                        try { await p.close() } catch (_) { }
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Per-page cleanup error: ${err}`, 'warn')
                    }
                }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Error during per-page cleanup: ${err}`, 'warn')
            }

            // 2) Attempt to clear cookies & cache at the context level (best-effort)
            try {
                if (typeof (browser as any).clearCookies === 'function') {
                    try { await (browser as any).clearCookies() } catch (_) { }
                    this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', 'Context cookies cleared')
                } else if (typeof (browser as any).cookies === 'function') {
                    try {
                        const existing = await (browser as any).cookies()
                        if (Array.isArray(existing) && existing.length) {
                            try { await (browser as any).clearCookies?.() } catch (_) { }
                        }
                    } catch (_) { }
                }

                if (typeof (browser as any).clearStorage === 'function') {
                    try { await (browser as any).clearStorage() } catch (_) { }
                }
                if (typeof (browser as any).clearBrowserCaches === 'function') {
                    try { await (browser as any).clearBrowserCaches() } catch (_) { }
                }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Error clearing cookies/cache: ${err}`, 'warn')
            }

            // 3) Remove any on-disk session files for this email (best-effort and defensive)
            try {
                const sp = this.bot.config.sessionPath
                if (sp) {
                    try {
                        const stat = await fs.stat(sp)
                        if (stat.isDirectory()) {
                            const files = await fs.readdir(sp)
                            const emailSan = email.toLowerCase().replace(/[@.]/g, '')
                            for (const f of files) {
                                const fname = f.toLowerCase()
                                if (fname.includes(email.toLowerCase()) || fname.includes(emailSan)) {
                                    try {
                                        await fs.unlink(path.join(sp, f))
                                        this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Deleted session file: ${path.join(sp, f)}`)
                                    } catch (e) {
                                        this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Failed deleting session file ${path.join(sp, f)}: ${e}`, 'warn')
                                    }
                                }
                            }
                        } else {
                            const bn = path.basename(sp).toLowerCase()
                            const emailSan = email.toLowerCase().replace(/[@.]/g, '')
                            if (bn.includes(email.toLowerCase()) || bn.includes(emailSan)) {
                                try {
                                    await fs.unlink(sp)
                                    this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Deleted session file: ${sp}`)
                                } catch (e) {
                                    this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Failed deleting session file ${sp}: ${e}`, 'warn')
                                }
                            }
                        }
                    } catch (e) {
                        // session path doesn't exist or not accessible — ignore
                    }
                }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Error while trying to remove session files: ${err}`, 'warn')
            }

            // 4) Clear any in-memory references on the bot that might contain auth/session data (best-effort)
            try {
                try { if ((this.bot as any).session) (this.bot as any).session = undefined } catch (_) { }
                try { if ((this.bot as any).sessionData) (this.bot as any).sessionData = undefined } catch (_) { }
                try { if ((this.bot as any).authToken) (this.bot as any).authToken = undefined } catch (_) { }
            } catch (_) { }

            // small pause before closing
            await this.bot.utils.wait(1000)

            // Close browser context
            try {
                await browser.close()
                this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', 'Browser closed cleanly!')
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', `Error closing browser: ${err}`, 'error')
                throw new Error('CLOSE-BROWSER error: ' + err)
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', 'An error occurred:' + error, 'error')
            throw new Error('CLOSE-BROWSER error: ' + error)
        }
    }
}
