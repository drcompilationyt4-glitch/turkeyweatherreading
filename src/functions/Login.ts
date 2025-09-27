import { generateTOTP } from '../util/Totp'
import playwright, { Page } from 'rebrowser-playwright'
import readline from 'readline'
import * as crypto from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'

import { OAuth } from '../interface/OAuth'

export interface LoginErrorEvent {
    type: 'MOBILE_AUTH_FAILED' | 'LOGIN_FAILED' | 'ACCOUNT_LOCKED';
    email: string;
    message: string;
    retryAfterMs?: number;
    shouldRestartBrowsers?: boolean;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

// Default wait time after sending verification email (ms).
const DEFAULT_EMAIL_WAIT_MS = 4000
const DEFAULT_GMAIL_NAV_WAIT_MS = 2500
const DEFAULT_PASSWORD_FILL_DELAY_MS = 600

// Wait 3-4 minutes before checking Gmail to allow delivery
const MIN_EMAIL_WAIT_BEFORE_FETCH_MS = 9.5 * 60 * 1000
const MAX_EMAIL_WAIT_BEFORE_FETCH_MS = 10 * 60 * 1000

// Backoff wait range (10-15 minutes) between full-login retries
const MIN_RETRY_BACKOFF_MS = 10 * 60 * 1000
const MAX_RETRY_BACKOFF_MS = 15 * 60 * 1000

export class Login {
    private bot: MicrosoftRewardsBot
    private clientId: string = '0000000040170455'
    private authBaseUrl: string = 'https://login.live.com/oauth20_authorize.srf'
    private redirectUrl: string = 'https://login.live.com/oauth20_desktop.srf'
    private tokenUrl: string = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
    private scope: string = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'

    // Add TOTP support
    private currentTotpSecret?: string

    // Add error event emitter
    private errorCallbacks: ((error: LoginErrorEvent) => void)[] = []

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    // Method to register error callbacks
    onError(callback: (error: LoginErrorEvent) => void) {
        this.errorCallbacks.push(callback)
    }

    // Method to emit errors
    private emitError(error: LoginErrorEvent) {
        this.errorCallbacks.forEach(callback => {
            try {
                callback(error)
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'LOGIN-ERROR', `Error in error callback: ${e}`, 'error')
            }
        })
    }

    // Handle common optional login prompts (Stay signed in?, Skip, Not now, etc.).
    // If a prompt is detected and dismissed, perform a randomized longer wait (1-1.5 minutes)
    // to ensure the UI/session fully stabilizes before proceeding.
    private async randomLongWait(page: Page, minMs: number = 60000, maxMs: number = 90000) {
        const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        // small initial pause then the long wait
        await page.waitForTimeout(500);

        // Handle optional post-login prompts and wait if any were dismissed
        await this.handleOptionalPrompts(page);
        await page.waitForTimeout(ms);
    }

    private async handleOptionalPrompts(page: Page) {
        // A conservative list of selectors for common Microsoft login prompts.
        const tries = [
            `button#idBtn_Back`, // often the "No" button
            `button#idSIButton9`,
            `button:has-text("No")`,
            `button:has-text("Don't show again")`,
            `button:has-text("Skip")`,
            `button:has-text("Not now")`,
            `button:has-text("Use another account")`,
            `button:has-text("Continue")`,
            `input[type="button"][value="No"]`,
        ];

        for (const sel of tries) {
            try {
                const handle = await page.$(sel);
                if (handle) {
                    try {
                        await handle.click();
                    } catch (e) {
                        try {
                            await page.evaluate((s) => {
                                const el = document.querySelector(s) as HTMLElement | null;
                                if (el) el.click();
                            }, sel);
                        } catch (ee) {
                            // ignore
                        }
                    }
                    // Give a short pause for UI changes
                    await page.waitForTimeout(800);
                    // After dismissing a prompt, wait a randomized long delay to ensure the rewards page has settled.
                    await this.randomLongWait(page);
                    // After handling one prompt, continue to check if more prompts appear.
                }
            } catch (e) {
                // ignore and continue
            }
        }

        // As a fallback, press Escape if a dialog overlay is detected
        try {
            const dialog = await page.$('[role="dialog"], .modal, .ms-Dialog, .overlay, .authModal');
            if (dialog) {
                const isVisible = await (dialog as any).isVisible?.();
                if (isVisible !== false) {
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(600);
                }
            }
        } catch (e) {
            // ignore
        }
    }



