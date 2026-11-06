import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import type { Account } from '../../../interface/Account'
import { EmailCodeFetcher } from '../../../util/EmailCodeFetcher'
import { canPromptForInput, getErrorMessage, getSubtitleMessage, promptInput } from './LoginUtils'

export class CodeLogin {
    private readonly maxAutoCodes = 3
    private readonly resendPattern = /resend|send (a )?new code|send again|didn.t (get|receive)/i
    private readonly textInputSelector = '[data-testid="codeInputWrapper"]'
    private readonly secondairyInputSelector = 'input[id="otc-confirmation-input"], input[name="otc"], #iOttText'
    // Old wrapper and the new Fluent "Verify your email" input
    private readonly emailInputSelector = '[data-testid="proof-confirmation"], input#proof-confirmation-email-input'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: MicrosoftRewardsBot) {}

    private async fillCode(page: Page, code: string): Promise<boolean> {
        try {
            const visibleInput = await page
                .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (visibleInput) {
                await this.bot.utils.typeLikeHuman(page, code, 'code')
                const stilOnPage = await page
                    .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 750 })
                    .then(() => true)
                    .catch(() => false)
                if (stilOnPage) {
                    await page.keyboard.press('Enter')
                }
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Filled code input')
                return true
            }

            const secondairyInput = await page.$(this.secondairyInputSelector)
            if (secondairyInput) {
                await secondairyInput.click().catch(() => {})
                await this.bot.utils.typeLikeHuman(page, code, 'code')

                const stilOnPage = await page
                    .waitForSelector(this.secondairyInputSelector, { state: 'visible', timeout: 750 })
                    .then(() => true)
                    .catch(() => false)
                if (stilOnPage) {
                    await page.keyboard.press('Enter')
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Filled code input')
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', 'No code input field found')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-CODE',
                `Failed to fill code input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            const visibleInput = await page
                .waitForSelector(this.emailInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (visibleInput) {
                // Focus the actual text box (the wrapper match may not be the input itself)
                const input = page.locator('input#proof-confirmation-email-input, [data-testid="proof-confirmation"] input')
                await (
                    (await input.first().isVisible().catch(() => false)) ? input.first() : visibleInput
                )
                    .click()
                    .catch(() => {})
                await this.bot.utils.typeLikeHuman(page, email, 'text')
                await page.keyboard.press('Enter')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Submitted verification email')
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', 'Email verification input not found')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-CODE',
                `Failed to fill email input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async clearCodeInput(page: Page): Promise<void> {
        const inputToClear = await page.$(`${this.textInputSelector} input, ${this.secondairyInputSelector}`).catch(() => null)
        if (inputToClear) {
            await inputToClear.click().catch(() => {})
            await page.keyboard.press('Control+A')
            await page.keyboard.press('Backspace')
        }
    }

    private async clickResend(page: Page): Promise<void> {
        for (const role of ['button', 'link'] as const) {
            const el = page.getByRole(role, { name: this.resendPattern }).first()
            if (await el.isVisible().catch(() => false)) {
                await el.click({ timeout: 5000 }).catch(() => {})
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'No code email yet, clicked "resend code"')
                return
            }
        }
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN-CODE', 'No code email yet and no resend option found')
    }

    private createFetcher(account?: Account): EmailCodeFetcher | null {
        if (!account || account.emailCode?.enabled === false) return null

        const passwords = [account.emailCode?.appPassword, account.password].filter((p): p is string => !!p)
        if (!passwords.length) return null

        return new EmailCodeFetcher({
            user: account.emailCode?.user || account.email,
            passwords,
            host: account.emailCode?.imapHost,
            port: account.emailCode?.imapPort,
            targetHint: account.email,
            log: (level, message) => this.bot.logger[level](this.bot.isMobile, 'LOGIN-CODE-EMAIL', message)
        })
    }

    // Reads the code from the mailbox; returns true when the page accepted one
    private async autoFillCode(page: Page, account: Account | undefined, requestedAt: number): Promise<boolean> {
        const fetcher = this.createFetcher(account)
        if (!fetcher) return false

        const timeoutMs = (account?.emailCode?.timeoutSeconds ?? 180) * 1000
        const rejected = new Set<string>()

        try {
            for (let attempt = 1; attempt <= this.maxAutoCodes; attempt++) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-CODE',
                    `Waiting for code email (attempt ${attempt}/${this.maxAutoCodes}, up to ${timeoutMs / 1000}s)`
                )

                const found = await fetcher.waitForCode({
                    notBefore: requestedAt,
                    timeoutMs,
                    exclude: rejected,
                    onStall: () => this.clickResend(page)
                })

                if (!found) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', 'No code email arrived in time')
                    return false
                }

                // A person needs a moment to switch to the inbox and read the code
                await this.bot.utils.wait(this.bot.utils.randomNumber(2500, 6000))
                if (!(await this.fillCode(page, found.code))) return false

                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                const errorMessage = await getErrorMessage(page)
                if (!errorMessage) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Code from email accepted')
                    return true
                }

                // Stale or superseded code - remember it and wait for a newer one
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', `Code from email rejected: ${errorMessage}`)
                rejected.add(found.code)
                await this.clearCodeInput(page)
            }
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-CODE',
                `Automatic email code failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        } finally {
            await fetcher.close()
        }
    }

    // Picks the full address matching a masked hint like "da*****@gmail.com"
    private resolveProofEmail(maskedHint: string | undefined, account?: Account): string | null {
        if (!account) return null
        const candidates = [account.recoveryEmail, account.emailCode?.user, account.email].filter(
            (e): e is string => !!e
        )
        if (!maskedHint) return candidates.length === 1 ? (candidates[0] as string) : null

        const [prefix = '', suffix = ''] = maskedHint.toLowerCase().split(/\*+/)
        return candidates.find(e => e.toLowerCase().startsWith(prefix) && e.toLowerCase().endsWith(suffix)) ?? null
    }

    // requestedAt: when the code email was triggered, so older mails are ignored
    async handle(page: Page, account?: Account, requestedAt: number = Date.now()): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Code login authentication requested')

            const emailMessage = await getSubtitleMessage(page)
            if (emailMessage) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', `Page message: "${emailMessage}"`)
            } else {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', 'Unable to retrieve email code destination')
            }

            const emailProofInput = await page
                .waitForSelector(this.emailInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (emailProofInput) {
                const maskedHint = emailMessage?.match(/[A-Za-z0-9._*+-]+@[A-Za-z0-9.*-]+\.[A-Za-z]{2,}/)?.[0]
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-CODE',
                    'Email verification challenge detected, awaiting email address'
                )

                let emailVerified = false

                const autoEmail = this.resolveProofEmail(maskedHint, account)
                if (autoEmail && (await this.fillEmail(page, autoEmail))) {
                    await this.bot.utils.wait(500)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    const emailError = await getErrorMessage(page)
                    if (emailError) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', `Configured email rejected: ${emailError}`)
                    } else {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Email accepted, verification code sent')
                        emailVerified = true
                    }
                }

                if (!emailVerified && !canPromptForInput()) {
                    throw new Error('Email verification requires interactive stdin; unavailable in background mode')
                }

                for (let attempt = 1; !emailVerified && attempt <= this.maxManualAttempts; attempt++) {
                    const email = await promptInput({
                        question: maskedHint
                            ? `Enter the full email address for "${maskedHint}" to send the code to (waiting ${this.maxManualSeconds}s): `
                            : `Enter the email address to send the code to (waiting ${this.maxManualSeconds}s): `,
                        timeoutSeconds: this.maxManualSeconds,
                        validate: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
                        label: account?.email
                    })

                    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN-CODE',
                            `Invalid or missing email (attempt ${attempt}/${this.maxManualAttempts}) | input length=${email?.length}`
                        )

                        if (attempt === this.maxManualAttempts) {
                            throw new Error('Manual email input failed or timed out')
                        }
                        continue
                    }

                    const filled = await this.fillEmail(page, email)
                    if (!filled) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN-CODE',
                            `Unable to fill email input (attempt ${attempt}/${this.maxManualAttempts})`
                        )

                        if (attempt === this.maxManualAttempts) {
                            throw new Error('Email verification input not found')
                        }
                        continue
                    }

                    await this.bot.utils.wait(500)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                    const emailError = await getErrorMessage(page)
                    if (emailError) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN-CODE',
                            `Email rejected: ${emailError} (attempt ${attempt}/${this.maxManualAttempts})`
                        )

                        if (attempt === this.maxManualAttempts) {
                            throw new Error(`Maximum email attempts reached: ${emailError}`)
                        }

                        const inputToClear = await page.$(this.emailInputSelector).catch(() => null)
                        if (inputToClear) {
                            await inputToClear.click()
                            await page.keyboard.press('Control+A')
                            await page.keyboard.press('Backspace')
                        }
                        continue
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Email accepted, verification code sent')
                    emailVerified = true
                    break
                }

                if (!emailVerified) {
                    throw new Error('Email verification failed')
                }

                // The code mail is only sent now
                requestedAt = Date.now()
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            }

            if (await this.autoFillCode(page, account, requestedAt)) return

            if (!canPromptForInput()) {
                throw new Error('Email-code authentication requires interactive stdin; unavailable in background mode')
            }
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Falling back to manual code entry')

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                const code = await promptInput({
                    question: `Enter the 6-digit code (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: code => /^\d{6}$/.test(code),
                    label: account?.email
                })

                if (!code || !/^\d{6}$/.test(code)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `Invalid or missing code (attempt ${attempt}/${this.maxManualAttempts}) | input length=${code?.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual code input failed or timed out')
                    }
                    continue
                }

                const filled = await this.fillCode(page, code)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `Unable to fill code input (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Code input field not found')
                    }
                    continue
                }

                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                // Check if wrong code was entered
                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `Incorrect code: ${errorMessage} (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached: ${errorMessage}`)
                    }

                    // Clear the input field before retrying
                    const inputToClear = await page.$(this.textInputSelector).catch(() => null)
                    if (inputToClear) {
                        await inputToClear.click()
                        await page.keyboard.press('Control+A')
                        await page.keyboard.press('Backspace')
                    }
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Code authentication completed successfully')
                return
            }

            throw new Error(`Code input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-CODE',
                `Error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
