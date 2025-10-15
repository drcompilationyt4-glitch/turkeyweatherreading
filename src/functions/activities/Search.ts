// src/functions/activities/Search.ts
import { Page } from 'rebrowser-playwright'
import { platform, hostname } from 'os'
import axios, { AxiosRequestConfig } from 'axios';

import { Workers } from '../Workers'

import { Counters, DashboardData } from '../../interface/DashboardData'
import { GoogleSearch } from '../../interface/Search'

type GoogleTrendsResponse = [
    string,
    [
        string,
        ...null[],
        [string, ...string[]]
    ][]
];

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private searchPageURL = ''

    public async doSearch(page: Page, data: DashboardData, numSearches?: number) {
        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Starting Bing searches')

        // Human-like delay before starting searches (1-3 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

        page = await this.bot.browser.utils.getLatestTab(page)

        let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
        let missingPoints = this.calculatePoints(searchCounters)

        if (missingPoints === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Bing searches have already been completed')
            return
        }

        // Decide how many searches we may need (roughly)
        const pointsPerSearch = this.bot.config.searchSettings?.pointsPerSearch || 5
        const neededSearches = Math.ceil(missingPoints / pointsPerSearch)
        const targetSearchCount = numSearches ? Math.min(numSearches, neededSearches) : neededSearches

        // Determine run seed / mode / diversity
        const runSeed = this.getRunSeed()
        const runId = this.getRunId(runSeed)

        const modeCfg = (this.bot.config.searchSettings?.mode as ('auto' | Mode) | undefined) || 'auto'
        const autoSettings = this.determineRunSettings(runSeed)
        const mode = modeCfg === 'auto' ? autoSettings.mode : (modeCfg as Mode)
        const diversityLevel = typeof this.bot.config.searchSettings?.diversityBase === 'number'
            ? this.bot.config.searchSettings.diversityBase
            : autoSettings.diversityLevel

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `RunID=${runId} mode=${mode} diversity=${diversityLevel.toFixed(2)}`)

        // Generate search queries (75% LLM / 25% Trends by default)
        const geo = this.bot.config.searchSettings?.useGeoLocaleQueries ? (data?.userProfile?.attributes?.country || 'US') : 'US'

        // Get queries with our improved distribution strategy
        let googleSearchQueries: GoogleSearch[] = await this.getSearchQueries(geo, targetSearchCount, mode, diversityLevel, runSeed)

        // Final fallbacks: local file
        if (!googleSearchQueries.length || googleSearchQueries.length < 1) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'No queries from LLM/Trends — falling back to local queries.json', 'warn')
            try {
                const local = await import('../queries.json')
                const sampleSize = Math.max(5, Math.min(25, (local.default || []).length))
                const sampled = this.bot.utils.shuffleArray(local.default || []).slice(0, sampleSize)
                googleSearchQueries = sampled.map((x: any) => ({ topic: x.queries?.[0] || x.title, related: x.queries?.slice(1) || [] }))
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed loading local queries fallback: ' + (e instanceof Error ? e.message : String(e)), 'error')
            }
        }

        // Shuffle and dedupe topics (we normalize by removing non-alphanumerics)
        googleSearchQueries = this.bot.utils.shuffleArray(googleSearchQueries)
        const seen = new Set<string>()
        googleSearchQueries = googleSearchQueries.filter(q => {
            if (!q || !q.topic) return false
            const k = q.topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })

        // Go to bing
        await page.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
        await this.bot.utils.wait(2000)
        await this.bot.browser.utils.tryDismissAllMessages(page)

        let stagnation = 0 // consecutive searches without point progress

        const queries: string[] = []
        // Mobile search doesn't seem to like related queries
        googleSearchQueries.forEach(x => { this.bot.isMobile ? queries.push(x.topic) : queries.push(x.topic, ...(x.related || [])) })

        // Loop over Google search queries (stop when we've satisfied points or exhausted queries)
        for (let i = 0; i < queries.length; i++) {
            const query = queries[i] as string

            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `${missingPoints} Points Remaining | Query: ${query}`)

            searchCounters = await this.bingSearch(page, query)
            const newMissingPoints = this.calculatePoints(searchCounters)

            // If the new point amount is the same as before
            if (newMissingPoints === missingPoints) {
                stagnation++
            } else {
                stagnation = 0
            }

            missingPoints = newMissingPoints

            if (missingPoints === 0) break

            // Only for mobile searches
            if (stagnation > 5 && this.bot.isMobile) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 5 iterations, likely bad User-Agent', 'warn')
                break
            }

            // If we didn't gain points for 10 iterations, assume it's stuck
            if (stagnation > 10) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 10 iterations aborting searches', 'warn')
                stagnation = 0 // allow fallback loop below
                break
            }
        }

        // Only for mobile searches
        if (missingPoints > 0 && this.bot.isMobile) {
            return
        }

        // If we still got remaining search queries, generate extra ones (related-terms fallback)
        if (missingPoints > 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search completed but we're missing ${missingPoints} points, generating extra searches`)

            let i = 0
            let fallbackRounds = 0
            const extraRetries = this.bot.config.searchSettings?.extraFallbackRetries ?? 1
            while (missingPoints > 0 && fallbackRounds <= extraRetries) {
                const query = googleSearchQueries[i++] as GoogleSearch
                if (!query) break

                // Get related search terms to the Google search queries
                const relatedTerms = await this.getRelatedTerms(query?.topic)
                if (relatedTerms.length > 3) {
                    // Search for the first 2 related terms
                    for (const term of relatedTerms.slice(1, 3)) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', `${missingPoints} Points Remaining | Query: ${term}`)

                        searchCounters = await this.bingSearch(page, term)
                        const newMissingPoints = this.calculatePoints(searchCounters)

                        // If the new point amount is the same as before
                        if (newMissingPoints === missingPoints) {
                            stagnation++
                        } else {
                            stagnation = 0
                        }

                        missingPoints = newMissingPoints

                        // If we satisfied the searches
                        if (missingPoints === 0) {
                            break
                        }

                        // Try 5 more times, then give up for this fallback round
                        if (stagnation > 5) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', 'Search didn\'t gain point for 5 iterations aborting searches', 'warn')
                            return
                        }
                    }
                    fallbackRounds++
                }
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Completed searches')
    }


    private async bingSearch(searchPage: Page, query: string) {
        const platformControlKey = platform() === 'darwin' ? 'Meta' : 'Control'

        // Try a max of 5 times
        for (let i = 0; i < 5; i++) {
            try {
                // Ensure we operate on the latest tab
                searchPage = await this.bot.browser.utils.getLatestTab(searchPage)

                // Go to top of the page
                await searchPage.evaluate(() => { window.scrollTo(0, 0) })
                await this.bot.utils.wait(500)

                const searchBar = '#sb_form_q'
                // Prefer attached over visible to avoid strict visibility waits when overlays exist
                const box = searchPage.locator(searchBar)

                // Helper to find any visible & enabled input on the page
                const findAnyVisibleInput = async (p: Page) => {
                    try {
                        const inputs = await p.$$('input')
                        for (const inp of inputs) {
                            try {
                                const visible = await inp.evaluate((el: HTMLElement) => {
                                    const style = window.getComputedStyle(el)
                                    const rect = el.getBoundingClientRect()
                                    return !el.hasAttribute('disabled') && !!(rect.width && rect.height) && style.visibility !== 'hidden' && style.display !== 'none'
                                })
                                if (visible) return inp
                            } catch { /* ignore evaluation errors */ }
                        }
                    } catch { /* ignore */ }
                    return null
                }

                // Try waiting for attached; if it times out, we'll attempt alternatives (Ctrl/Cmd+E fallback)
                try {
                    await box.waitFor({ state: 'attached', timeout: 15000 })
                } catch (waitErr) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Primary selector ${searchBar} not attached; attempting keyboard shortcut (Ctrl/Cmd+E) and fallback strategies`, 'warn')

                    // 1) Try dismiss overlays then short wait
                    await this.bot.browser.utils.tryDismissAllMessages(searchPage).catch(() => {})
                    await this.bot.utils.wait(200)

                    // Helper to try platform modifier + key and then check for the primary selector
                    const tryShortcut = async (key: string) => {
                        try {
                            await searchPage.keyboard.down(platformControlKey)
                            await searchPage.keyboard.press(key)
                            await searchPage.keyboard.up(platformControlKey)
                        } catch { /* ignore */ }
                        await this.bot.utils.wait(350)
                        try {
                            const el = await searchPage.$(searchBar)
                            if (el) return el
                        } catch { /* ignore */ }
                        return null
                    }

                    // 2) Try Ctrl/Cmd+E first (user requested), then Ctrl/Cmd+K, then '/' key
                    let found: any = null
                    found = await tryShortcut('E')
                    if (!found) found = await tryShortcut('K')
                    if (!found) {
                        try { await searchPage.keyboard.press('/') } catch { /* ignore */ }
                        await this.bot.utils.wait(350)
                        try { found = await searchPage.$(searchBar) } catch { /* ignore */ }
                    }

                    // If found via shortcut, use it
                    if (found) {
                        try {
                            await (found as any).focus().catch(() => { })
                            await (found as any).fill('')
                            await (found as any).type(query, { delay: 20 })
                            await searchPage.keyboard.press('Enter')
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Focused via shortcut and executed Enter', 'log')
                        } catch (e) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Shortcut-focused input failed, will try any visible input', 'warn')
                            found = null
                        }
                    }

                    // If still nothing, try any visible input
                    if (!found) {
                        const anyInput = await findAnyVisibleInput(searchPage)
                        if (anyInput) {
                            try {
                                await anyInput.focus()
                                await anyInput.fill('')
                                await anyInput.type(query, { delay: 20 })
                                await searchPage.keyboard.press('Enter')
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Used fallback visible input + Enter', 'log')
                            } catch (e) {
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Fallback visible input failed, navigating directly', 'warn')
                                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                                await searchPage.goto(url)
                            }
                        } else {
                            // Last resort: try pressing Enter on current focus then direct navigation
                            try {
                                await searchPage.keyboard.press('Enter')
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Pressed Enter with no specific input focused (best-effort)', 'warn')
                                await this.bot.utils.wait(1000)
                                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                                await searchPage.goto(url)
                            } catch (e) {
                                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                                await searchPage.goto(url)
                            }
                        }
                    }
                }

                // Try interacting with primary box when present
                let navigatedDirectly = false
                try {
                    // Try focusing and filling instead of clicking (more reliable on mobile)
                    await box.focus({ timeout: 2000 }).catch(() => { /* ignore focus errors */ })
                    await box.fill('')
                    await this.bot.utils.wait(200)
                    await searchPage.keyboard.down(platformControlKey)
                    await searchPage.keyboard.press('A')
                    await searchPage.keyboard.press('Backspace')
                    await searchPage.keyboard.up(platformControlKey)
                    // type with small delay to look human
                    await box.type(query, { delay: 20 })
                    await searchPage.keyboard.press('Enter')
                } catch (typeErr) {
                    // Robust fallback: navigate directly to the search URL
                    const q = encodeURIComponent(query)
                    const url = `https://www.bing.com/search?q=${q}`
                    await searchPage.goto(url)
                    navigatedDirectly = true
                }

                // Short wait for results to settle
                await this.bot.utils.wait(3000)

                // If Enter opened a new tab, get it; otherwise stay on current
                const resultPage = navigatedDirectly ? searchPage : await this.bot.browser.utils.getLatestTab(searchPage)
                this.searchPageURL = new URL(resultPage.url()).href // Set the results page

                await this.bot.browser.utils.reloadBadPage(resultPage)

                if (this.bot.config.searchSettings?.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(resultPage)
                }

                if (this.bot.config.searchSettings?.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(resultPage)
                }

                // Delay between searches (configurable)
                const minDelay = this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.min)
                const maxDelay = this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.max)
                const adaptivePad = Math.min(4000, Math.max(0, Math.floor(Math.random() * 800)))
                await this.bot.utils.wait(Math.floor(this.bot.utils.randomNumber(minDelay, maxDelay)) + adaptivePad)

                return await this.bot.browser.func.getSearchPoints()

            } catch (error) {
                if (i === 4) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed after 5 retries... An error occurred:' + error, 'error')
                    break
                }

                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed, An error occurred:' + error, 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Retrying search, attempt ${i + 1}/5`, 'warn')

                // Reset the tabs
                try {
                    const lastTab = await this.bot.browser.utils.getLatestTab(searchPage)
                    await this.closeTabs(lastTab)
                } catch { /* ignore */ }

                // Human-like delay after failure (3-5 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 5000))
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed after 5 retries, ending', 'error')
        return await this.bot.browser.func.getSearchPoints()
    }

    /**
     * Primary entrypoint to obtain queries.
     * Behavior:
     *  - 75% LLM / 25% Trends distribution (configurable)
     *  - On failure of LLM batch we attempt single-per-search generation (if configured), otherwise Google Trends fallback.
     */
    private async getSearchQueries(
        geoLocale: string = 'US',
        desiredCount = 25,
        mode: Mode = 'balanced',
        diversityLevel = 0.5,
        runSeed?: number
    ): Promise<GoogleSearch[]> {
        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Generating ${desiredCount} queries with default 75% LLM / 25% Trends distribution`)

        const mix = this.bot.config.searchSettings?.queryMix || { llmPct: 75 }
        const llmPct = Math.max(0, Math.min(100, mix.llmPct ?? 75))
        const llmCount = Math.max(0, Math.round(desiredCount * (llmPct / 100)))
        const trendsCount = Math.max(0, desiredCount - llmCount)

        // Fetch both sources in parallel (if counts > 0)
        const llmPromise = llmCount > 0 ? this.getEnhancedLLMQueries(geoLocale, llmCount, mode, runSeed) : Promise.resolve([] as GoogleSearch[])
        const trendsPromise = trendsCount > 0 ? this.getGoogleTrends(geoLocale) : Promise.resolve([] as GoogleSearch[])

        const [llmQueries, trendsQueries] = await Promise.all([llmPromise, trendsPromise])

        // Weighting: take up to llmCount from LLM, then fill with trends sample
        const results: GoogleSearch[] = []
        if (Array.isArray(llmQueries) && llmQueries.length) results.push(...llmQueries.slice(0, llmCount))
        if (Array.isArray(trendsQueries) && trendsQueries.length && trendsCount > 0) {
            const sampledTrends = this.bot.utils.shuffleArray(trendsQueries).slice(0, trendsCount)
            results.push(...sampledTrends)
        }

        // If still short, attempt per-search LLM fallback (if enabled)
        if (results.length < desiredCount && this.bot.config.searchSettings?.enablePerSearchFallback) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Attempting per-search LLM fallback')
            while (results.length < desiredCount) {
                try {
                    const q = await this.generateSingleQueryFromLLM(geoLocale, mode)
                    if (q) results.push({ topic: q, related: [] })
                    else break
                } catch { break }
            }
        }

        // If still short, fallback to local
        if (results.length < Math.max(5, Math.floor(desiredCount * 0.4))) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Insufficient queries from LLM/Trends, using local fallback', 'warn')
            return this.getLocalQueriesFallback(desiredCount)
        }

        // Post-process to diversify / humanize (deterministic if runSeed given)
        const rng = this.seededRng(runSeed ?? this.getRunSeed())
        const diversified = this.diversifyQueries(results.slice(0, desiredCount), mode, (new Date()).getDay(), rng, diversityLevel)

        return diversified.slice(0, desiredCount)
    }

    private async getEnhancedLLMQueries(geoLocale: string, count: number, mode: Mode, runSeed?: number): Promise<GoogleSearch[]> {
        const { mode: ctxMode, contextNotes } = this.determineRunSettings(runSeed)
        const finalMode = mode || ctxMode
        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Generating ${count} LLM queries in ${finalMode} mode: ${contextNotes}`)

        try {
            return await this.generateQueriesWithLLMBatch(geoLocale, count, finalMode, contextNotes, runSeed)
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Enhanced LLM generation failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            return []
        }
    }

    private async getLocalQueriesFallback(desiredCount: number): Promise<GoogleSearch[]> {
        try {
            const local = await import('../queries.json')
            const sampleSize = Math.max(5, Math.min(25, (local.default || []).length))
            const sampled = this.bot.utils.shuffleArray(local.default || []).slice(0, sampleSize)
            return sampled.map((x: any) => ({ topic: x.queries?.[0] || x.title, related: x.queries?.slice(1) || [] }))
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Failed loading local queries fallback: ' + (e instanceof Error ? e.message : String(e)), 'error')
            return [];
        }
    }

    /**
     * Batch LLM request: ask OpenRouter (or compatible) for JSON array of queries.
     * Returns normalized GoogleSearch[]
     */
    private async generateQueriesWithLLMBatch(
        geoLocale: string,
        desiredCount = 25,
        mode: Mode = 'balanced',
        contextNotes: string = '',
        runSeed?: number
    ): Promise<GoogleSearch[]> {
        const apiKey = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim()
        if (!apiKey) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'OpenRouter API key missing. Set OPENROUTER_API_KEY or bot.config.openRouterApiKey', 'error')
            throw new Error('OpenRouter API key not configured')
        }

        // Use runSeed to choose examples deterministically
        const rng = this.seededRng(runSeed ?? this.getRunSeed())
        const realisticPatterns = [
            'Instead of generic "cheap food near me", use specific examples like "McDonald\'s delivery promo" or "best sushi near campus"',
            'Avoid repetitive phrasing - vary between questions ("How to..."), commands ("Find..."), and direct requests ("Best pizza in [city]")',
            'Incorporate day-specific context: weekday = academic/work, weekend = entertainment/leisure',
            'Add location context naturally: "near campus", "downtown", "in [city]"'
        ]

        const systemPrompt = `You are an assistant that outputs a JSON array only. Each item must be an object with:
- "topic": a short search query a typical university student might type.
- "related": an array of 0..6 related searches (short strings).

Return up to ${desiredCount} diverse items if possible. Avoid politically sensitive & adult topics. Output must be valid JSON only (no explanatory text). Use ${geoLocale.toUpperCase()} locale where relevant. Be varied and avoid repeating the same simple phrases (e.g., don't output "cheap food near me" repeatedly). This request context: ${contextNotes}. Use the style guidance: ${realisticPatterns[Math.floor(rng() * realisticPatterns.length)]}. For mode: ${mode}.`

        const userPrompt = `Generate up to ${desiredCount} concise search queries a typical undergraduate would use (games, course topics, campus services, cheap food, debugging help, YouTube searches, study resources).
Avoid repetitive patterns: ${this.getRepetitivePatternsWarning(rng)}
Output only valid JSON array with "topic" and "related" fields.`

        const body = {
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: Math.min(1600, 90 * desiredCount),
            temperature: 0.8
        }

        const requestConfig: AxiosRequestConfig = {
            url: 'https://openrouter.ai/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            data: body,
            timeout: 25000,
            proxy: false // ensure no proxy
        }

        // Try with a couple of attempts for transient errors
        let lastErr: any = null
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const resp = await axios.request(requestConfig as any)
                let content: string | undefined
                const choices = resp?.data?.choices
                if (Array.isArray(choices) && choices.length) {
                    content = choices[0]?.message?.content || choices[0]?.text
                } else if (typeof resp?.data === 'string') {
                    content = resp.data
                } else if (resp?.data?.result?.content) {
                    content = resp.data.result.content
                }

                if (!content) throw new Error('No content from LLM')

                // Attempt to parse JSON (strip code fences if present)
                let parsed: any
                try {
                    parsed = JSON.parse(content)
                } catch (e) {
                    const trimmed = String(content).replace(/```json|```/g, '').trim()
                    parsed = JSON.parse(trimmed)
                }

                if (!Array.isArray(parsed)) throw new Error('LLM returned non-array JSON')

                const normalized: GoogleSearch[] = parsed.map((item: any) => {
                    const topic = typeof item.topic === 'string' ? item.topic : (typeof item === 'string' ? item : '')
                    const related = Array.isArray(item.related) ? item.related.filter((r: any) => typeof r === 'string') : []
                    return { topic, related }
                }).filter(x => x.topic && x.topic.length > 1)

                return normalized
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `LLM attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
                // backoff
                await this.bot.utils.wait(1000 * (attempt + 1))
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'All LLM attempts failed, throwing to allow fallback', 'error')
        throw lastErr || new Error('LLM failed')
    }

    private getRepetitivePatternsWarning(rng?: () => number): string {
        const warnings = [
            '"cheap food near me" → use specific examples like "Chipotle catering options" or "best sushi in [city]"',
            '"how to" → vary with "tips for", "guide to", "best way to", or just the topic itself',
            'Always include natural location context when relevant (e.g., "near campus", "downtown", "in [city]")',
            'Mix question format and direct search terms for diversity'
        ];

        if (!warnings.length) return ''

        const idx = typeof rng === 'function'
            ? Math.floor(Math.max(0, Math.min(0.999999, rng())) * warnings.length)
            : Math.floor(Math.random() * warnings.length)

        return (warnings[idx] ?? warnings[0]) as string
    }

    /**
     * Single-query LLM generation (used in per-search mode or per-search fallback).
     * Returns single string or null.
     */
    private async generateSingleQueryFromLLM(geoLocale: string = 'US', mode: Mode = 'balanced'): Promise<string | null> {
        const apiKey = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim()
        if (!apiKey) throw new Error('OpenRouter API key not configured')

        const systemPrompt = `You are an assistant that outputs only one short search query (plain text) a typical undergraduate student might type. Keep it short (3-8 words). Use ${geoLocale.toUpperCase()} locale if relevant. Avoid politics & adult content. Output MUST be only the query string. Mode hint: ${mode}.`
        const userPrompt = `Provide a single concise search query a university undergrad might use.`

        const body = {
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 60,
            temperature: 0.8
        }

        const requestConfig: AxiosRequestConfig = {
            url: 'https://openrouter.ai/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            data: body,
            timeout: 15000,
            proxy: false
        }

        const resp = await axios.request(requestConfig as any)
        const choices = resp?.data?.choices
        let rawContent = choices?.[0]?.message?.content || choices?.[0]?.text || (typeof resp?.data === 'string' ? resp.data : undefined)
        if (!rawContent) return null

        const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim()
        const cleanedLines = stripFences(rawContent).split(/\r?\n/).map(l => l.trim()).filter(l => l.length)
        const candidate = cleanedLines.length ? cleanedLines[0] : String(rawContent).trim()
        const final = String(candidate).replace(/(^"|"$)/g, '').trim()

        if (!final || final.length < 2) return null
        return final.length > 200 ? final.slice(0, 200) : final
    }

    private async getGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Generating search queries, can take a while! | GeoLocale: ${geoLocale}`)

        // Human-like delay before fetching trends (0.5-1.5 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        try {
            const request: AxiosRequestConfig = {
                url: 'https://trends.google.com/_/TrendsUi/data/batchexecute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                data: `f.req=[[[i0OFE,"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`,
                responseType: 'text',
                timeout: (this.bot.config?.googleTrends?.timeoutMs) || 20000,
                proxy: false
            }

            // Optional: set custom https agent to prefer IPv4 (best-effort)
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const dns = require('dns')
                const lookup = (hostname: string, options: any, callback: Function) => {
                    dns.lookup(hostname, { family: 4 }, (err: any, address: any, family: any) => {
                        if (err) dns.lookup(hostname, (err2: any, address2: any, family2: any) => callback(err2, address2, family2))
                        else callback(err, address, family)
                    })
                }
                request.httpsAgent = new (require('https').Agent)({
                    keepAlive: true,
                    lookup,
                    rejectUnauthorized: true
                })
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'DNS agent creation failed, using default: ' + (e instanceof Error ? e.message : String(e)), 'warn')
            }

            const response = await axios.request(request as any)

            let rawText: string
            if (typeof response.data === 'string') rawText = response.data
            else if (Buffer.isBuffer(response.data)) rawText = response.data.toString('utf8')
            else rawText = JSON.stringify(response.data)

            if (!rawText || rawText.length < 10) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Empty or invalid response from Google Trends', 'warn')
                return []
            }

            const trendsData = this.extractJsonFromResponse(rawText)
            if (!trendsData || !Array.isArray(trendsData)) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Failed to parse valid trends data from response', 'warn')
                if (geoLocale.toUpperCase() !== 'US') {
                    this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Falling back to US locale', 'warn')
                    return this.getGoogleTrends('US')
                }
                return []
            }

            const mappedTrendsData = trendsData.map((q: any) => [q[0], q[9] ? q[9].slice(1) : []])

            if (mappedTrendsData.length < 50 && geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Insufficient trends for ${geoLocale} (${mappedTrendsData.length}), falling back to US`, 'warn')
                return this.getGoogleTrends('US')
            }

            for (const [topic, relatedQueries] of mappedTrendsData) {
                if (topic && typeof topic === 'string' && topic.trim().length > 0) {
                    queryTerms.push({
                        topic: topic.trim(),
                        related: Array.isArray(relatedQueries) ? relatedQueries.filter((r: any) => typeof r === 'string') : []
                    })
                }
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Successfully fetched ${queryTerms.length} search queries`)

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Error fetching trends: ' + errorMessage, 'error')

            if (geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Falling back to US locale after error', 'warn')
                return this.getGoogleTrends('US')
            }
        }

        return []
    }

    private extractJsonFromResponse(text: string): GoogleTrendsResponse[1] | null {
        const lines = String(text).split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                try {
                    return JSON.parse(JSON.parse(trimmed)[0][2])[1]
                } catch {
                    continue
                }
            }
        }
        return null
    }

    private async getRelatedTerms(term: string): Promise<string[]> {
        try {
            // Human-like delay before fetching related terms (0.5-1.5s)
            await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

            const request = {
                url: `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(term)}`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                proxy: false
            }

            const response = await axios.request(request as any)
            return response.data?.[1] as string[] || []
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING-RELATED', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }

        return []
    }

    private async randomScroll(page: Page) {
        try {
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            if (totalHeight <= viewportHeight) return
            const randomScrollPosition = Math.floor(Math.random() * (totalHeight - viewportHeight))

            await page.evaluate((scrollPos: number) => { window.scrollTo(0, scrollPos) }, randomScrollPosition)

            // Human-like delay after scrolling (2-5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-RANDOM-SCROLL', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }
    }

    // Restored working clickRandomLink implementation
    private async clickRandomLink(page: Page) {
        try {
            // Small wait+click to open a result if present
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
            await page.click('#b_results .b_algo h2', { timeout: 2000 }).catch(() => { })

            // Only used if the browser shows an Edge continuation popup
            await this.closeContinuePopup(page)

            // Stay for 10 seconds for page to load and "visit"
            await this.bot.utils.wait(10000)

            // Will get current tab if no new one is created
            let lastTab = await this.bot.browser.utils.getLatestTab(page)
            let lastTabURL = new URL(lastTab.url())

            // If click opened a new tab, close it and return to search results. Limit loops.
            let i = 0
            while (lastTabURL.href !== this.searchPageURL && i < 5) {
                await this.closeTabs(lastTab)
                lastTab = await this.bot.browser.utils.getLatestTab(page)
                lastTabURL = new URL(lastTab.url())
                i++
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-RANDOM-CLICK', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }
    }

    private async closeTabs(lastTab: Page) {
        const browser = lastTab.context()
        const tabs = browser.pages()

        // Human-like delay before closing tabs (0.5-1.5 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        try {
            if (tabs.length > 2) {
                // Close the last tab
                await lastTab.close()
                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', `More than 2 were open, closed the last tab: "${new URL(lastTab.url()).host}"`)
            } else if (tabs.length === 1) {
                // If only 1 tab is open, open a new one to search in
                const newPage = await browser.newPage()
                await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

                await newPage.goto(this.bingHome)
                await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))
                this.searchPageURL = newPage.url()

                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'There was only 1 tab open, created a new one')
            } else {
                // Else reset the last tab back to the search listing or Bing.com
                lastTab = await this.bot.browser.utils.getLatestTab(lastTab)
                await lastTab.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }
    }

    private calculatePoints(counters: Counters) {
        const mobileData = counters.mobileSearch?.[0] // Mobile searches
        const genericData = counters.pcSearch?.[0] // Normal searches
        const edgeData = counters.pcSearch?.[1] // Edge searches

        if (this.bot.isMobile && mobileData) {
            return (mobileData.pointProgressMax || 0) - (mobileData.pointProgress || 0)
        }

        const edgeMissing = edgeData ? ((edgeData.pointProgressMax || 0) - (edgeData.pointProgress || 0)) : 0
        const genericMissing = genericData ? ((genericData.pointProgressMax || 0) - (genericData.pointProgress || 0)) : 0

        return edgeMissing + genericMissing
    }

    private async closeContinuePopup(page: Page) {
        try {
            await page.waitForSelector('#sacs_close', { timeout: 1000 })
            const continueButton = await page.$('#sacs_close')

            if (continueButton) {
                // Human-like delay before closing popup (0.3-1 second)
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))
                await continueButton.click()
            }
        } catch (error) {
            // Continue if element is not found or other error occurs
        }
    }

    // ----------------------- Helpers for deterministic per-run randomness --------------------

    private getRunSeed(): number {
        const cfgId = this.bot.config?.searchSettings?.instanceId
        const envId = process.env.GITHUB_RUN_ID || process.env.CI_RUN_ID || process.env.RUN_ID || process.env.GITHUB_RUN_NUMBER
        const host = cfgId || envId || hostname() || 'unknown-host'
        const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
        const seedStr = `${host}|${today}`
        return this.cyrb53(seedStr)
    }

    private getRunId(seed?: number): string {
        const s = (typeof seed === 'number') ? seed : this.getRunSeed()
        return (s >>> 0).toString(36).slice(-6)
    }

    // cyrb53 string hash -> number
    private cyrb53(str: string, seed = 0) {
        let h1 = 0xDEADBEEF ^ seed, h2 = 0x41C6CE57 ^ seed
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i)
            h1 = Math.imul(h1 ^ ch, 2654435761)
            h2 = Math.imul(h2 ^ ch, 1597334677)
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
        return 4294967296 * (2097151 & h2) + (h1 >>> 0)
    }

    private seededRng(seed: number) {
        let _seed = seed >>> 0
        return () => {
            _seed = (_seed * 1664525 + 1013904223) % 0x100000000
            return (_seed >>> 0) / 0x100000000
        }
    }

    private determineRunSettings(seed?: number): { mode: Mode, diversityLevel: number, contextNotes: string } {
        const weekday = (new Date()).getDay()
        const rng = this.seededRng(seed ?? this.getRunSeed())

        // Default mode bias: weekend biased towards relaxed, weekdays balanced/study
        let mode: Mode = 'balanced'
        if (weekday === 0 || weekday === 6) {
            mode = rng() < 0.7 ? 'relaxed' : 'food'
        } else {
            // weekday: sometimes study, sometimes balanced
            mode = rng() < 0.4 ? 'study' : 'balanced'
        }

        const configBoost = typeof this.bot.config.searchSettings?.randomnessBoost === 'number' ? this.bot.config.searchSettings.randomnessBoost : 0
        // diversityLevel between 0.1..0.95
        const diversityLevel = Math.max(0.1, Math.min(0.95, (rng() * 0.6) + 0.2 + (configBoost * 0.1)))

        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        const topQueries = (weekday === 0 || weekday === 6) ? ['YouTube', 'Netflix', 'games', 'food delivery', 'weekend plans'] : ['how to', 'best way to', 'tutorial', 'assignment help', 'campus resources']
        const contextNotes = `Auto mode: ${mode}. Day: ${dayNames[weekday]}. Example top query: ${topQueries[Math.floor(rng() * topQueries.length)]}`

        return { mode, diversityLevel, contextNotes }
    }

    // Diversify queries to reduce repetition and make them feel more "human".
    private diversifyQueries(input: GoogleSearch[], mode: Mode, weekday: number, rng: () => number, diversityLevel = 0.5): GoogleSearch[] {
        const out: GoogleSearch[] = []
        const foodExamples = ["McDonald's near me", 'Uber Eats deals', 'cheap pizza near me', 'student meal deals near me', 'KFC coupons']
        const entertainmentSuffix = ['YouTube', 'best gameplay', 'review', 'trailer']
        const studySuffix = ['lecture notes', 'past exam', 'Stack Overflow', 'tutorial']

        const replaceProbBase = 0.6 * diversityLevel
        const brandAddProbBase = 0.4 * diversityLevel
        const modeTweakProbBase = 0.45 * diversityLevel
        const weekendBiasBase = 0.35 * diversityLevel
        const relatedAddProbBase = 0.25 * diversityLevel

        for (const item of input) {
            let topic = (item.topic || '').trim()
            if (!topic) continue

            // Avoid repetitive generic phrase — replace sometimes
            if (/cheap food/i.test(topic) || /cheap meal/i.test(topic) || /cheap eats/i.test(topic) || /^cheap food near me$/i.test(topic)) {
                if (rng() < replaceProbBase) {
                    const idx = Math.floor(rng() * foodExamples.length)
                    const safeIdx = idx % foodExamples.length
                    const choice = foodExamples[safeIdx]! // ✅ Safe non-null assertion
                    topic = choice
                } else {
                    topic = 'cheap food near me'
                }
            }

            // If topic is too generic like "food near me" or "restaurants near me", sometimes add brand
            if ((/food near me/i.test(topic) || /restaurants near me/i.test(topic)) && rng() < brandAddProbBase) {
                const brands = ['McDonald\'s', 'Subway', 'Pizza Hut', 'Tim Hortons']
                const bidx = Math.floor(rng() * brands.length)
                const safeBidx = bidx % brands.length
                const brandChoice = brands[safeBidx]! // ✅ Safe non-null assertion
                topic = `${topic} ${brandChoice}`
            }

            // Mode-based tweaks: relaxed -> more YouTube/gaming; study -> more focused study suffix
            if (mode === 'relaxed' && rng() < modeTweakProbBase) {
                const suffixIdx = Math.floor(rng() * entertainmentSuffix.length) % entertainmentSuffix.length
                topic = `${topic} ${entertainmentSuffix[suffixIdx]!}`
            } else if (mode === 'study' && rng() < (modeTweakProbBase + 0.1)) {
                const suffixIdx = Math.floor(rng() * studySuffix.length) % studySuffix.length
                topic = `${topic} ${studySuffix[suffixIdx]!}`
            }

            // Weekend bias: more entertainment
            if ((weekday === 0 || weekday === 6) && rng() < weekendBiasBase) {
                const suffixIdx = Math.floor(rng() * entertainmentSuffix.length) % entertainmentSuffix.length
                topic = `${topic} ${entertainmentSuffix[suffixIdx]!}`
            }

            topic = topic.replace(/\s+/g, ' ').trim()

            const related = (item.related || [])
                .slice(0, 4)
                .filter(r => typeof r === 'string')
                .map(r => r.trim())
                .filter(Boolean) as string[] // Ensure type is string[]

            if (related.length < 2 && rng() < relatedAddProbBase) {
                related.push(topic + ' review')
            }

            out.push({ topic, related })
        }

        // Deterministic shuffle and dedupe via rng
        const shuffled = this.shuffleWithRng(out, rng)
        const seen = new Set<string>()
        return shuffled.filter(q => {
            const k = q.topic.toLowerCase()
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })
    }

    private shuffleWithRng<T>(arr: T[], rng: () => number) {
        const a = arr.slice()
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1))
            const tmp = a[i] as T
            a[i] = a[j] as T
            a[j] = tmp
        }
        return a
    }
}

// Types used in this file
type Mode = 'balanced' | 'relaxed' | 'study' | 'food' | 'gaming' | 'news'