    async login(page: Page, email: string, password: string, totpSecret?: string) {
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Starting login process!')

            // Store TOTP secret if provided
            this.currentTotpSecret = (totpSecret && totpSecret.trim()) || undefined;

            // Navigate to the Bing login page
            await page.goto('https://rewards.bing.com/signin')

            // Disable FIDO support in login request
            await page.route('**/GetCredentialType.srf*', (route) => {
                const pd = route.request().postData() || '{}'
                let body: any = {}
                try { body = JSON.parse(pd) } catch { body = {} }
                body.isFidoSupported = false
                route.continue({ postData: JSON.stringify(body) })
            })

            await page.waitForLoadState('domcontentloaded').catch(() => { })
            await this.bot.browser.utils.reloadBadPage(page)

            // Check if account is locked
            await this.checkAccountLocked(page)

            const isLoggedIn = await page.waitForSelector('html[data-role-name="RewardsPortal"]', { timeout: 10000 }).then(() => true).catch(() => false)

            if (!isLoggedIn) {
                const execResult = await this.execLogin(page, email, password)
                if (!execResult) {
                    // Emit login failure error
                    this.emitError({
                        type: 'LOGIN_FAILED',
                        email: email,
                        message: `Login failed for ${email} after retries`,
                        retryAfterMs: 10 * 60 * 1000, // 10 minutes
                        shouldRestartBrowsers: true
                    });

                    this.bot.log(this.bot.isMobile, 'LOGIN', `Login failed for ${email} after retries — skipping to next account.`, 'warn')
                    return
                }
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Logged into Microsoft successfully')
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Already logged in')
                await this.checkAccountLocked(page)
            }

            // Verify Bing login and save session
            await this.checkBingLogin(page)

            // Sometimes onboarding/welcome modals appear right after login; dismiss them if present
            await this.dismissWelcomeModal(page)

            await saveSessionData(this.bot.config.sessionPath, page.context(), email, this.bot.isMobile)
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Logged in successfully, saved login session!')

            // Clear TOTP secret after successful login
            this.currentTotpSecret = undefined;

        } catch (error) {
            // Clear TOTP secret on error
            this.currentTotpSecret = undefined;

            // Emit error for any login failure
            this.emitError({
                type: 'LOGIN_FAILED',
                email: email,
                message: `Login error for ${email}: ${error}`,
                retryAfterMs: 10 * 60 * 1000, // 10 minutes
                shouldRestartBrowsers: true
            });

            throw this.bot.log(this.bot.isMobile, 'LOGIN', 'An error occurred:' + error, 'error')
        }
    }

    /**
     * Exec login: attempt the full login flow, up to maxAttempts.
     * On retry we open a NEW TAB, go to https://rewards.bing.com, close the previous tab,
     * and re-run the login steps using the fresh tab (this forces a new send/resend).
     *
     * Returns true if login succeeded; false if exhausted retries and the account was marked for later.
     */
    private async execLogin(page: Page, email: string, password: string): Promise<boolean> {
        const maxAttempts = 3

        // We'll operate on currentPage, which may be replaced with a fresh tab on retries.
        let currentPage: Page = page

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN', `execLogin attempt ${attempt}/${maxAttempts}`)

                // On every attempt, navigate to the sign-in page to ensure a fresh start
                try {
                    await currentPage.goto('https://rewards.bing.com/signin', { waitUntil: 'domcontentloaded' })
                    await this.bot.utils.wait(1000)
                    await this.bot.browser.utils.reloadBadPage(currentPage)
                } catch (err) {
                    // if currentPage navigation fails, try creating a new page immediately
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Could not navigate current page to signin: ${err}`, 'warn')
                }

                // Enter email and password/2FA
                await this.enterEmail(currentPage, email)
                await this.bot.utils.wait(1200)
                await this.bot.browser.utils.reloadBadPage(currentPage)
                await this.bot.utils.wait(1200)

                const passResult = await this.enterPassword(currentPage, password)
                if (passResult) {
                    // Flow indicates success (send-code UI not present after OTP). Continue normal checks.
                    await this.bot.utils.wait(1200)
                    await this.bot.browser.utils.reloadBadPage(currentPage)
                    await this.checkLoggedIn(currentPage)

                    // Dismiss any post-login welcome/onboarding modals that sometimes appear
                    await this.dismissWelcomeModal(currentPage)

                    // Close any other tabs except the current one? We won't force-close here.
                    return true
                } else {
                    // We need to retry the full login from scratch (missing/invalid OTP or couldn't fetch)
                    if (attempt < maxAttempts) {
                        // backoff between 10-15 minutes before trying again
                        const backoff = Math.floor(Math.random() * (MAX_RETRY_BACKOFF_MS - MIN_RETRY_BACKOFF_MS + 1)) + MIN_RETRY_BACKOFF_MS
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Login attempt detected failed OTP/send-code present. Waiting ${Math.round(backoff/60000)} minutes before retrying...`, 'warn')
                        await this.bot.utils.wait(backoff)

                        // Open a new tab in same context and navigate to rewards to reset/resend the code
                        try {
                            const context = currentPage.context()
                            const newPage: Page = await (context as any).newPage()
                            await newPage.goto('https://rewards.bing.com', { waitUntil: 'domcontentloaded' })
                            await this.bot.utils.wait(1500)

                            // WAIT: ensure previous page/context settles before closing the old page.
                            // Some environments require ~40-60 seconds to allow background cleanup; add randomized delay.
                            const waitMs = 40000 + Math.floor(Math.random() * 20000); // 40-60 seconds
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Waiting ${waitMs}ms after opening new page before closing old page to avoid race conditions`);
                            await this.bot.utils.wait(waitMs);

                            // Close previous page if it still exists and is different
                            try {
                                if (currentPage && currentPage !== newPage) {
                                    await currentPage.close().catch(() => { })
                                }
                            } catch { /* ignore close errors */ }

                            // Use the new page for the next attempt
                            currentPage = newPage
                            this.bot.log(this.bot.isMobile, 'LOGIN', 'Opened fresh tab for retry and navigated to rewards.bing.com')
                        } catch (err) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to open fresh tab before retrying: ${err}`, 'warn')
                            // small wait before next attempt; attempt loop will retry using the same currentPage
                            await this.bot.utils.wait(2000)
                        }

                        // Continue to next attempt
                        continue
                    } else {
                        // exhausted attempts: handle failed login (do not throw) and return false to caller
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Exceeded maximum login retries due to missing/invalid OTP from Gmail. Marking account to try later and cleaning up.', 'error')
                        try {
                            await this.handleFailedLogin(currentPage, email)
                        } catch (err) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Error while handling failed login cleanup: ${err}`, 'error')
                        }
                        return false
                    }
                }
            } catch (error) {
                if (attempt >= maxAttempts) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `execLogin failed on final attempt: ${error}`, 'error')
                    try {
                        await this.handleFailedLogin(currentPage, email)
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Error while handling failed login cleanup after exception: ${err}`, 'error')
                    }
                    return false
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `execLogin caught error on attempt ${attempt}: ${error}`, 'warn')
                    // small wait then next attempt
                    await this.bot.utils.wait(2000)
                }
            }
        }

        // Shouldn't normally reach here, but indicate failure defensively
        try {
            await this.handleFailedLogin(page, email)
        } catch { }
        return false
    }

    /**
     * Centralized cleanup/marking when a login has permanently failed for an account.
     * - Closes pages/tabs in the current context (best-effort)
     * - Marks the account in this.bot.config.accounts or this.bot.accounts with `doLater = true` (in-memory).
     * - Emits a log message. If your main index.ts has a different mechanism to enqueue the account for later,
     *   replace the marking logic with the project's API (e.g. this.bot.markAccountDoLater(email)).
     */
    private async handleFailedLogin(page: Page, email: string) {
        // Close all pages in the context (best-effort)
        try {
            const ctx = page.context()
            try {
                const pages = ctx.pages()
                for (const p of pages) {
                    try { if (!p.isClosed()) await p.close().catch(() => { }) } catch { }
                }
            } catch { /* ignore individual page close errors */ }

            // Also try closing the context itself if supported
            try { await (ctx as any).close().catch(() => { }) } catch { }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'Closed pages/contexts after failed login (best-effort).')
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to close pages/context: ${err}`, 'warn')
        }

        // Mark the account in memory (doLater flag)
        try {
            const cfg: any = this.bot.config || {}
            let marked = false
            if (Array.isArray(cfg.accounts)) {
                for (const acc of cfg.accounts) {
                    try {
                        if (acc && acc.email && acc.email.toLowerCase() === email.toLowerCase()) {
                            acc.doLater = true
                            marked = true
                            break
                        }
                    } catch { /* ignore */ }
                }
            }

            // fallback bot.accounts
            try {
                const accounts = (this.bot as any).accounts
                if (!marked && Array.isArray(accounts)) {
                    for (const acc of accounts) {
                        try {
                            if (acc && acc.email && acc.email.toLowerCase() === email.toLowerCase()) {
                                acc.doLater = true
                                marked = true
                                break
                            }
                        } catch { }
                    }
                }
            } catch { }

            if (marked) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Marked account ${email} with doLater = true (in-memory).`)
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Could not find account ${email} to mark doLater. Please mark it manually.`, 'warn')
            }

            // If the bot exposes a helper to mark accounts, call it (best-effort).
            try {
                const fn = (this.bot as any).markAccountDoLater || (this.bot as any).queueAccountForLater || (this.bot as any).skipAccount
                if (typeof fn === 'function') {
                    try { await fn.call(this.bot, email) } catch (e) { /* ignore errors */ }
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Called bot helper to mark ${email} for later.`)
                }
            } catch { }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Error while marking account doLater: ${err}`, 'warn')
        }

        // Finally, emit an error-level log so main process / operator sees it
        this.bot.log(this.bot.isMobile, 'LOGIN', `Login failed for ${email} after maximum retries. Account marked to try later.`, 'error')
    }

    private async enterEmail(page: Page, email: string) {
        const emailInputSelector = 'input[type="email"]'

        try {
            const emailField = await page.waitForSelector(emailInputSelector, { state: 'visible', timeout: 7000 }).catch(() => null)
            if (!emailField) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email field not found', 'warn')
                return
            }

            await this.bot.utils.wait(800)

            const emailPrefilled = await page.waitForSelector('#userDisplayName', { timeout: 3000 }).catch(() => null)
            if (emailPrefilled) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email already prefilled by Microsoft')
            } else {
                await page.fill(emailInputSelector, '')
                await this.bot.utils.wait(400)
                await page.fill(emailInputSelector, email)
                await this.bot.utils.wait(800)
            }

            const nextButton = await page.waitForSelector('button[type="submit"]', { timeout: 6000 }).catch(() => null)
            if (nextButton) {
                await nextButton.click()
                await this.bot.utils.wait(2000)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Next button not found after email entry', 'warn')
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Email entry failed: ${error}`, 'error')
        }
    }

    /**
     * Returns true if flow progressed/was handled (login should continue). Returns false if
     * the send-code UI remains after OTP submission (indicating failure), which will trigger a retry.
     */
    private async enterPassword(page: Page, password: string): Promise<boolean> {
        const passwordInputSelector = 'input[type="password"]'
        const skip2FASelector = '#idA_PWD_SwitchToPassword';

        const codeFlowSelectors = [
            'text=Get a code to sign in',
            'button:has-text("Send code")',
            'button:has-text("Send")',
            'button[aria-label="Send code"]',
            '#idDiv_SAOTCS_Proofs',
            'text=/Enter your code/i',
            'text=/Enter the code we sent/i'
        ]

        try {
            const skip2FAButton = await page.waitForSelector(skip2FASelector, { timeout: 2000 }).catch(() => null)
            if (skip2FAButton) {
                await skip2FAButton.click()
                await this.bot.utils.wait(1200)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Skipped 2FA')
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No 2FA skip button found, proceeding with password entry')
            }

            await this.bot.utils.wait(800)

            // FIRST attempt: look directly for password input and fill if present
            const passwordField = await page.waitForSelector(passwordInputSelector, { state: 'visible', timeout: 4000 }).catch(() => null)
            if (passwordField) {
                await this.bot.utils.wait(700)
                await page.fill(passwordInputSelector, '')
                await this.bot.utils.wait(300)
                await page.fill(passwordInputSelector, password)
                await this.bot.utils.wait(400)

                const nextButton = await page.waitForSelector('button[type="submit"]', { timeout: 4000 }).catch(() => null)
                if (nextButton) {
                    await nextButton.click()
                    await this.bot.utils.wait(1800)
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Password entered successfully')
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Next button not found after password entry', 'warn')
                }
                return true
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'Password field not found - checking for explicit "Use your password" / password option')

            // NEW: look for "use your password" / password-option UI and prefer that over send-code flow
            const passwordOptionSelectors = [
                'button:has-text("Use your password")',
                'a:has-text("Use your password")',
                'text=/use your password/i',
                'button:has-text("Sign in with password")',
                'text=/sign in with password/i',
                'button:has-text("Use a password")',
                'text=/use a password/i',
                'text=/use password/i',
                'text=/password/i' // last-resort catch (will be filtered further below)
            ]

            // Try to find and click a password-option element (prefer exact phrases first)
            let passwordOptionClicked = false
            for (const sel of passwordOptionSelectors) {
                try {
                    const el = page.locator(sel).first()
                    if (await el.isVisible().catch(() => false)) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Found potential password-option UI via selector: ${sel}`)
                        // click it and then try to find the password field again
                        try {
                            await el.click().catch(() => { })
                            await this.bot.utils.wait(900)
                            passwordOptionClicked = true
                        } catch (clickErr) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to click password-option (${sel}): ${clickErr}`, 'warn')
                        }
                        // if we clicked one, break out and attempt to fill password
                        if (passwordOptionClicked) break
                    }
                } catch { /* ignore per-selector errors */ }
            }

            // If we didn't explicitly click a named password-option, do one more scan of generic buttons/links for password wording
            if (!passwordOptionClicked) {
                try {
                    const candidates = await page.$$('button, a')
                    for (const c of candidates) {
                        try {
                            const txt = (await c.innerText().catch(() => '')).trim().toLowerCase()
                            if (!txt) continue
                            // require a stronger match than generic 'password' — look for phrases
                            if (txt.includes('use your password') || txt.includes('sign in with password') || txt.includes('use a password') || txt.includes('use password') || txt.includes('sign in with your password')) {
                                if (await c.isVisible().catch(() => false)) {
                                    await c.click().catch(() => { })
                                    await this.bot.utils.wait(900)
                                    passwordOptionClicked = true
                                    this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked password-option by scanning buttons/links: "${txt}"`)
                                    break
                                }
                            }
                        } catch { /* ignore per-button errors */ }
                    }
                } catch { /* ignore */ }
            }

            // If we clicked a password option, try to locate the password input now and fill it
            if (passwordOptionClicked) {
                // give the UI a short moment to render the password input
                await this.bot.utils.wait(600)
                const pwdFieldAfterClick = await page.waitForSelector(passwordInputSelector, { state: 'visible', timeout: 4000 }).catch(() => null)
                if (pwdFieldAfterClick) {
                    await this.bot.utils.wait(400)
                    await page.fill(passwordInputSelector, '')
                    await this.bot.utils.wait(300)
                    await page.fill(passwordInputSelector, password)
                    await this.bot.utils.wait(400)

                    const nextButton2 = await page.waitForSelector('button[type="submit"]', { timeout: 4000 }).catch(() => null)
                    if (nextButton2) {
                        await nextButton2.click()
                        await this.bot.utils.wait(1800)
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Password entered successfully (after clicking password-option).')
                    } else {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Next button not found after password entry (post password-option click).', 'warn')
                    }
                    return true
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked password-option but password input did not appear; will continue to code-send detection', 'warn')
                }
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No explicit password-option UI detected; falling back to code-send detection')
            }

            // --- existing logic: check code/send-code flow if password path not available ---
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Password field not found - checking for "Get a code to sign in" flow')

            let codeFlowDetected = false
            for (const sel of codeFlowSelectors) {
                try {
                    const loc = page.locator(sel).first()
                    if (await loc.isVisible().catch(() => false)) {
                        codeFlowDetected = true
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Detected code flow using selector: ${sel}`)
                        break
                    }
                } catch { /* ignore */ }
            }

            if (!codeFlowDetected) {
                try {
                    const bigButtons = await page.$$('button')
                    for (const btn of bigButtons) {
                        try {
                            const txt = (await btn.innerText().catch(() => '')).trim().toLowerCase()
                            if (txt.includes('send code') || txt === 'send' || txt.includes('continue')) {
                                const visible = await btn.isVisible().catch(() => false)
                                if (visible) {
                                    codeFlowDetected = true
                                    this.bot.log(this.bot.isMobile, 'LOGIN', `Detected code flow by scanning button text: "${txt}"`)
                                    break
                                }
                            }
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }

            if (codeFlowDetected) {
                const sendSelectors = [
                    'button:has-text("Send code")',
                    'button[aria-label="Send code"]',
                    'button[data-testid="primaryButton"]',
                    'button:has-text("Send")',
                    'button:has-text("Continue")',
                    'button:has-text("Next")'
                ]

                let sendClicked = false
                for (const sel of sendSelectors) {
                    try {
                        const btn = await page.waitForSelector(sel, { timeout: 1500 }).catch(() => null)
                        if (btn) {
                            await btn.click().catch(() => { })
                            sendClicked = true
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked send/confirm button using selector: ${sel}`)
                            break
                        }
                    } catch { /* ignore */ }
                }

                if (!sendClicked) {
                    try {
                        const fallbackBtn = await page.$('button')
                        if (fallbackBtn && await fallbackBtn.isVisible().catch(() => false)) {
                            const text = (await fallbackBtn.innerText().catch(() => '')).trim().toLowerCase()
                            if (text.includes('send') || text.includes('continue')) {
                                await fallbackBtn.click().catch(() => { })
                                sendClicked = true
                                this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked fallback send button with text: "${text}"`)
                            }
                        }
                    } catch { /* ignore */ }
                }

                const waitMs = (this.bot.config as any)?.emailWaitMs ?? DEFAULT_EMAIL_WAIT_MS
                if (sendClicked) {
                    await this.bot.utils.wait(waitMs)
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Did not explicitly click a send button but will attempt to fetch code anyway', 'warn')
                    await this.bot.utils.wait(waitMs)
                }

                // Wait 3-4 minutes before checking Gmail to allow email delivery
                const preFetchWait = Math.floor(Math.random() * (MAX_EMAIL_WAIT_BEFORE_FETCH_MS - MIN_EMAIL_WAIT_BEFORE_FETCH_MS + 1)) + MIN_EMAIL_WAIT_BEFORE_FETCH_MS
                this.bot.log(this.bot.isMobile, 'LOGIN', `Waiting ${Math.round(preFetchWait/60000 * 100)/100} minutes before checking Gmail for the code...`)
                await this.bot.utils.wait(preFetchWait)

                try {
                    const code = await this.fetchCodeFromGmail(page, password)
                    if (code) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', `Retrieved code from Gmail: ${code}`)

                        const otpFilled = await this.fillOtpInputs(page, code)
                        if (!otpFilled) {
                            try {
                                await page.fill('input[name="otc"], input[type="text"], input[type="tel"]', code).catch(() => { })
                            } catch { /* ignore */ }
                        }

                        await page.keyboard.press('Enter').catch(() => { })
                        await this.bot.utils.wait(3000)

                        // --- explicit checks for OTP rejection / still asking for code ---
                        const otpErrorSelectors = [
                            'text=/that code is incorrect/i',
                            'text=/enter your code/i',
                            'text=/the code you entered/i',
                            'text=/check the code and try again/i',
                            'text=/code.*incorrect/i'
                        ]

                        for (const sel of otpErrorSelectors) {
                            try {
                                if (await page.locator(sel).first().isVisible().catch(() => false)) {
                                    this.bot.log(this.bot.isMobile, 'LOGIN', `Detected explicit OTP error after submission: ${sel}`, 'warn')
                                    return false
                                }
                            } catch { /* ignore */ }
                        }

                        const otpInputsPresent = await page.locator('input[name="otc"], input[maxlength="1"], input[type="tel"], input[aria-label*="digit"]').first().isVisible().catch(() => false)
                        if (otpInputsPresent) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', 'OTP inputs still present after submission — treating as failure (code rejected or still waiting).', 'warn')
                            return false
                        }

                        for (const sel of codeFlowSelectors) {
                            try {
                                if (await page.locator(sel).first().isVisible().catch(() => false)) {
                                    this.bot.log(this.bot.isMobile, 'LOGIN', `After OTP submission, still on code flow (selector present): ${sel}`, 'warn')
                                    return false
                                }
                            } catch { /* ignore */ }
                        }

                        // If none of the failure signals are present, treat as success
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'No send-code UI or OTP error detected after submission — treating as successful login.')
                        return true

                    } else {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Could not retrieve code from Gmail', 'warn')
                        return false
                    }
                } catch (err) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Error fetching code from Gmail: ${err}`, 'error')
                    return false
                }
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No code flow detected; falling back to standard 2FA handlers')
            }

            // fallback to manual 2FA
            try {
                await this.handle2FA(page)

                // post-manual checks for errors or remaining code UI
                const otpErrorSelectorsAfterManual = [
                    'text=/that code is incorrect/i',
                    'text=/enter your code/i',
                    'text=/the code you entered/i',
                    'text=/check the code and try again/i',
                    'text=/code.*incorrect/i'
                ]
                for (const sel of otpErrorSelectorsAfterManual) {
                    try {
                        if (await page.locator(sel).first().isVisible().catch(() => false)) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Detected explicit OTP error after manual 2FA: ${sel}`, 'warn')
                            return false
                        }
                    } catch { /* ignore */ }
                }

                const otpInputsStill = await page.locator('input[name="otc"], input[maxlength="1"], input[type="tel"], input[aria-label*="digit"]').first().isVisible().catch(() => false)
                if (otpInputsStill) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'OTP inputs are still present after manual 2FA — treating as failure.', 'warn')
                    return false
                }

                for (const sel of codeFlowSelectors) {
                    try {
                        if (await page.locator(sel).first().isVisible().catch(() => false)) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `After manual 2FA, still on code flow (selector present): ${sel}`, 'warn')
                            return false
                        }
                    } catch { /* ignore */ }
                }

                this.bot.log(this.bot.isMobile, 'LOGIN', 'Manual 2FA completed and no send-code UI or errors present — treating as successful login.')
                return true
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `handle2FA threw an error: ${err}`, 'warn')
                return false
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Password entry failed: ${error}`, 'error')
            return false
        }
    }


    /**
     * Try to fill multi-input OTP UIs (common pattern is several <input maxlength="1">).
     * Returns true if it handled filling; false otherwise.
     */
    private async fillOtpInputs(page: Page, code: string): Promise<boolean> {
        try {
            const containers = [
                '[data-testid="otpInputs"]',
                '#otcContainer',
                'div[role="main"]',
                'form'
            ]

            for (const contSel of containers) {
                try {
                    const container = page.locator(contSel).first()
                    if (!container) continue
                    const inputs = container.locator('input[maxlength="1"], input[aria-label*="digit"], input[aria-label*="code"]')
                    const count = await inputs.count().catch(() => 0)
                    if (count >= 2) {
                        for (let i = 0; i < Math.min(count, code.length); i++) {
                            const digit: string = code.charAt(i)
                            const input = inputs.nth(i)
                            try {
                                await input.click({ timeout: 500 }).catch(() => { })
                                await input.fill(digit).catch(async () => {
                                    await input.type(digit, { delay: 80 }).catch(() => { })
                                })
                                await this.bot.utils.wait(100)
                            } catch { /* ignore per-digit failures */ }
                        }
                        return true
                    }
                } catch { /* ignore container errors */ }
            }

            const multiInputs = page.locator('input[maxlength="1"], input[type="tel"][maxlength="1"]')
            const total = await multiInputs.count().catch(() => 0)
            if (total >= 2) {
                for (let i = 0; i < Math.min(total, code.length); i++) {
                    const d: string = code.charAt(i)
                    const inp = multiInputs.nth(i)
                    try {
                        await inp.click().catch(() => { })
                        await inp.fill(d).catch(async () => {
                            await inp.type(d, { delay: 80 }).catch(() => { })
                        })
                        await this.bot.utils.wait(100)
                    } catch { /* ignore */ }
                }
                return true
            }

            return false
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `fillOtpInputs failed: ${err}`, 'error')
            return false
        }
    }

    private async handle2FA(page: Page) {
        try {
            const numberToPress = await this.get2FACode(page)
            if (numberToPress) {
                await this.authAppVerification(page, numberToPress)
            } else {
                await this.authSMSVerification(page)
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `2FA handling failed: ${error}`)
        }
    }

    private async get2FACode(page: Page): Promise<string | null> {
        const selectors = [
            '#displaySign',
            'div[data-testid="displaySign"]>span',
            'text=Approve sign-in',
            'text=Approve'
        ]

        for (const sel of selectors) {
            try {
                const el = await page.waitForSelector(sel, { state: 'visible', timeout: 5000 }).catch(() => null)
                if (el) {
                    const txt = (await el.textContent().catch(() => null)) ?? null
                    if (txt) return txt
                }
            } catch { /* ignore */ }
        }

        if (this.bot.config.parallel) {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Script running in parallel; waiting for push approval flow...', 'log', 'yellow')
            const retryButtonSelectors = [
                'button[aria-describedby="pushNotificationsTitle errorDescription"]',
                'button[data-testid="primaryButton"]',
                'button:has-text("Try again")',
                'button:has-text("Resend")'
            ]
            for (let attempt = 0; attempt < 6; attempt++) {
                for (const rsel of retryButtonSelectors) {
                    try {
                        const b = await page.waitForSelector(rsel, { timeout: 2000 }).catch(() => null)
                        if (b) { await b.click().catch(() => { }) ; this.bot.log(this.bot.isMobile, 'LOGIN', `Clicked retry button: ${rsel}`) }
                    } catch { /* ignore */ }
                }
                await this.bot.utils.wait(60000)
                for (const sel of selectors) {
                    try {
                        const el = await page.waitForSelector(sel, { state: 'visible', timeout: 2000 }).catch(() => null)
                        if (el) {
                            const t = (await el.textContent().catch(() => null)) ?? null
                            if (t) return t
                        }
                    } catch { /* ignore */ }
                }
            }
        }

        try {
            const confirm = await page.waitForSelector('button[aria-describedby="confirmSendTitle"], button:has-text("Send")', { timeout: 2000 }).catch(() => null)
            if (confirm) {
                await confirm.click().catch(() => { })
                await this.bot.utils.wait(2000)
                const el = await page.waitForSelector('#displaySign, div[data-testid="displaySign"]>span', { timeout: 5000 }).catch(() => null)
                if (el) {
                    const t = (await el.textContent().catch(() => null)) ?? null
                    if (t) return t
                }
            }
        } catch { /* ignore */ }

        return null
    }

    private async authAppVerification(page: Page, numberToPress: string | null) {
        while (true) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Press the number ${numberToPress} on your Authenticator app to approve the login`)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'If you press the wrong number or the "DENY" button, try again in 60 seconds')
                await page.waitForSelector('form[name="f1"]', { state: 'detached', timeout: 60000 })
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Login successfully approved!')
                break
            } catch {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'The code is expired. Trying to get a new code...')
                const primaryButton = await page.waitForSelector('button[data-testid="primaryButton"]', { state: 'visible', timeout: 5000 }).catch(() => null)
                if (primaryButton) { await primaryButton.click().catch(() => { }) }
                numberToPress = await this.get2FACode(page)
            }
        }
    }

    private async authSMSVerification(page: Page) {
        // First try TOTP if secret is available
        if (this.currentTotpSecret) {
            try {
                const code = generateTOTP(this.currentTotpSecret.trim());
                await page.fill('input[name="otc"]', code);
                await page.keyboard.press('Enter');
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Submitted TOTP automatically');
                return;
            } catch (error) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `TOTP auto-fill failed: ${error}`, 'warn');
                // Fall through to manual entry
            }
        }

        // Manual prompt fallback
        this.bot.log(this.bot.isMobile, 'LOGIN', 'SMS 2FA code required. Waiting for user input...')
        const code = await new Promise<string>((resolve) => {
            rl.question('Enter 2FA code:\n', (input) => { resolve(input) })
        })
        await page.fill('input[name="otc"]', code).catch(() => { })
        await page.keyboard.press('Enter').catch(() => { })
        this.bot.log(this.bot.isMobile, 'LOGIN', '2FA code entered successfully')
    }


    async getMobileAccessToken(page: Page, email: string) {
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Mobile token attempt ${attempt}/${maxRetries}`);

                // Use the simpler approach - disable FIDO first
                await this.disableFido(page);

                const url = new URL(this.authBaseUrl);
                url.searchParams.set('response_type', 'code');
                url.searchParams.set('client_id', this.clientId);
                url.searchParams.set('redirect_uri', this.redirectUrl);
                url.searchParams.set('scope', this.scope);
                url.searchParams.set('state', crypto.randomBytes(16).toString('hex'));
                url.searchParams.set('access_type', 'offline_access');
                url.searchParams.set('login_hint', email);

                // Add a unique parameter to avoid caching
                url.searchParams.set('client-request-id', crypto.randomUUID());

                this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Navigating to authorization URL');

                // Use a simpler navigation approach
                await page.goto(url.href, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });

                const start = Date.now();
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Authorizing mobile scope...');

                let code = '';
                const timeoutMs = 45000; // 45 seconds

                while (Date.now() - start < timeoutMs) {
                    // Handle any passkey prompts that might appear
                    await this.handlePasskeyPrompts(page, 'oauth');

                    const currentUrl = page.url();
                    const urlObj = new URL(currentUrl);

                    if (urlObj.hostname === 'login.live.com' && urlObj.pathname === '/oauth20_desktop.srf') {
                        code = urlObj.searchParams.get('code') || '';
                        if (code) {
                            this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Authorization code received successfully');
                            break;
                        }
                    }

                    // Check if we've been redirected to an Office or other Microsoft service
                    if (urlObj.searchParams.get('client_id') && urlObj.searchParams.get('client_id') !== this.clientId) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Detected redirect to different client: ${urlObj.searchParams.get('client_id')}`, 'warn');

                        // Try to go back and restart
                        if (attempt < maxRetries) {
                            this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Going back and retrying...');
                            await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                            await this.bot.utils.wait(2000);
                            break; // Break out of while loop to retry
                        }
                    }

                    await this.bot.utils.wait(1000);
                }

                if (!code) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', `No authorization code received on attempt ${attempt}`, 'warn');

                    if (attempt < maxRetries) {
                        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
                        this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Waiting ${backoffMs}ms before retry...`);
                        await this.bot.utils.wait(backoffMs);
                        continue;
                    } else {
                        throw new Error('OAuth code not received in time');
                    }
                }

                // Exchange code for token
                const form = new URLSearchParams();
                form.append('grant_type', 'authorization_code');
                form.append('client_id', this.clientId);
                form.append('code', code);
                form.append('redirect_uri', this.redirectUrl);

                const req: AxiosRequestConfig = {
                    url: this.tokenUrl,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    data: form.toString(),
                    timeout: 10000
                };

                const resp = await this.bot.axios.request(req);
                const data: OAuth = resp.data;
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Authorized in ${Math.round((Date.now()-start)/1000)}s`);
                return data.access_token;

            } catch (error) {
                this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Attempt ${attempt} failed: ${error}`, 'warn');

                if (attempt < maxRetries) {
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Waiting ${backoffMs}ms before retry...`);
                    await this.bot.utils.wait(backoffMs);
                    continue;
                } else {
                    // Emit error notification for main process
                    this.emitError({
                        type: 'MOBILE_AUTH_FAILED',
                        email: email,
                        message: `Mobile authentication failed after ${maxRetries} attempts: ${error}`,
                        retryAfterMs: 10 * 60 * 1000, // 10 minutes
                        shouldRestartBrowsers: true
                    });

                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'All authorization attempts failed', 'error');

                    // Final fallback - try to continue without token
                    this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Using fallback - continuing without mobile token');
                    try {
                        await page.goto('https://rewards.bing.com/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 15000
                        });
                    } catch (e) {
                        // Ignore navigation errors in fallback
                    }
                    return null;
                }
            }
        }

        return null;
    }

