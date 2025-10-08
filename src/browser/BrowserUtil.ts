// src/browser/BrowserUtil.ts
import { Page } from 'rebrowser-playwright'
import { load } from 'cheerio'

import { MicrosoftRewardsBot } from '../index'

export default class BrowserUtil {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Try to dismiss a wide variety of popups/banners in multiple passes.
     * Uses short timeouts and is resilient to missing elements.
     */
    async tryDismissAllMessages(page: Page): Promise<void> {
        const attempts = 3
        const buttonGroups: { selector: string; label: string; isXPath?: boolean }[] = [
            { selector: '#acceptButton', label: 'AcceptButton' },
            { selector: '.optanon-allow-all, .optanon-alert-box-button', label: 'OneTrust Accept' },
            { selector: '.ext-secondary.ext-button', label: 'Skip For Now' },
            { selector: '#iLandingViewAction', label: 'Landing Continue' },
            { selector: '#iShowSkip', label: 'Show Skip' },
            { selector: '#iNext', label: 'Next' },
            { selector: '#iLooksGood', label: 'LooksGood' },
            { selector: '#idSIButton9', label: 'PrimaryLoginButton' },
            { selector: '.ms-Button.ms-Button--primary', label: 'Primary Generic' },
            { selector: '.c-glyph.glyph-cancel', label: 'Mobile Welcome Cancel' },
            { selector: '.maybe-later, button[data-automation-id*="maybeLater" i]', label: 'Maybe Later' },
            { selector: '#bnp_btn_reject', label: 'Bing Cookie Reject' },
            { selector: '#bnp_btn_accept', label: 'Bing Cookie Accept' },
            { selector: '#bnp_close_link', label: 'Bing Cookie Close' },
            { selector: '#reward_pivot_earn', label: 'Rewards Pivot Earn' },
            { selector: '//div[@id="cookieConsentContainer"]//button[contains(text(), "Accept")]', label: 'Legacy Cookie Accept', isXPath: true }
        ]

        for (let round = 0; round < attempts; round++) {
            let dismissedThisRound = 0
            for (const btn of buttonGroups) {
                try {
                    const loc = btn.isXPath ? page.locator(`xpath=${btn.selector}`) : page.locator(btn.selector)
                    if (await loc.first().isVisible({ timeout: 2000 }).catch(() => false)) {
                        await loc.first().click({ timeout: 2000 }).catch(() => { })
                        dismissedThisRound++
                        this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', `Dismissed: ${btn.label}`)
                        await page.waitForTimeout(150)
                    }
                } catch { /* ignore */ }
            }

            // Special-case overlay handling (common cookie/consent overlays)
            try {
                const overlay = page.locator('#bnp_overlay_wrapper')
                if (await overlay.isVisible({ timeout: 2000 }).catch(() => false)) {
                    const reject = overlay.locator('#bnp_btn_reject, button[aria-label*="Reject" i]')
                    const accept = overlay.locator('#bnp_btn_accept')
                    if (await reject.first().isVisible().catch(() => false)) {
                        await reject.first().click({ timeout: 2000 }).catch(() => { })
                        this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Overlay Reject')
                        dismissedThisRound++
                    } else if (await accept.first().isVisible().catch(() => false)) {
                        await accept.first().click({ timeout: 2000 }).catch(() => { })
                        this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Overlay Accept')
                        dismissedThisRound++
                    }
                }
            } catch { /* ignore */ }

            if (dismissedThisRound === 0) break // nothing new dismissed -> stop early
        }
    }

    /**
     * Return the latest tab (last page in context).
     * Throws a proper Error after logging on failure.
     */
    async getLatestTab(page: Page): Promise<Page> {
        try {
            await this.bot.utils.wait(1000)

            const browser = page.context()
            const pages = browser.pages()
            const newTab = pages[pages.length - 1]

            if (newTab) {
                return newTab
            }

            this.bot.log(this.bot.isMobile, 'GET-NEW-TAB', 'Unable to get latest tab', 'error')
            throw new Error('GET-NEW-TAB: Unable to get latest tab')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-NEW-TAB', 'An error occurred:' + error, 'error')
            throw new Error('GET-NEW-TAB error: ' + error)
        }
    }

    /**
     * Get commonly-used tabs: homeTab (rewards page) and workerTab (the worker tab).
     * This is more robust than relying on fixed indices.
     */
    async getTabs(page: Page) {
        try {
            const browser = page.context()
            const pages = browser.pages()

            if (!pages || pages.length === 0) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'No pages found in context', 'error')
                throw new Error('GET-TABS: No pages found in context')
            }

            // Try to find the home/rewards tab by hostname
            let homeTab: Page | undefined = undefined
            for (const p of pages) {
                try {
                    const url = new URL(p.url())
                    if (url.hostname.includes('rewards.bing.com') || url.hostname.includes('bing.com')) {
                        homeTab = p
                        break
                    }
                } catch { /* ignore invalid urls */ }
            }

            // fallback: use second page if available (legacy behaviour)
            if (!homeTab && pages.length > 1) {
                homeTab = pages[1]
            }

