import { Page } from 'rebrowser-playwright'
import { platform } from 'os'
import axios from 'axios';

import { Workers } from '../Workers'

import { Counters, DashboardData } from '../../interface/DashboardData'
import { GoogleSearch } from '../../interface/Search'
import { AxiosRequestConfig } from 'axios'

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
        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Starting Bing searches${numSearches ? ` (max ${numSearches} this run)` : ''}`)

        // Human-like delay before starting searches (1-3 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

        page = await this.bot.browser.utils.getLatestTab(page)

        let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
        let missingPoints = this.calculatePoints(searchCounters)

        if (missingPoints === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Bing searches have already been completed')
            return
        }

        // Initialize or reuse query state for interleaving
        if (!this.currentQueries || this.currentQueries.length === 0 || this.currentQueryIndex >= this.currentQueries.length) {
            await this.initializeQueries(data)
        }

        const pointsPerSearch = this.bot.config.searchSettings?.pointsPerSearch || 5
        const maxNeededSearches = Math.ceil(missingPoints / pointsPerSearch)

        // Determine how many searches to do in this chunk
        const searchesToDo = numSearches ?
            Math.min(numSearches, maxNeededSearches) :
            maxNeededSearches

        this.bot.log(this.bot.isMobile, 'SEARCH-BING',
            `Doing ${searchesToDo} searches this iteration (${missingPoints} points remaining, ${maxNeededSearches} total needed)`)

        let attempts = 0
        const maxSearchAttempts = Math.min(searchesToDo * 3, this.bot.config.searchSettings.maxSearchAttempts || 100)
        let stagnation = 0
        let searchesCompleted = 0

        while (searchesCompleted < searchesToDo && attempts < maxSearchAttempts && missingPoints > 0) {
            attempts++

            // Get next query from our pre-generated list
            if (this.currentQueryIndex >= this.currentQueries.length) {
                // If we run out of queries, generate more
                await this.initializeQueries(data)
            }

            const query = this.currentQueries[this.currentQueryIndex++]
            if (!query) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'No query available, skipping', 'warn')
                continue
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-BING',
                `${missingPoints} Points Remaining | Query: ${query} (${searchesCompleted + 1}/${searchesToDo})`)

            searchCounters = await this.bingSearch(page, query)
            const newMissingPoints = this.calculatePoints(searchCounters)

            if (newMissingPoints === missingPoints) {
                stagnation++
            } else {
                stagnation = 0
                searchesCompleted++
            }

            missingPoints = newMissingPoints

            if (missingPoints === 0) break

            // Break conditions for stagnation
            if (stagnation > 5 && this.bot.isMobile) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search stagnation detected on mobile, breaking', 'warn')
                break
            }

            if (stagnation > 10) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search stagnation detected, breaking', 'warn')
                break
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING',
            `Completed ${searchesCompleted} searches this iteration (${missingPoints} points remaining)`)
    }

    // Add these instance variables to your Search class for state management
    private currentQueries: string[] = []
    private currentQueryIndex: number = 0

    /**
     * Initialize or refresh the query list (replaces the inline query initialization)
     */
    private async initializeQueries(data: DashboardData) {
        const geo = this.bot.config.searchSettings.useGeoLocaleQueries ?
            (data?.userProfile?.attributes?.country || 'US') : 'US'

        let initialQueries: GoogleSearch[] = []

        // Try Google Trends first (preserving your existing logic)
        try {
            initialQueries = await this.getGoogleTrends(geo)
        } catch {
            // ignore - we'll fallback to local
        }

        // Fallback to local queries
        if (!initialQueries.length) {
            try {
                const local = await import('../queries.json')
                initialQueries = (local.default || []).slice(0,
                    Math.max(5, Math.min(this.bot.config.searchSettings.localFallbackCount || 25,
                        (local.default || []).length))
                ).map((x: any) => ({
                    topic: x.queries?.[0] || x.title,
                    related: x.queries?.slice(1) || []
                }))
            } catch { /* ignore */ }
        }

        // If we still have no queries, try LLM to generate some initial ones
        if (!initialQueries.length) {
            try {
                const llmQuery = await this.getSingleQueryFromLLM(geo)
                if (llmQuery) {
                    initialQueries = [{ topic: llmQuery, related: [] }]
                }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM',
                    'LLM failed during query initialization: ' + (err instanceof Error ? err.message : String(err)), 'warn')
            }
        }

        // Shuffle & dedupe (preserving your existing logic)
        initialQueries = this.bot.utils.shuffleArray(initialQueries)
        const seen = new Set<string>()

        this.currentQueries = initialQueries
            .map(q => q.topic)
            .filter((t): t is string => !!t && typeof t === 'string')
            .filter(t => {
                const k = t.toLowerCase()
                if (seen.has(k)) return false
                seen.add(k)
                return true
            })

        this.currentQueryIndex = 0
        this.bot.log(this.bot.isMobile, 'SEARCH', `Initialized ${this.currentQueries.length} queries for interleaving`)
    }

    private async bingSearch(searchPage: Page, query: string) {
        const platformControlKey = platform() === 'darwin' ? 'Meta' : 'Control'

        // Try a max of 5 times
        for (let i = 0; i < 5; i++) {
            try {
                // Ensure we operate on the latest tab
                searchPage = await this.bot.browser.utils.getLatestTab(searchPage)

                // If page isn't on bing or search results, navigate there first
                try {
                    const url = new URL(searchPage.url())
                    if (!url.hostname.includes('bing.com')) {
                        await searchPage.goto(this.searchPageURL ? this.searchPageURL : this.bingHome, { timeout: 30000 })
                        await this.bot.utils.wait(1500 + Math.random() * 1500)
                    }
                } catch {
                    // If parsing URL fails, just go to bing
                    await searchPage.goto(this.searchPageURL ? this.searchPageURL : this.bingHome, { timeout: 30000 }).catch(() => { })
                    await this.bot.utils.wait(1500 + Math.random() * 1500)
                }

                // Go to top of the page
                await searchPage.evaluate(() => { window.scrollTo(0, 0) })
                await this.bot.utils.wait(500)

                const searchBar = '#sb_form_q'
                // Prefer attached over visible to avoid strict visibility waits when overlays exist
                const box = searchPage.locator(searchBar)

                // Try dismissing overlays before waiting for the control
                await this.bot.browser.utils.tryDismissAllMessages(searchPage).catch(() => {})
                await this.bot.utils.wait(200)

                // Wait for the element to be attached. If timeout, fallback to navigating directly to search URL
                try {
                    await box.waitFor({ state: 'attached', timeout: 15000 })
                } catch (waitErr) {
                    // As fallback, navigate directly to the search URL and mark as navigatedDirectly
                    const q = encodeURIComponent(query)
                    const url = `https://www.bing.com/search?q=${q}`
                    await searchPage.goto(url, { timeout: 30000 }).catch(() => { })
                    // Short settle
                    await this.bot.utils.wait(2000)
                    // Set flag so we don't attempt typing below
                    // Proceed to result handling below
                    const resultPage = await this.bot.browser.utils.getLatestTab(searchPage)
                    this.searchPageURL = new URL(resultPage.url()).href

                    await this.bot.browser.utils.reloadBadPage(resultPage).catch(() => {})

                    if (this.bot.config.searchSettings.scrollRandomResults) {
                        await this.bot.utils.wait(2000)
                        await this.randomScroll(resultPage)
                    }

                    if (this.bot.config.searchSettings.clickRandomResults) {
                        await this.bot.utils.wait(2000)
                        await this.clickRandomLink(resultPage)
                    }

                    // Delay between searches (configurable)
                    const minDelay = this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.min)
                    const maxDelay = this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.max)
                    const adaptivePad = Math.min(4000, Math.max(0, Math.floor(Math.random() * 800)))
                    await this.bot.utils.wait(Math.floor(this.bot.utils.randomNumber(minDelay, maxDelay)) + adaptivePad)

                    return await this.bot.browser.func.getSearchPoints()
                }

                // If we reached here, the search box exists. Try focusing and typing.
                // Try focusing and filling instead of clicking (more reliable on mobile)
                let navigatedDirectly = false
                try {
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

                await this.bot.browser.utils.reloadBadPage(resultPage).catch(() => {})

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(resultPage)
                }

                if (this.bot.config.searchSettings.clickRandomResults) {
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

    // === SINGLE-QUERY LLM (OpenRouter via openai client) ===
    private async getSingleQueryFromLLM(geoLocale: string = 'US'): Promise<string | null> {
        const envKey = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined;
        const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined;
        const apiKey = envKey || cfgKey;
        if (!apiKey) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'OpenRouter API key not configured', 'error')
            throw new Error('OpenRouter API key not configured');
        }

        const defaultHeaders: Record<string, string> = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };
        if (this.bot.config?.openRouter?.referer) {
            defaultHeaders['HTTP-Referer'] = this.bot.config.openRouter.referer;
            defaultHeaders['Referer'] = this.bot.config.openRouter.referer;
        }
        if (this.bot.config?.openRouter?.title) {
            defaultHeaders['X-Title'] = this.bot.config.openRouter.title;
        }

        const openRouterClient = axios.create({
            baseURL: 'https://openrouter.ai/api/v1',
            headers: defaultHeaders,
            proxy: false,
            timeout: 30_000,
        });

        try {
            const payload = {
                model: 'meta-llama/llama-3.3-70b-instruct:free',
                messages: [
                    { role: 'system', content: `You are an assistant that outputs only one short search query (plain text) that a typical undergraduate university student might type. Keep it short (3-8 words). Use ${geoLocale.toUpperCase()} locale if location-relevant. Avoid politics & adult content. Output MUST be only the query string and nothing else.` },
                    { role: 'user', content: `Provide a single concise search query a university undergrad might use (examples: "econ midterm study guide", "cheap pizza near campus", "debug null pointer c++"). Output only the query text.` }
                ],
                max_tokens: 60,
                temperature: 0.7
            };

            const resp = await openRouterClient.post('/chat/completions', payload);
            const completion = resp?.data;
            const rawContent = completion?.choices?.[0]?.message?.content ?? completion?.choices?.[0]?.text ?? null;

            if (!rawContent) {
                const serialized = JSON.stringify(completion).slice(0, 2000);
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `No content found in completion. Preview: ${serialized}`, 'error');
                throw new Error('No content returned from OpenRouter (completion empty)');
            }

            const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim();
            const cleanedLines = stripFences(rawContent).split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
            const candidate = cleanedLines.length ? cleanedLines[0] : String(rawContent).trim();
            const final = String(candidate).replace(/(^"|"$)/g, '').trim();

            if (!final || final.length < 2) {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `LLM returned an invalid/too-short query: "${final}"`, 'warn');
                return null;
            }
            if (final.length > 200) return final.slice(0, 200);
            return final;

        } catch (err: any) {
            const message = err?.message || JSON.stringify(err);
            if (err?.response?.data) {
                try {
                    const body = err.response.data;
                    if (body?.error) {
                        const emsg = body.error?.message ?? JSON.stringify(body.error);
                        const ecode = body.error?.code ?? err?.response?.status;
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `OpenRouter returned error (${ecode}): ${emsg}`, 'error');
                        throw new Error(`OpenRouter error ${ecode}: ${emsg}`);
                    }
                } catch (parseErr) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Error parsing OpenRouter error body: ${parseErr}`, 'warn');
                }
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `OpenRouter request failed: ${message}`, 'error');
            throw err;
        }
    }


    private async getGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Generating search queries | GeoLocale: ${geoLocale}`);

        // Human-like delay before fetching trends (increased for safety)
        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000));

        try {
            const request: AxiosRequestConfig = {
                url: 'https://trends.google.com/_/TrendsUi/data/batchexecute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'Accept': '*/*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://trends.google.com/trends/',
                    'Origin': 'https://trends.google.com'
                },
                data: `f.req=[[[i0OFE,"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`,
                responseType: 'text',
                timeout: (this.bot.config?.googleTrends?.timeoutMs) || 20000,
                // IMPORTANT: disable proxy for Trends requests
                proxy: false
            };

            // Try to improve DNS but don't rely on proxies
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const dns = require('dns');
                const lookup = (hostname: string, options: any, callback: Function) => {
                    dns.lookup(hostname, { family: 4 }, (err: any, address: any, family: any) => {
                        if (err) {
                            dns.lookup(hostname, (err2: any, address2: any, family2: any) => {
                                callback(err2, address2, family2);
                            });
                        } else {
                            callback(err, address, family);
                        }
                    });
                };
                request.httpsAgent = new (require('https').Agent)({
                    keepAlive: true,
                    lookup,
                    rejectUnauthorized: true
                });
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'DNS agent creation failed, using default: ' + (e instanceof Error ? e.message : String(e)), 'warn');
            }

            // Make the request with explicit proxy disabled
            const response = await axios.request(request as any)

            // Handle different response formats
            let rawText: string
            if (typeof response.data === 'string') {
                rawText = response.data
            } else if (Buffer.isBuffer(response.data)) {
                rawText = response.data.toString('utf8')
            } else {
                rawText = JSON.stringify(response.data)
            }

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

            const mappedTrendsData = trendsData.map((query: any) => [
                query[0],
                query[9] ? query[9].slice(1) : []
            ])

            if (mappedTrendsData.length < 50 && geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Insufficient trends for ${geoLocale} (${mappedTrendsData.length}), falling back to US`, 'warn')
                return this.getGoogleTrends('US')
            }

            for (const [topic, relatedQueries] of mappedTrendsData) {
                if (topic && typeof topic === 'string' && topic.trim().length > 0) {
                    queryTerms.push({
                        topic: topic.trim(),
                        related: Array.isArray(relatedQueries) ? relatedQueries.filter(q => typeof q === 'string') : []
                    })
                }
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Successfully fetched ${queryTerms.length} search queries`)

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Error fetching trends: ' + errorMessage, 'error')

            if (errorMessage.includes('IP address') || errorMessage.includes('Invalid IP')) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Google is blocking requests due to IP issues. Consider:', 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', '- Using a VPN or proxy rotation', 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', '- Increasing delays between requests', 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', '- Reducing request frequency', 'error')
            }

            if (geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Falling back to US locale after error', 'warn')
                return this.getGoogleTrends('US')
            }
        }

        return queryTerms
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

    // Restored the original working clickRandomLink implementation
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
}