// Add these missing methods that are referenced in the code above:

    /**
     * Disable FIDO support in login requests
     */
    private async disableFido(page: Page) {
        await page.route('**/GetCredentialType.srf*', (route) => {
            const postData = route.request().postData() || '{}';
            let body: any = {};
            try {
                body = JSON.parse(postData);
            } catch {
                body = {};
            }
            body.isFidoSupported = false;
            route.continue({ postData: JSON.stringify(body) });
        });
    }

    /**
     * Handle passkey prompts during OAuth flow
     */
    private async handlePasskeyPrompts(page: Page, context: string) {
        try {
            // Common passkey prompt selectors
            const passkeySelectors = [
                'button:has-text("Use your passkey")',
                'button:has-text("Use Windows Hello")',
                'button:has-text("Use security key")',
                'button:has-text("Use a different method")',
                'text=Use your password',
                'button[data-testid="secondaryButton"]' // Skip/back button
            ];

            for (const selector of passkeySelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        await element.click();
                        this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Handled passkey prompt (${context}) with selector: ${selector}`);
                        await this.bot.utils.wait(1000);
                        return;
                    }
                } catch (error) {
                    // Ignore errors for individual selectors
                }
            }
        } catch (error) {
            // Ignore overall errors in passkey handling
        }
    }


    // /**
    //  * Exchange authorization code for access token
    //  */
    // private async exchangeCodeForToken(code: string): Promise<string> {
    //     const body = new URLSearchParams();
    //     body.append('grant_type', 'authorization_code');
    //     body.append('client_id', this.clientId);
    //     body.append('code', code);
    //     body.append('redirect_uri', this.redirectUrl);
    //
    //     const tokenRequest: AxiosRequestConfig = {
    //         url: this.tokenUrl,
    //         method: 'POST',
    //         headers: {
    //             'Content-Type': 'application/x-www-form-urlencoded',
    //             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    //         },
    //         data: body.toString(),
    //         timeout: 10000
    //     };
    //
    //     try {
    //         const tokenResponse = await this.bot.axios.request(tokenRequest);
    //         const tokenData: OAuth = await tokenResponse.data;
    //         this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Successfully exchanged code for token');
    //         return tokenData.access_token;
    //     } catch (error) {
    //         this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Token exchange failed: ${error}`, 'error');
    //         throw error;
    //     }
    // }
    //
    // /**
    //  * Ensure we're on the rewards page as fallback
    //  */
    // private async ensureRewardsPage(page: Page) {
    //     try {
    //         const currentUrl = new URL(page.url());
    //         if (!currentUrl.hostname.includes('rewards.bing.com')) {
    //             this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Navigating back to rewards page as fallback');
    //             await page.goto('https://rewards.bing.com/', {
    //                 waitUntil: 'domcontentloaded',
    //                 timeout: 15000
    //             });
    //         }
    //     } catch (error) {
    //         this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Error ensuring rewards page: ${error}`, 'warn');
    //     }
    // }


    private async checkLoggedIn(page: Page) {
        const targetHostname = 'rewards.bing.com'
        const targetPathname = '/'

        while (true) {
            await this.dismissLoginMessages(page)
            // Try dismissing occasional post-login onboarding/welcome modals
            await this.dismissWelcomeModal(page)

            const currentURL = new URL(page.url())
            if (currentURL.hostname === targetHostname && currentURL.pathname === targetPathname) {
                break
            }
        }

        await page.waitForSelector('html[data-role-name="RewardsPortal"]', { timeout: 10000 })
        this.bot.log(this.bot.isMobile, 'LOGIN', 'Successfully logged into the rewards portal')
    }

    private async dismissLoginMessages(page: Page) {
        try {
            // Only proceed if we're on a Microsoft login page
            const currentUrl = page.url();
            if (!currentUrl.includes('login.live.com') && !currentUrl.includes('account.microsoft.com')) {
                return;
            }

            // 1. Handle Passkey prompt with more precise detection
            const passkeyPromptDetected = await page.evaluate(() => {
                // Check for passkey-specific indicators
                const titleEl = document.querySelector('[data-testid="title"]');
                const titleText = titleEl ? titleEl.textContent || '' : '';
                const hasBiometricVideo = document.querySelector('[data-testid="biometricVideo"]') !== null;
                const hasPasskeyIndicators = /sign in faster|passkey|biometric|fingerprint|face id|windows hello/i.test(titleText);

                return hasBiometricVideo || hasPasskeyIndicators;
            });

            if (passkeyPromptDetected) {
                // Only click "Skip for now" if it's clearly a passkey prompt
                const skipButton = await page.$('button[data-testid="secondaryButton"]:has-text("Skip for now")');
                if (skipButton) {
                    await skipButton.click({ delay: 50 });
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Safely dismissed "Use Passkey" prompt with "Skip for now" button');
                    await page.waitForTimeout(1000);
                    return;
                }

                // Alternative: look for "No" or "Not now" buttons specifically for passkey
                const noButton = await page.$('button:has-text("No")');
                if (noButton) {
                    await noButton.click({ delay: 50 });
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Safely dismissed "Use Passkey" prompt with "No" button');
                    await page.waitForTimeout(1000);
                    return;
                }
            }

            // 2. Handle "Keep me signed in" with more precision
            const kmsiPromptDetected = await page.evaluate(() => {
                const titleEl = document.querySelector('[data-testid="title"]');
                const titleText = titleEl ? titleEl.textContent || '' : '';
                return /keep me signed in|stay signed in/i.test(titleText);
            });

            if (kmsiPromptDetected) {
                const yesButton = await page.$('button[data-testid="primaryButton"]:has-text("Yes")');
                if (yesButton) {
                    await yesButton.click({ delay: 50 });
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Safely confirmed "Keep me signed in" prompt');
                    await page.waitForTimeout(1000);
                }
            }

            // 3. Only handle the main login page prompt if needed
            if (currentUrl.includes('login.live.com') && currentUrl.includes('oauth20_authorize')) {
                const nextButton = await page.$('button[type="submit"]:has-text("Next")');
                const signInButton = await page.$('button[type="submit"]:has-text("Sign in")');

                if (nextButton || signInButton) {
                    // This is likely the main login flow, not a dismissible prompt
                    this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', 'Detected main login flow, not dismissing');
                    return;
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'DISMISS-ALL-LOGIN-MESSAGES', `Error dismissing login messages: ${error}`, 'warn');
        }
    }


    /**
     * Try to detect and close common "welcome/tour/onboarding" modals that appear after login.
     * This version is more aggressive and general-purpose:
     * - Attempts normal Playwright click on known close selectors
     * - Attempts DOM click inside page.evaluate (bypasses pointer-event interception)
     * - Hides/removes dialog/overlay nodes if clicks fail
     * - Sends Escape and body clicks as fallback
     *
     * NOTE: This is intentionally noisy (logs lots of attempts) so you can tune and remove selectors later.
     */
    private async dismissWelcomeModal(page: Page) {
        try {
            // Only run dismissal on the rewards page after login confirmation and full load.
            try {
                const url = new URL(page.url());
                if (!url.hostname.includes('rewards.bing.com') && !url.pathname.includes('/rewards')) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Not on rewards page; skipping dismissal until later.');
                    return;
                }
            } catch { /* ignore URL parse errors */ }

            // Ensure login is confirmed before attempting dismissal
            try {
                const loggedIn = await Promise.race([
                    this.checkBingLoginStatus(page),
                    new Promise<boolean>(res => setTimeout(() => res(false), 5000)) // 5s fallback
                ]);
                if (!loggedIn) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Login not confirmed yet; skipping dismissal until after login.');
                    return;
                }
            } catch (e) {
                const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Error checking login status, skipping dismissal: ${errMsg}`, 'warn');
                return;
            }

            // Wait for the page to finish loading network activity to avoid racing with redirects/refreshes
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });

            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Attempting robust popup dismissal (max 2 attempts).');

            const closeSelectors = [
                'button[aria-label="Close"]',
                'button[aria-label="Close dialog"]',
                'button[title="Close"]',
                'button[aria-label="Close (Esc)"]',
                'button[aria-label="Dismiss"]',
                '.ms-Dialog button[aria-label="Close"]',
                '.rewards-onboarding .close',
                '.rewards-onboarding button.close',
                '.modal-header button.close',
                '.modal .close',
                '.modal-close',
                '.onboarding-modal button[aria-label="Close"]',
                '.ui-dialog .ui-dialog-titlebar-close',
                'button[aria-label*="close"]',
                'button[aria-label*="dismiss"]',
                'button[data-purpose="close-modal"]',
                '#popUpModal .close',
                '#popUpModal button',
                '.dashboardPopUpModal .close',
                '.dashboardPopUpModal button',
                '.popup .close',
                '.popup-close',
                '.pop-up .close',
                'mee-rewards-user-status-banner .close',
                'mee-rewards-user-status-banner button',
                'div[role="dialog"] button',
                'div[role="alertdialog"] button',
                '.overlay .close',
                '.modal-backdrop',
                '.overlay'
            ];

            const dialogContainers = [
                'div[role="dialog"]',
                'div[role="alertdialog"]',
                '.modal',
                '.ms-Dialog',
                '.onboarding',
                '.rewards-onboarding',
                '.dashboardPopUpModal',
                '#popUpModal',
                '.popup',
                '.streakPause',
                '.streak-pause',
                '[data-testid="popup"]',
                'mee-rewards-user-status-banner'
            ];

            let overallSucceeded = false;

            // Run up to 2 attempts. If both fail, continue without blocking.
            for (let attempt = 0; attempt < 2; attempt++) {
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Dismiss attempt ${attempt + 1}/2`);

                // Quick probe: any visible popup matches?
                const hasPopup = await page.evaluate((params: { closeSel: string[]; dialogSel: string[] }) => {
                    const closeSel = params.closeSel || [];
                    const dialogSel = params.dialogSel || [];
                    try {
                        const selList = closeSel.concat(dialogSel);
                        for (const s of selList) {
                            try {
                                const nodes = Array.from(document.querySelectorAll(s));
                                for (const n of nodes) {
                                    try {
                                        const rect = (typeof (n as any).getBoundingClientRect === 'function') ? (n as any).getBoundingClientRect() : { width: 0, height: 0 };
                                        const cs = window.getComputedStyle ? window.getComputedStyle(n as Element) : null;
                                        const visibleRect = rect && rect.width > 0 && rect.height > 0;
                                        const visibleStyle = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') : true;
                                        if (visibleRect && visibleStyle) return true;
                                    } catch { /* node-level */ }
                                }
                            } catch { /* selector-level */ }
                        }
                    } catch { /* swallow */ }
                    return false;
                }, { closeSel: closeSelectors, dialogSel: dialogContainers }).catch(() => false);

                if (!hasPopup) {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'No welcome/popups detected (probe).');
                    overallSucceeded = true;
                    break;
                }

                // Popup exists: do up to 3 passes per attempt
                let attemptSucceeded = false;
                for (let pass = 0; pass < 3; pass++) {
                    // 1) Playwright forced clicks on known close selectors
                    for (const sel of closeSelectors) {
                        try {
                            const locator = page.locator(sel).first();
                            const cnt = await locator.count().catch(() => 0);
                            if (cnt > 0) {
                                const visible = await locator.isVisible().catch(() => false);
                                if (visible) {
                                    try {
                                        await locator.click({ force: true }).catch(() => {});
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Clicked close element via Playwright: ${sel}`);
                                        await this.bot.utils.wait(200);
                                    } catch (err) {
                                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Playwright click error for ${sel}: ${err}`, 'warn');
                                    }
                                }
                            }
                        } catch { /* ignore per-selector errors */ }
                    }

                    // 2) DOM-evaluate click fallback (dispatch mouse events)
                    try {
                        const clicked = await page.evaluate((params: { selList: string[] }) => {
                            try {
                                for (const s of params.selList) {
                                    try {
                                        const nodes = Array.from(document.querySelectorAll(s));
                                        for (const n of nodes) {
                                            try {
                                                const rect = (typeof (n as any).getBoundingClientRect === 'function') ? (n as any).getBoundingClientRect() : { width: 0, height: 0 };
                                                const cs = window.getComputedStyle ? window.getComputedStyle(n as Element) : null;
                                                const visibleRect = rect && rect.width > 0 && rect.height > 0;
                                                const visibleStyle = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') : true;
                                                if (!visibleRect || !visibleStyle) continue;
                                                n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                                                n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                                                n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                                return true;
                                            } catch { /* node-level */ }
                                        }
                                    } catch { /* selector-level */ }
                                }
                            } catch {}
                            return false;
                        }, { selList: closeSelectors }).catch(() => false);

                        if (clicked) {
                            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Clicked close via DOM-evaluate fallback');
                            await this.bot.utils.wait(150);
                        }
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `DOM-evaluate click failed: ${err}`, 'warn');
                    }

                    // 3) Safer hide of dialog containers (do not remove nodes)
                    try {
                        const hidden = await page.evaluate((params: { containers: string[] }) => {
                            const containers = params.containers || [];
                            let changed = false;
                            try {
                                for (const sel of containers) {
                                    try {
                                        const nodes = Array.from(document.querySelectorAll(sel));
                                        for (const n of nodes) {
                                            try {
                                                const role = (n as Element).getAttribute ? (n as Element).getAttribute('role') : null;
                                                const cls = (n as any).className || '';
                                                const isEphemeral = (role === 'dialog' || role === 'alertdialog' || /popup|popUp|modal|overlay|dashboardPopUp/i.test(cls));
                                                if (!isEphemeral) continue;
                                                try { if ((n as any).style) (n as any).style.setProperty('pointer-events', 'none', 'important'); } catch {}
                                                try { if ((n as any).style) (n as any).style.setProperty('display', 'none', 'important'); } catch {}
                                                try { if ((n as any).style) (n as any).style.setProperty('opacity', '0', 'important'); } catch {}
                                                try { if ((n as any).setAttribute) (n as any).setAttribute('aria-hidden', 'true'); } catch {}
                                                try { if ((n as any).setAttribute) (n as any).setAttribute('data-removed-by-bot', '1'); } catch {}
                                                changed = true;
                                            } catch {}
                                        }
                                    } catch {}
                                }

                                // hide common backdrops
                                try {
                                    const backdrops = Array.from(document.querySelectorAll('.modal-backdrop, .backdrop, .overlay, [data-modal-overlay]'));
                                    for (const b of backdrops) {
                                        try { if ((b as any).style) (b as any).style.setProperty('display', 'none', 'important'); } catch {}
                                        try { if ((b as any).setAttribute) (b as any).setAttribute('data-removed-by-bot', '1'); } catch {}
                                        changed = true;
                                    }
                                } catch {}

                                try { if (document.body && (document.body as any).style) (document.body as any).style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                            } catch {}
                            return changed;
                        }, { containers: dialogContainers }).catch(() => false);

                        if (hidden) {
                            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Safely hid ephemeral dialog containers (did not remove nodes)');
                            await this.bot.utils.wait(150);
                        }
                    } catch (err) {
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `DOM-evaluate hide attempt failed: ${err}`, 'warn');
                    }

                    // 4) Escape + small-body-click fallback
                    try {
                        await page.keyboard.press('Escape').catch(() => {});
                        await page.mouse.click(5, 5).catch(() => {});
                        await page.mouse.click(20, 20).catch(() => {});
                        this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Sent Escape and body-click fallbacks');
                    } catch { /* ignore */ }

                    // Short pause between passes
                    await this.bot.utils.wait(300);

                    // Probe whether popups still exist; if none, mark success for this attempt
                    const stillHas = await page.evaluate((params: { closeSel: string[]; dialogSel: string[] }) => {
                        const closeSel = params.closeSel || [];
                        const dialogSel = params.dialogSel || [];
                        try {
                            const selList = closeSel.concat(dialogSel);
                            for (const s of selList) {
                                try {
                                    const nodes = Array.from(document.querySelectorAll(s));
                                    for (const n of nodes) {
                                        try {
                                            const rect = (typeof (n as any).getBoundingClientRect === 'function') ? (n as any).getBoundingClientRect() : { width: 0, height: 0 };
                                            const cs = window.getComputedStyle ? window.getComputedStyle(n as Element) : null;
                                            const visibleRect = rect && rect.width > 0 && rect.height > 0;
                                            const visibleStyle = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') : true;
                                            if (visibleRect && visibleStyle) return true;
                                        } catch {}
                                    }
                                } catch {}
                            }
                        } catch {}
                        return false;
                    }, { closeSel: closeSelectors, dialogSel: dialogContainers }).catch(() => false);

                    if (!stillHas) {
                        attemptSucceeded = true;
                        break;
                    }
                } // end passes

                if (attemptSucceeded) {
                    overallSucceeded = true;
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Dismiss attempt ${attempt + 1} succeeded.`);
                    break;
                } else {
                    this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Dismiss attempt ${attempt + 1} did not clear popup; ${attempt === 0 ? 'one more run will be tried.' : 'no more attempts.'}`, 'warn');
                    await this.bot.utils.wait(250);
                }
            } // end attempts

            if (!overallSucceeded) {
                this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', 'Popup dismissal failed after 2 attempts — continuing without blocking.', 'warn');
            } else {
                await this.bot.utils.wait(200);
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'DISMISS-WELCOME', `Error while dismissing welcome modal: ${err}`, 'warn');
        }
    }





    private async checkBingLogin(page: Page): Promise<void> {
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing login')
            await page.goto('https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F')

            const maxIterations = 5
            for (let iteration = 1; iteration <= maxIterations; iteration++) {
                const currentUrl = new URL(page.url())
                if (currentUrl.hostname === 'www.bing.com' && currentUrl.pathname === '/') {
                    await this.bot.browser.utils.tryDismissAllMessages(page)
                    // Also try our welcome/modal dismiss helper — some popups appear on bing after login
                    await this.dismissWelcomeModal(page)

                    const loggedIn = await this.checkBingLoginStatus(page)
                    if (loggedIn || this.bot.isMobile) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'Bing login verification passed!')
                        break
                    }
                }
                await this.bot.utils.wait(1000)
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'An error occurred:' + error, 'error')
        }
    }

    private async checkBingLoginStatus(page: Page): Promise<boolean> {
        try {
            await page.waitForSelector('#id_n', { timeout: 5000 })
            return true
        } catch (error) {
            return false
        }
    }

    private async checkAccountLocked(page: Page) {
        await this.bot.utils.wait(2000)
        const isLocked = await page.waitForSelector('#serviceAbuseLandingTitle', { state: 'visible', timeout: 1000 }).then(() => true).catch(() => false)
        if (isLocked) {
            // Get email from current context if possible
            let email = 'unknown';
            try {
                // Try to get email from page context or URL
                const currentUrl = page.url();
                const emailMatch = currentUrl.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
                if (emailMatch) email = emailMatch[0];
            } catch (e) {}

            this.emitError({
                type: 'ACCOUNT_LOCKED',
                email: email,
                message: 'Account has been locked! Remove from accounts.json',
                shouldRestartBrowsers: false // No need to restart for locked account
            });

            throw this.bot.log(this.bot.isMobile, 'CHECK-LOCKED', 'This account has been locked! Remove the account from "accounts.json" and restart!', 'error')
        }
    }

    /**
     * Fetch code from Gmail — unchanged except it uses the page/context provided.
     */
    private async fetchCodeFromGmail(originalPage: Page, msPasswordHint?: string): Promise<string | null> {
        try {
            // detect gmail email from the MS page
            let gmailEmail: string | null = null
            try {
                const locator = originalPage.locator('text=/[A-Za-z0-9._%+-]+@gmail\\.com/').first()
                gmailEmail = await locator.textContent().catch(() => null)
            } catch { /* ignore */ }

            if (!gmailEmail) {
                const bodyText = await originalPage.textContent('body').catch(() => '')
                const mGuess = bodyText?.match(/\b[A-Za-z0-9._%+-]+@gmail\.com\b/)
                gmailEmail = mGuess ? mGuess[0] : null
            }

            if (!gmailEmail) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Unable to determine gmail address from Microsoft page', 'warn')
                return null
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', `Detected gmail address: ${gmailEmail}`)

            // ----- Try to resolve an MS password (msPasswordHint or config) -----
            let msPassword: string | undefined = undefined
            if (msPasswordHint) { msPassword = msPasswordHint; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using provided MS password hint (msPasswordHint).') }
            try {
                const accounts = (this.bot.config as any)?.accounts || (this.bot as any).accounts
                if (!msPassword && Array.isArray(accounts)) {
                    const match = accounts.find((a: any) => a?.email === gmailEmail)
                    if (match && match.password) { msPassword = match.password; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using MS password from bot.config.accounts entry') }
                }
            } catch { /* ignore */ }

            // If the MS page offers a "Use your password" (or similar) path, prefer it when we have an MS password.
            // We check for common phrases/buttons that indicate a password path and try to click/fill the password input.
            try {
                // selectors/phrases to detect password alternative on MS sign-in UI
                const passwordOptionSelectors = [
                    'button:has-text("Use your password")',
                    'a:has-text("Use your password")',
                    'text=/use your password/i',
                    'button:has-text("Sign in with password")',
                    'text=/sign in with password/i',
                    'text=/use a password/i',
                    'text=/use password/i',
                    'text=/password/i' // last-resort: presence of password-related text
                ]

                for (const sel of passwordOptionSelectors) {
                    const el = originalPage.locator(sel).first()
                    if (await el.isVisible().catch(() => false)) {
                        // If we don't have an MS password, don't click the option — let the caller fall back to Send code behavior.
                        if (!msPassword) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Found password-signin option (${sel}) but no MS password available — not using it.`, 'warn')
                            break
                        }

                        this.bot.log(this.bot.isMobile, 'LOGIN', `Found password-signin option (${sel}) — attempting password sign-in.`)
                        try {
                            await el.click().catch(() => { })
                            // wait a bit for the password field to show up
                            await originalPage.waitForTimeout(900)

                            // common password input selectors on MS pages
                            const pwdSelectors = ['input[type="password"]', 'input[name="passwd"]', 'input[name="password"]', 'input[id*="password"]']
                            let filled = false
                            for (const psel of pwdSelectors) {
                                try {
                                    const pwdEl = originalPage.locator(psel).first()
                                    if (await pwdEl.isVisible().catch(() => false)) {
                                        await originalPage.waitForTimeout((this.bot.config as any)?.passwordFillDelayMs ?? 400)
                                        await pwdEl.fill(msPassword).catch(() => { })
                                        await originalPage.waitForTimeout(300)
                                        // press Enter to submit password
                                        await originalPage.keyboard.press('Enter').catch(() => { })
                                        await originalPage.waitForTimeout(2200)
                                        filled = true
                                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Filled MS password and submitted (password path).')
                                        break
                                    }
                                } catch { /* ignore per-selector errors */ }
                            }

                            if (!filled) {
                                // Might be a slightly different flow: try to focus any visible password input and type
                                try {
                                    const anyPwd = await originalPage.locator('input[type="password"]').first()
                                    if (await anyPwd.isVisible().catch(() => false)) {
                                        await anyPwd.fill(msPassword).catch(() => { })
                                        await originalPage.keyboard.press('Enter').catch(() => { })
                                        await originalPage.waitForTimeout(2200)
                                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Filled MS password (fallback selector) and submitted.')
                                        filled = true
                                    }
                                } catch { /* ignore */ }
                            }

                            // If we successfully used password flow, we should not try to fetch a code from Gmail.
                            if (filled) {
                                // Caller expects a verification code string or null; since we used password auth, return null.
                                this.bot.log(this.bot.isMobile, 'LOGIN', 'Used MS password instead of Send code; skipping Gmail code fetch.')
                                return null
                            } else {
                                this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked password-signin option but did not find a password input to fill — will continue to email fallback.', 'warn')
                            }
                        } catch (pwErr) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', `Error while attempting password-signin flow: ${pwErr}`, 'warn')
                            // continue to normal email code path below
                        }

                        // whether succeeded or not, break out of selector loop to avoid double-clicking
                        break
                    }
                }
            } catch { /* ignore detection errors and continue to Gmail flow */ }

            // ----- existing gmail-password resolution (keeps your original gmailPassword logic) -----
            let gmailPassword: string | undefined = undefined
            if (msPasswordHint) { gmailPassword = msPasswordHint; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using provided MS password as Gmail password hint (msPasswordHint).') }

            try {
                const configuredPw = (this.bot.config as any)?.gmailPasswords?.[gmailEmail]
                if (configuredPw) { gmailPassword = configuredPw; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using Gmail password from bot.config.gmailPasswords') }
            } catch { /* ignore */ }

            try {
                const accounts = (this.bot.config as any)?.accounts || (this.bot as any).accounts
                if (!gmailPassword && Array.isArray(accounts)) {
                    const match = accounts.find((a: any) => a?.email === gmailEmail)
                    if (match && match.password) { gmailPassword = match.password; this.bot.log(this.bot.isMobile, 'LOGIN', 'Using Gmail password from bot.config.accounts entry') }
                }
            } catch { /* ignore */ }

            if (!gmailPassword) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'No Gmail password found in config or hints — will attempt to read inbox without logging in (if possible).', 'warn')
            }

            const context = originalPage.context()
            let gmailPage: Page | null = null
            let usedTempBrowser = false
            let tempBrowser: any = null

            try {
                if (context && typeof (context as any).newPage === 'function') { gmailPage = await (context as any).newPage() }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Could not open new page in same context: ${err}`, 'warn'); gmailPage = null
            }

            if (!gmailPage) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Falling back to launching a temporary browser for Gmail (less ideal).', 'warn')
                tempBrowser = await (playwright as any).chromium.launch({ headless: this.bot.config.headless })
                const tempContext = await tempBrowser.newContext({ ignoreHTTPSErrors: true, viewport: null })
                gmailPage = await tempContext.newPage()
                usedTempBrowser = true
            }

            if (!gmailPage) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Unable to open a page for Gmail', 'error')
                if (tempBrowser) try { await tempBrowser.close() } catch { }
                return null
            }

            await gmailPage.goto('https://mail.google.com/', { waitUntil: 'domcontentloaded' })
            const navWaitMs = (this.bot.config as any)?.gmailNavWaitMs ?? DEFAULT_GMAIL_NAV_WAIT_MS
            await gmailPage.waitForTimeout(navWaitMs)

            try {
                const identifierSelector = 'input[type="email"], input[name="identifier"]'
                if (await gmailPage.locator(identifierSelector).first().isVisible().catch(() => false)) {
                    await gmailPage.fill(identifierSelector, gmailEmail)
                    await gmailPage.keyboard.press('Enter')
                    await gmailPage.waitForTimeout(1400)
                }
            } catch { /* ignore */ }

            try {
                const passwordSelector = 'input[type="password"], input[name="password"]'
                if (gmailPassword && await gmailPage.locator(passwordSelector).first().isVisible().catch(() => false)) {
                    await gmailPage.waitForTimeout((this.bot.config as any)?.passwordFillDelayMs ?? DEFAULT_PASSWORD_FILL_DELAY_MS)
                    await gmailPage.fill(passwordSelector, gmailPassword)
                    await gmailPage.waitForTimeout(300)
                    await gmailPage.keyboard.press('Enter')
                    await gmailPage.waitForTimeout(2200)
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Used resolved Gmail password to sign in to Gmail (UI).')
                } else if (!gmailPassword) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'No Gmail password provided — not attempting to sign in via UI (will try to read inbox if already logged in).', 'warn')
                }
            } catch { /* ignore */ }

            await gmailPage.waitForSelector('div[role="main"], div[role="list"]', { timeout: 15000 }).catch(() => null)
            await gmailPage.waitForTimeout(1200)

            const searchTerms = [
                'Microsoft',
                'code to sign in',
                'subject:("code to sign in")',
                'from:(account-security-noreply@accountprotection.microsoft.com)',
                'from:(no-reply@accountprotection.microsoft.com)',
                'subject:("Your Microsoft account")'
            ]

            let foundCode: string | null = null
            const overallRetries = (this.bot.config as any)?.gmailSearchRetries ?? 3
            const perSearchDelay = (this.bot.config as any)?.gmailSearchDelayMs ?? 1200

            const bodySelectors = [
                'div.a3s',
                'div.ii.gt',
                'div[aria-label="Message Body"]',
                'div[role="main"] article',
                'div[role="listitem"]',
                'article'
            ]

            const bodySelectorString = bodySelectors.join(',')

            const parseTimeOrZero = (timeStr: string | null) => {
                if (!timeStr) return 0
                const parsed = Date.parse(timeStr)
                return isNaN(parsed) ? 0 : parsed
            }

            for (let attempt = 0; attempt < overallRetries && !foundCode; attempt++) {
                for (const term of searchTerms) {
                    try {
                        await gmailPage.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`)
                        await gmailPage.waitForTimeout(perSearchDelay)

                        const threadsLocator = gmailPage.locator('tr.zA, div[role="listitem"]')
                        const threadsCount = await threadsLocator.count().catch(() => 0)

                        const threads: Array<{ index: number, ts: number }> = []
                        for (let i = 0; i < threadsCount; i++) {
                            try {
                                const row = threadsLocator.nth(i)
                                const visible = await row.isVisible().catch(() => false)
                                if (!visible) continue
                                const timeText = await row.evaluate((r: Element) => {
                                    const selCandidates = [
                                        'td.xW span',
                                        'span[title]',
                                        'abbr',
                                        'span[aria-label]'
                                    ]
                                    for (const s of selCandidates) {
                                        const el = r.querySelector(s)
                                        if (el) {
                                            const t = (el.getAttribute('title') || el.textContent || '').trim()
                                            if (t) return t
                                        }
                                    }
                                    return (r.textContent || '').slice(0, 200)
                                }).catch(() => '')
                                threads.push({ index: i, ts: parseTimeOrZero(timeText) })
                            } catch { /* ignore */ }
                        }

                        if (threads.length === 0 && threadsCount > 0) {
                            for (let i = 0; i < threadsCount; i++) threads.push({ index: i, ts: 0 })
                        }

                        threads.sort((a, b) => b.ts - a.ts)

                        for (const tinfo of threads) {
                            if (foundCode) break
                            try {
                                const threadRow = threadsLocator.nth(tinfo.index)
                                const canClick = await threadRow.isVisible().catch(() => false)
                                if (!canClick) continue
                                await threadRow.click().catch(() => { })
                                await gmailPage.waitForTimeout(900)
                                await gmailPage.waitForTimeout(400)

                                const messagesInThread = (await gmailPage.evaluate((bodySel) => {
                                    const nodes = Array.from(document.querySelectorAll(bodySel)).filter(n => n && n.textContent && n.textContent.trim().length > 0)
                                    return nodes.map((n: Element) => {
                                        let container: Element | null = (n.closest && n.closest('div.adn')) || n.closest('div[role="listitem"]') || n.closest('article') || n.parentElement
                                        let timeText = ''
                                        if (container) {
                                            const timeCandidates = [
                                                container.querySelector('span[title]'),
                                                container.querySelector('abbr'),
                                                container.querySelector('span[aria-label]'),
                                                container.querySelector('.g3 .xW span'),
                                                container.querySelector('.gH span')
                                            ]
                                            for (const el of timeCandidates) {
                                                if (el) {
                                                    timeText = (el.getAttribute('title') || el.textContent || '').trim()
                                                    if (timeText) break
                                                }
                                            }
                                        }
                                        return { text: n.textContent || '', timeText }
                                    })
                                }, bodySelectorString).catch(() => [])) as Array<{ text: string, timeText: string }>

                                const msgs = messagesInThread || []
                                if (Array.isArray(msgs) && msgs.length > 0) {
                                    let bestIdx = msgs.length - 1
                                    let bestTs = 0
                                    for (let mi = 0; mi < msgs.length; mi++) {
                                        const parsed = Date.parse(msgs[mi]?.timeText || '')
                                        if (!isNaN(parsed) && parsed > bestTs) { bestTs = parsed; bestIdx = mi }
                                    }
                                    const tryOrder: number[] = [bestIdx]
                                    for (let offset = 1; offset < msgs.length; offset++) {
                                        const after = bestIdx + offset
                                        const before = bestIdx - offset
                                        if (after < msgs.length) tryOrder.push(after)
                                        if (before >= 0) tryOrder.push(before)
                                    }
                                    for (const mi of tryOrder) {
                                        if (foundCode) break
                                        try {
                                            const bodyText = msgs[mi]?.text || ''
                                            if (!bodyText || bodyText.trim().length === 0) continue
                                            const candidate = this.extractCodeFromText(bodyText)
                                            if (candidate) { foundCode = candidate; break }
                                            const matches = bodyText.match(/\d{4,8}/g)
                                            if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                        } catch { /* ignore per-message errors */ }
                                    }
                                } else {
                                    try {
                                        const bodyText = await gmailPage.evaluate(() => (document && document.body) ? (document.body.innerText || '') : '').catch(() => '')
                                        if (bodyText && bodyText.trim().length > 0) {
                                            const candidate = this.extractCodeFromText(bodyText)
                                            if (candidate) { foundCode = candidate; break }
                                            const matches = bodyText.match(/\d{4,8}/g)
                                            if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                        }
                                    } catch { /* ignore */ }
                                }

                                await gmailPage.goBack().catch(() => null)
                                await gmailPage.waitForTimeout(400)
                            } catch { try { await gmailPage.goBack().catch(() => null) } catch { } }
                        }

                        if (foundCode) { this.bot.log(this.bot.isMobile, 'LOGIN', `Found candidate code in message body (term="${term}")`); break }
                    } catch { /* ignore term errors */ }
                }

                if (!foundCode) await gmailPage.waitForTimeout(Math.max(800, perSearchDelay * 1.5))
            }

            // fallback inbox check
            if (!foundCode) {
                try {
                    await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox')
                    await gmailPage.waitForTimeout(1200)
                    const threadsLocator = gmailPage.locator('tr.zA, div[role="listitem"]')
                    const threadsCount = await threadsLocator.count().catch(() => 0)
                    const maxToCheck = Math.min(8, threadsCount)
                    const threads: Array<{ index: number, ts: number }> = []
                    for (let i = 0; i < threadsCount && threads.length < maxToCheck; i++) {
                        try {
                            const row = threadsLocator.nth(i)
                            const visible = await row.isVisible().catch(() => false)
                            if (!visible) continue
                            const timeText = await row.evaluate((r: Element) => {
                                const el = r.querySelector('span[title], abbr, span[aria-label]')
                                return (el && (el.getAttribute('title') || el.textContent)) ? (el.getAttribute('title') || el.textContent || '') : ''
                            }).catch(() => '')
                            threads.push({ index: i, ts: parseTimeOrZero(timeText) })
                        } catch { /* ignore */ }
                    }
                    if (threads.length === 0 && threadsCount > 0) {
                        for (let i = 0; i < Math.min(maxToCheck, threadsCount); i++) threads.push({ index: i, ts: 0 })
                    }
                    threads.sort((a, b) => b.ts - a.ts)

                    for (const tinfo of threads) {
                        if (foundCode) break
                        try {
                            const thread = threadsLocator.nth(tinfo.index)
                            if (!await thread.isVisible().catch(() => false)) continue
                            await thread.click().catch(() => {})
                            await gmailPage.waitForTimeout(800)

                            const messagesInThread = (await gmailPage.evaluate((bodySel) => {
                                const nodes = Array.from(document.querySelectorAll(bodySel)).filter(n => n && n.textContent && n.textContent.trim().length > 0)
                                return nodes.map((n: Element) => {
                                    let container: Element | null = (n.closest && n.closest('div.adn')) || n.closest('div[role="listitem"]') || n.closest('article') || n.parentElement
                                    let timeText = ''
                                    if (container) {
                                        const timeCandidates = [
                                            container.querySelector('span[title]'),
                                            container.querySelector('abbr'),
                                            container.querySelector('span[aria-label]'),
                                            container.querySelector('.g3 .xW span'),
                                            container.querySelector('.gH span')
                                        ]
                                        for (const el of timeCandidates) {
                                            if (el) { timeText = (el.getAttribute('title') || el.textContent || '').trim(); if (timeText) break }
                                        }
                                    }
                                    return { text: n.textContent || '', timeText }
                                })
                            }, bodySelectorString).catch(() => [])) as Array<{ text: string, timeText: string }>

                            const msgs = messagesInThread || []
                            if (Array.isArray(msgs) && msgs.length > 0) {
                                let bestIdx = msgs.length - 1
                                let bestTs = 0
                                for (let mi = 0; mi < msgs.length; mi++) {
                                    const parsed = Date.parse(msgs[mi]?.timeText || '')
                                    if (!isNaN(parsed) && parsed > bestTs) { bestTs = parsed; bestIdx = mi }
                                }
                                const tryOrder: number[] = [bestIdx]
                                for (let offset = 1; offset < msgs.length; offset++) {
                                    const after = bestIdx + offset
                                    const before = bestIdx - offset
                                    if (after < msgs.length) tryOrder.push(after)
                                    if (before >= 0) tryOrder.push(before)
                                }
                                for (const mi of tryOrder) {
                                    if (foundCode) break
                                    const bodyText = msgs[mi]?.text || ''
                                    if (!bodyText) continue
                                    const candidate = this.extractCodeFromText(bodyText)
                                    if (candidate) { foundCode = candidate; break }
                                    const matches = bodyText.match(/\d{4,8}/g)
                                    if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                }
                            } else {
                                const pageText = await gmailPage.evaluate(() => (document && document.body) ? (document.body.innerText || '') : '').catch(() => '')
                                if (pageText && pageText.trim().length > 0) {
                                    const candidate = this.extractCodeFromText(pageText)
                                    if (candidate) { foundCode = candidate; break }
                                    const matches = pageText.match(/\d{4,8}/g)
                                    if (matches && matches.length > 0) { foundCode = matches[matches.length - 1] || null; break }
                                }
                            }

                            await gmailPage.goBack().catch(() => null)
                            await gmailPage.waitForTimeout(300)
                        } catch { /* ignore thread errors */ }
                    }
                } catch { /* ignore fallback errors */ }
            }

            try { await gmailPage.close() } catch { }
            if (usedTempBrowser && tempBrowser) { try { await tempBrowser.close() } catch { } }

            if (foundCode) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Found verification code in Gmail: ${foundCode}`)
                return foundCode
            }

            this.bot.log(this.bot.isMobile, 'LOGIN', 'No verification code found in Gmail', 'warn')
            return null
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `fetchCodeFromGmail error: ${err}`, 'error')
            return null
        }
    }



    private extractCodeFromText(bodyText: string): string | null {
        if (!bodyText || typeof bodyText !== 'string') return null
        const txt = bodyText.replace(/\u00A0/g, ' ').replace(/\r/g, ' ').replace(/\n+/g, '\n')
        const patterns: Array<{ re: RegExp, name: string }> = [
            { re: /your\s+single[-\s]?use\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'your single-use code is' },
            { re: /single[-\s]?use\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'single-use code' },
            { re: /your\s+one[-\s]?time\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'one-time code' },
            { re: /verification\s+code\s*(?:is|:)?\s*[:\-\s]*([0-9]{4,8})/i, name: 'verification code' },
            { re: /(?:code\s*(?:is|:)|is:)\s*([0-9]{4,8})\b/i, name: 'code is (fallback)' },
            { re: /code[:\s]*([0-9]{4,8})/i, name: 'code:' }
        ]
        for (const p of patterns) {
            const m = txt.match(p.re)
            if (m && m[1]) {
                const code = m[1].trim()
                if (/^\d{4,8}$/.test(code)) return code
            }
        }
        return null
    }
}