            if (!homeTab) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'Home tab could not be found!', 'error')
                throw new Error('GET-TABS: Home tab could not be found')
            }

            // Worker tab: prefer last page that is not the home tab
            let workerTab: Page | undefined = undefined
            for (let i = pages.length - 1; i >= 0; i--) {
                const p = pages[i]
                if (p !== homeTab) { workerTab = p; break }
            }

            if (!workerTab) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'Worker tab could not be found!', 'error')
                throw new Error('GET-TABS: Worker tab could not be found')
            }

            // Validate home tab hostname for safety
            try {
                const homeTabURL = new URL(homeTab.url())
                if (!homeTabURL.hostname.includes('rewards.bing.com') && !homeTabURL.hostname.includes('bing.com')) {
                    this.bot.log(this.bot.isMobile, 'GET-TABS', 'Reward page hostname is unexpected: ' + homeTabURL.host, 'warn')
                }
            } catch { /* ignore */ }

            return { homeTab, workerTab }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-TABS', 'An error occurred:' + error, 'error')
            throw new Error('GET-TABS error: ' + error)
        }
    }

    /**
     * Reload pages showing the Playwright/neterror page.
     */
    async reloadBadPage(page: Page): Promise<void> {
        try {
            const html = await page.content().catch(() => '')
            const $ = load(html)

            const isNetworkError = $('body.neterror').length

            if (isNetworkError) {
                this.bot.log(this.bot.isMobile, 'RELOAD-BAD-PAGE', 'Bad page detected, reloading!')
                await page.reload()
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'RELOAD-BAD-PAGE', 'An error occurred:' + error, 'error')
            throw new Error('RELOAD-BAD-PAGE error: ' + error)
        }
    }

    /**
     * Perform small human-like gestures: short waits, minor mouse moves and occasional scrolls.
     * Controlled via config: bot.config.humanization
     */
    async humanizePage(page: Page): Promise<void> {
        try {
            const h = this.bot.config?.humanization || {}
            if (h.enabled === false) return
            const moveProb = typeof h.gestureMoveProb === 'number' ? h.gestureMoveProb : 0.4
            const scrollProb = typeof h.gestureScrollProb === 'number' ? h.gestureScrollProb : 0.2
            // minor mouse move
            if (Math.random() < moveProb) {
                const x = Math.floor(Math.random() * 30) + 5
                const y = Math.floor(Math.random() * 20) + 3
                await page.mouse.move(x, y, { steps: 2 }).catch(() => { })
            }
            // tiny scroll
            if (Math.random() < scrollProb) {
                const dy = (Math.random() < 0.5 ? 1 : -1) * (Math.floor(Math.random() * 150) + 50)
                await page.mouse.wheel(0, dy).catch(() => { })
            }
            // Random short wait; override via humanization.actionDelay
            const range = h.actionDelay
            if (range && typeof range.min !== 'undefined' && typeof range.max !== 'undefined') {
                try {
                    const ms = (await import('ms')).default
                    const min = typeof range.min === 'number' ? range.min : ms(String(range.min))
                    const max = typeof range.max === 'number' ? range.max : ms(String(range.max))
                    if (typeof min === 'number' && typeof max === 'number' && max >= min) {
                        await this.bot.utils.wait(this.bot.utils.randomNumber(Math.max(0, min), Math.min(max, 5000)))
                    } else {
                        await this.bot.utils.wait(this.bot.utils.randomNumber(150, 450))
                    }
                } catch {
                    await this.bot.utils.wait(this.bot.utils.randomNumber(150, 450))
                }
            } else {
                await this.bot.utils.wait(this.bot.utils.randomNumber(150, 450))
            }
        } catch { /* swallow to not break normal flow */ }
    }

    /**
     * Capture minimal diagnostics for a page: screenshot + HTML content.
     * Files are written under ./reports/<date>/ with a safe label.
     */
    async captureDiagnostics(page: Page, label: string): Promise<void> {
        try {
            const cfg = this.bot.config?.diagnostics || {}
            if (cfg.enabled === false) return
            const maxPerRun = typeof cfg.maxPerRun === 'number' ? cfg.maxPerRun : 8
            if (!this.bot.tryReserveDiagSlot(maxPerRun)) return

            const safe = label.replace(/[^a-z0-9-_]/gi, '_').slice(0, 64)
            const now = new Date()
            const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
            const baseDir = `${process.cwd()}/reports/${day}`
            const fs = await import('fs')
            const path = await import('path')
            if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true })
            const ts = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`
            const shot = path.join(baseDir, `${ts}_${safe}.png`)
            const htmlPath = path.join(baseDir, `${ts}_${safe}.html`)
            if (cfg.saveScreenshot !== false) {
                await page.screenshot({ path: shot }).catch(() => { })
            }
            if (cfg.saveHtml !== false) {
                const html = await page.content().catch(() => '<html></html>')
                fs.writeFileSync(htmlPath, html)
            }
            this.bot.log(this.bot.isMobile, 'DIAG', `Saved diagnostics to ${shot} and ${htmlPath}`)
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'DIAG', `Failed to capture diagnostics: ${e instanceof Error ? e.message : e}`, 'warn')
        }
    }
}
