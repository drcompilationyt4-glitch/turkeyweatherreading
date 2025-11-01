import { Page } from 'rebrowser-playwright'
import { load } from 'cheerio'

import { MicrosoftRewardsBot } from '../index'
import { captureDiagnostics as captureSharedDiagnostics } from '../util/Diagnostics'

type DismissButton = { selector: string; label: string; isXPath?: boolean }

export default class BrowserUtil {
    private bot: MicrosoftRewardsBot

    private static readonly DISMISS_BUTTONS: readonly DismissButton[] = [
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

    private static readonly OVERLAY_SELECTORS = {
        container: '#bnp_overlay_wrapper',
        reject: '#bnp_btn_reject, button[aria-label*="Reject" i]',
        accept: '#bnp_btn_accept'
    } as const

    private static readonly STREAK_DIALOG_SELECTORS = {
        container: '[role="dialog"], div[role="alert"], div.ms-Dialog',
        textFilter: /streak protection has run out/i,
        closeButtons: 'button[aria-label*="close" i], button:has-text("Close"), button:has-text("Dismiss"), button:has-text("Got it"), button:has-text("OK"), button:has-text("Ok")'
    } as const

    private static readonly TERMS_UPDATE_SELECTORS = {
        titleId: '#iTOUTitle',
        titleText: /we're updating our terms/i,
        nextButton: 'button[data-testid="primaryButton"]:has-text("Next"), button[type="submit"]:has-text("Next")'
    } as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Try to dismiss a wide variety of popups/banners in multiple passes.
     */
    async tryDismissAllMessages(page: Page): Promise<void> {
        const maxRounds = 3
        for (let round = 0; round < maxRounds; round++) {
            try {
                const dismissed = await this.dismissRound(page)
                if (dismissed === 0) break
            } catch (e) {
                // don't fail the caller because of dismiss failures
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', `Dismiss round failed: ${e instanceof Error ? e.message : String(e)}`, 'warn')
            }
        }
    }

    private async dismissRound(page: Page): Promise<number> {
        let count = 0
        count += await this.dismissStandardButtons(page)
        count += await this.dismissOverlayButtons(page)
        count += await this.dismissStreakDialog(page)
        count += await this.dismissTermsUpdateDialog(page)
        return count
    }

    private async dismissStandardButtons(page: Page): Promise<number> {
        let count = 0
        for (const btn of BrowserUtil.DISMISS_BUTTONS) {
            const dismissed = await this.tryClickButton(page, btn)
            if (dismissed) {
                count++
                await page.waitForTimeout(150)
            }
        }
        return count
    }

    private async tryClickButton(page: Page, btn: DismissButton): Promise<boolean> {
        try {
            const loc = btn.isXPath ? page.locator(`xpath=${btn.selector}`) : page.locator(btn.selector)
            const visible = await loc.first().isVisible({ timeout: 200 }).catch(() => false)
            if (!visible) return false

            await loc.first().click({ timeout: 500 }).catch(() => {})
            this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', `Dismissed: ${btn.label}`)
            return true
        } catch {
            return false
        }
    }

    private async dismissOverlayButtons(page: Page): Promise<number> {
        try {
            const { container, reject, accept } = BrowserUtil.OVERLAY_SELECTORS
            const overlay = page.locator(container)
            const visible = await overlay.isVisible({ timeout: 200 }).catch(() => false)
            if (!visible) return 0

            const rejectBtn = overlay.locator(reject)
            if (await rejectBtn.first().isVisible().catch(() => false)) {
                await rejectBtn.first().click({ timeout: 500 }).catch(() => {})
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Overlay Reject')
                return 1
            }

            const acceptBtn = overlay.locator(accept)
            if (await acceptBtn.first().isVisible().catch(() => false)) {
                await acceptBtn.first().click({ timeout: 500 }).catch(() => {})
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Overlay Accept')
                return 1
            }

            return 0
        } catch {
            return 0
        }
    }

    private async dismissStreakDialog(page: Page): Promise<number> {
        try {
            const { container, textFilter, closeButtons } = BrowserUtil.STREAK_DIALOG_SELECTORS
            const dialog = page.locator(container).filter({ hasText: textFilter })
            const visible = await dialog.first().isVisible({ timeout: 200 }).catch(() => false)
            if (!visible) return 0

            const closeBtn = dialog.locator(closeButtons).first()
            if (await closeBtn.isVisible({ timeout: 200 }).catch(() => false)) {
                await closeBtn.click({ timeout: 500 }).catch(() => {})
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Streak Protection Dialog Button')
                return 1
            }

            await page.keyboard.press('Escape').catch(() => {})
            this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Streak Protection Dialog Escape')
            return 1
        } catch {
            return 0
        }
    }

    private async dismissTermsUpdateDialog(page: Page): Promise<number> {
        try {
            const { titleId, titleText, nextButton } = BrowserUtil.TERMS_UPDATE_SELECTORS

            const titleById = page.locator(titleId)
            const titleByText = page.locator('h1').filter({ hasText: titleText })

            const hasTitle = await titleById.isVisible({ timeout: 200 }).catch(() => false) ||
                await titleByText.first().isVisible({ timeout: 200 }).catch(() => false)

            if (!hasTitle) return 0

            const nextBtn = page.locator(nextButton).first()
            if (await nextBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                await nextBtn.click({ timeout: 1000 }).catch(() => {})
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Dismissed: Terms Update Dialog (Next)')
                await page.waitForTimeout(1000)
                return 1
            }

            return 0
        } catch {
            return 0
        }
    }

    /**
     * Return the latest tab (last page in context).
     */
    async getLatestTab(page: Page): Promise<Page> {
        try {
            await this.bot.utils.wait(1000)

            const browser = page.context()
            const pages = browser.pages()
            const newTab = pages[pages.length - 1]

            if (newTab) return newTab

            this.bot.log(this.bot.isMobile, 'GET-NEW-TAB', 'Unable to get latest tab', 'error')
            throw new Error('GET-NEW-TAB: Unable to get latest tab')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-NEW-TAB', 'An error occurred:' + error, 'error')
            throw new Error('GET-NEW-TAB error: ' + error)
        }
    }

    /**
     * Get commonly-used tabs: homeTab (rewards page) and workerTab (the worker tab).
     */
    async getTabs(page: Page) {
        try {
            const browser = page.context()
            const pages = browser.pages()

            if (!pages || pages.length === 0) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'No pages found in context', 'error')
                throw new Error('GET-TABS: No pages found in context')
            }

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

            if (!homeTab && pages.length > 1) {
                homeTab = pages[1]
            }

            if (!homeTab) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'Home tab could not be found!', 'error')
                throw new Error('GET-TABS: Home tab could not be found')
            }

            let workerTab: Page | undefined = undefined
            for (let i = pages.length - 1; i >= 0; i--) {
                const p = pages[i]
                if (p !== homeTab) { workerTab = p; break }
            }

            if (!workerTab) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'Worker tab could not be found!', 'error')
                throw new Error('GET-TABS: Worker tab could not be found')
            }

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
     * Perform small human-like gestures.
     * Prefer bot.humanizer if available; otherwise fall back to a lightweight local implementation.
     */
    async humanizePage(page: Page): Promise<void> {
        try {
            // Prefer centralized humanizer (newer main-branch API)
            if ((this.bot as any).humanizer && typeof (this.bot as any).humanizer.microGestures === 'function') {
                await (this.bot as any).humanizer.microGestures(page)
                if (typeof (this.bot as any).humanizer.actionPause === 'function') {
                    await (this.bot as any).humanizer.actionPause()
                }
                return
            }

            // Fallback: local micro-gestures
            const h = this.bot.config?.humanization || {}
            if (h.enabled === false) return
            const moveProb = typeof h.gestureMoveProb === 'number' ? h.gestureMoveProb : 0.4
            const scrollProb = typeof h.gestureScrollProb === 'number' ? h.gestureScrollProb : 0.2
            if (Math.random() < moveProb) {
                const x = Math.floor(Math.random() * 30) + 5
                const y = Math.floor(Math.random() * 20) + 3
                await page.mouse.move(x, y, { steps: 2 }).catch(() => { })
            }
            if (Math.random() < scrollProb) {
                const dy = (Math.random() < 0.5 ? 1 : -1) * (Math.floor(Math.random() * 150) + 50)
                await page.mouse.wheel(0, dy).catch(() => { })
            }
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
     * Capture minimal diagnostics for a page using shared util if available, otherwise fallback to inline.
     */
    async captureDiagnostics(page: Page, label: string): Promise<void> {
        try {
            if (typeof captureSharedDiagnostics === 'function') {
                await captureSharedDiagnostics(this.bot, page, label)
                return
            }
        } catch (e) {
            // fall through to inline fallback
        }

        // Inline fallback (behaviour preserved from feature-branch)
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
