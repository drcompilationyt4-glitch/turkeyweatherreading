// src/workers/SearchOnBing.ts
import { Page } from 'rebrowser-playwright'
import * as fs from 'fs'
import path from 'path'

// If you want to load .env automatically when running locally, either
// call require('dotenv').config() in your app entry or uncomment the line below:
// import 'dotenv/config'

import { Workers } from '../Workers'
import { MorePromotion, PromotionalItem } from '../../interface/DashboardData'

export class SearchOnBing extends Workers {
    /**
     * Main flow to perform "Search on Bing" activity.
     * - Uses configured local queries.json when enabled, otherwise fetches remote repo file.
     * - If no matching query is found, optionally calls OpenRouter to generate a concise query and (optionally) cache it.
     * - Uses robust element interaction with fallback direct navigation to ensure the search completes.
     */
    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem) {
        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Trying to complete SearchOnBing')

        try {
            // Human-like delay before starting (2-5s)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))

            // Clear common overlays first
            await this.bot.browser.utils.tryDismissAllMessages(page)

            const query = await this.getSearchQuery(activity.title)

            const searchBar = '#sb_form_q'
            // prefer locator + attached state for robustness
            const box = page.locator(searchBar)
            await box.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {
                // If the search bar never attached, we'll try direct navigation fallback below
            })

            // try multiple approaches to type and submit the query
            try {
                // try dismiss overlays again (sometimes they appear late)
                await this.bot.browser.utils.tryDismissAllMessages(page)
                await this.bot.utils.wait(200)

                // Focus / fill / type aggressively but human-like
                await box.focus({ timeout: 2000 }).catch(() => { /* ignore focus errors */ })
                await box.fill('')
                await this.bot.utils.wait(200)
                // Type with a slight delay between keystrokes to appear human
                await page.keyboard.type(query, { delay: 20 })
                // Small pause before enter
                await this.bot.utils.wait(this.bot.utils.randomNumber(200, 800))
                await page.keyboard.press('Enter')
            } catch (typeErr) {
                // As robust fallback, navigate directly to the search results URL
                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                await page.goto(url).catch(() => { /* last-resort navigation */ })
            }

            // Let results settle
            await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 5000))

            // Small extra wait to mimic a real visit
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

            // Close the results/worker page
            try { await page.close() } catch (e) { /* ignore close errors */ }

            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Completed the SearchOnBing successfully')
        } catch (error) {
            // On any error: attempt a safe close, log and continue
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'An error occurred:' + String(error), 'error')
        }
    }

    /**
     * Resolve a short search query for a given promotion title.
     * Flow:
     *  - If config.searchOnBingLocalQueries is true, read local queries.json.
     *  - Otherwise attempt to fetch the repository raw queries.json.
     *  - If not found, optionally call OpenRouter for a generated query and optionally cache it.
     */
    private async getSearchQuery(title: string): Promise<string> {
        // Human-like delay before fetching query (0.5-1.5s)
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        interface Queries {
            title: string;
            queries: string[]
        }

        let queries: Queries[] = []

        try {
            if (this.bot.config && this.bot.config.searchOnBingLocalQueries) {
                // Read local queries.json shipped with the code
                const data = fs.readFileSync(path.join(__dirname, '../queries.json'), 'utf8')
                queries = JSON.parse(data)
            } else {
                // Fetch from GitHub raw so users don't need to pull updates manually
                // small human-like delay before web request
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))

                const response = await this.bot.axios.request({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/main/src/functions/queries.json',
                    timeout: 8000
                }).catch(() => ({ data: null }))

                if (response && response.data) {
                    queries = response.data
                } else {
                    queries = []
                }
            }

            // Try to find an exact / normalized match
            const answers = queries.find(x => this.normalizeString(x.title) === this.normalizeString(title))
            if (answers && Array.isArray(answers.queries) && answers.queries.length > 0) {
                const answer = this.bot.utils.shuffleArray(answers.queries)[0] as string
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Found local/remote answer: ${answer} | question: ${title}`)
                return answer
            }

            // No pre-defined query found -> optionally ask LLM (OpenRouter) if configured
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `No local/remote query found for: ${title}. Attempting LLM fallback if configured...`)

            // Only call LLM if enabled in config (defensive)
            const allowLLM = !!(this.bot.config && this.bot.config.enableOpenRouterForQueries)
            if (allowLLM) {
                const llmQuery = await this.callOpenRouterForQuery(title)
                if (llmQuery) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `LLM answer: ${llmQuery} | question: ${title}`)

                    // Optional: cache generated query back to local queries.json if enabled
                    if (this.bot.config && this.bot.config.cacheGeneratedQueries) {
                        try {
                            const localPath = path.join(__dirname, '../queries.json')
                            let existing: Queries[] = []
                            if (fs.existsSync(localPath)) {
                                existing = JSON.parse(fs.readFileSync(localPath, 'utf8'))
                            }
                            existing.push({ title, queries: [llmQuery] })
                            fs.writeFileSync(localPath, JSON.stringify(existing, null, 2), 'utf8')
                            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Cached generated query for title: ${title}`)
                        } catch (cacheErr) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Caching failed: ${String(cacheErr)}`, 'warn')
                        }
                    }

                    return llmQuery
                } else {
                    this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'LLM fallback failed or returned empty', 'warn')
                }
            } else {
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'LLM fallback disabled by configuration', 'log')
            }

            // Final fallback: use the title itself as the query
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Falling back to title for query: ${title}`)
            return title

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'An error occurred while resolving query:' + String(error), 'error')
            return title
        }
    }

    private normalizeString(input: string): string {
        return input.normalize('NFD').trim().toLowerCase().replace(/[^\x20-\x7E]/g, '').replace(/[?!]/g, '')
    }

    /**
     * Calls OpenRouter's chat completions endpoint to generate a short query.
     * Reads API key from environment variable OPENROUTER_API_KEY or from bot.config.openRouterApiKey.
     * This is optional and only used when bot.config.enableOpenRouterForQueries is true.
     */
    private async callOpenRouterForQuery(title: string): Promise<string | null> {
        try {
            // small delay to appear human-like
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800))

            const envKey = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined
            const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined
            const apiKey = envKey || cfgKey

            if (!apiKey) {
                this.bot.log(this.bot.isMobile, 'OPENROUTER', 'Missing OpenRouter API key (process.env.OPENROUTER_API_KEY or bot.config.openRouterApiKey).', 'warn')
                return null
            }

            const model = (this.bot.config && this.bot.config.openRouterModel) || 'openai/gpt-4o-mini:2024-12-17'

            const promptSystem = `You are a concise assistant that outputs a single short Bing search query. Output only the query (no commentary).`
            const promptUser = `Promotional title: "${title}". Provide a concise search query (2-8 words) that a user would enter into Bing to find relevant pages.`

            const payload: any = {
                model,
                messages: [
                    { role: 'system', content: promptSystem },
                    { role: 'user', content: promptUser }
                ],
                max_tokens: 64,
                temperature: (this.bot.config && typeof this.bot.config.openRouterTemperature === 'number') ? this.bot.config.openRouterTemperature : 0.2,
            }

            if (this.bot.config && typeof this.bot.config.openRouterProvider === 'string') {
                payload.provider = this.bot.config.openRouterProvider
            }
            if (this.bot.config && this.bot.config.openRouterZdrOnly) {
                payload.zdr = true
            }

            const resp = await this.bot.axios.request({
                method: 'POST',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                data: payload,
                timeout: 15000
            })

            let llmText: string | undefined

            if (resp && resp.data && Array.isArray(resp.data.choices) && resp.data.choices.length > 0) {
                const msg = resp.data.choices[0].message
                if (msg && typeof msg.content === 'string') llmText = msg.content
                else if (typeof resp.data.choices[0].text === 'string') llmText = resp.data.choices[0].text
            }

            if (!llmText && resp.data && typeof resp.data.output_text === 'string') llmText = resp.data.output_text
            if (!llmText && resp.data && Array.isArray(resp.data.result) && resp.data.result[0]) {
                const r0 = resp.data.result[0]
                if (r0?.content) {
                    if (Array.isArray(r0.content) && typeof r0.content[0] === 'string') llmText = r0.content[0]
                    else if (typeof r0.content === 'string') llmText = r0.content
                }
            }

            if (!llmText) return null

            const cleaned = llmText.trim().split('\n').map(s => s.trim()).filter(Boolean)[0] || ''
            const stripped = cleaned.replace(/^["']|["']$/g, '').trim()
            const finalText = stripped.length > 200 ? stripped.slice(0, 200) : stripped

            return finalText || null
        } catch (err: any) {
            const status = err?.response?.status
            const respData = err?.response?.data

            if (status === 404 && respData && typeof respData === 'object') {
                const msg = (respData?.error?.message) || String(respData)
                if (typeof msg === 'string' && msg.includes('No endpoints found matching your data policy')) {
                    this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed due to OpenRouter privacy settings. Please enable model endpoints at https://openrouter.ai/settings/privacy', 'error')
                    return null
                }
            }

            const errMsg = err?.response ? `status ${status} - ${JSON.stringify(respData)}` : String(err)
            this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed: ' + errMsg, 'error')
            return null
        }
    }
}
