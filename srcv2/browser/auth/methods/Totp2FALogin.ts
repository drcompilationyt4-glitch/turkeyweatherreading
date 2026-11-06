import type { Page } from 'patchright'
import * as OTPAuth from 'otpauth'
import type { MicrosoftRewardsBot } from '../../../index'
import { canPromptForInput, getErrorMessage, promptInput } from './LoginUtils'

export class TotpLogin {
    private readonly textInputSelector =
        'form[name="OneTimeCodeViewForm"] input[type="text"], input#floatingLabelInput5'
    private readonly secondairyInputSelector = 'input[id="otc-confirmation-input"], input[name="otc"]'
    // New Fluent UI: one box per digit (or a single box) inside the code-entry component
    private readonly codeEntryInputSelector = '[data-testid="codeEntry"] input, [data-testid="codeInputWrapper"] input'
    private readonly submitButtonSelector = 'button[type="submit"]'
    private readonly primaryButtonSelector = 'button[data-testid="primaryButton"]'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5
    private readonly maxAutoAttempts = 2

    constructor(private bot: MicrosoftRewardsBot) {}

    private generateTotpCode(secret: string): string {
        return new OTPAuth.TOTP({ secret, digits: 6 }).generate()
    }

    // A code typed near the end of its 30s window can expire before Microsoft checks it
    private async freshCode(secret: string): Promise<string> {
        const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30)
        if (secondsLeft < 8) await this.bot.utils.wait((secondsLeft + 1) * 1000)
        return this.generateTotpCode(secret)
    }

    private async isVisible(page: Page, selector: string): Promise<boolean> {
        return page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
    }

    private async codeInputVisible(page: Page): Promise<boolean> {
        return (
            (await this.isVisible(page, this.textInputSelector)) ||
            (await this.isVisible(page, this.secondairyInputSelector)) ||
            (await this.isVisible(page, this.codeEntryInputSelector))
        )
    }

    private async fillCode(page: Page, code: string): Promise<boolean> {
        try {
            const visibleInput = await page
                .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (visibleInput) {
                await visibleInput.click().catch(() => {})
                await this.bot.utils.typeLikeHuman(page, code, 'code')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-TOTP', 'Filled TOTP input')
                return true
            }

            const secondairyInput = await page.$(this.secondairyInputSelector)
            if (secondairyInput) {
                await secondairyInput.click().catch(() => {})
                await this.bot.utils.typeLikeHuman(page, code, 'code')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-TOTP', 'Filled TOTP input')
                return true
            }

            // Multi-box entry advances focus box to box as each digit is typed
            const boxes = page.locator(`:is(${this.codeEntryInputSelector}):visible`)
            const count = await boxes.count().catch(() => 0)
            if (count > 0) {
                for (let index = 0; index < count; index++) await boxes.nth(index).fill('').catch(() => {})
                await boxes.first().click().catch(() => {})
                await this.bot.utils.typeLikeHuman(page, code, 'code')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-TOTP', `Filled TOTP code entry (${count} box(es))`)
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-TOTP', 'No TOTP input field found')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-TOTP',
                `Failed to fill TOTP input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    // The multi-box UI submits itself once every digit is in; only press a button if we are still on the code page
    private async submitCode(page: Page): Promise<void> {
        await this.bot.utils.wait(this.bot.utils.randomNumber(600, 1400))

        if (await this.codeInputVisible(page)) {
            const button = (await this.isVisible(page, this.submitButtonSelector))
                ? this.submitButtonSelector
                : (await this.isVisible(page, this.primaryButtonSelector))
                  ? this.primaryButtonSelector
                  : null

            if (button) await this.bot.browser.utils.ghostClick(page, button)
            else await page.keyboard.press('Enter').catch(() => {})
        }

        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    }

    private async clearCode(page: Page): Promise<void> {
        const boxes = page.locator(`:is(${this.codeEntryInputSelector}):visible`)
        const count = await boxes.count().catch(() => 0)
        for (let index = 0; index < count; index++) await boxes.nth(index).fill('').catch(() => {})

        for (const selector of [this.textInputSelector, this.secondairyInputSelector]) {
            const input = page.locator(selector).first()
            if (await input.isVisible().catch(() => false)) await input.fill('').catch(() => {})
        }
    }

    async handle(page: Page, totpSecret?: string): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-TOTP', 'TOTP 2FA authentication requested')

            if (totpSecret) {
                for (let attempt = 1; attempt <= this.maxAutoAttempts; attempt++) {
                    const code = await this.freshCode(totpSecret)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN-TOTP',
                        `Generated TOTP code from secret (attempt ${attempt}/${this.maxAutoAttempts})`
                    )

                    if (!(await this.fillCode(page, code))) {
                        this.bot.logger.error(this.bot.isMobile, 'LOGIN-TOTP', 'Unable to fill TOTP input field')
                        throw new Error('TOTP input field not found')
                    }

                    await this.submitCode(page)

                    const errorMessage = await getErrorMessage(page)
                    if (!errorMessage) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN-TOTP',
                            'TOTP authentication completed successfully'
                        )
                        return
                    }

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-TOTP',
                        `TOTP code rejected: ${errorMessage} (attempt ${attempt}/${this.maxAutoAttempts})`
                    )
                    if (attempt === this.maxAutoAttempts) {
                        throw new Error(`TOTP authentication failed: ${errorMessage}`)
                    }

                    // Clock drift or a rolled window - retry with the next code
                    await this.clearCode(page)
                    const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30)
                    await this.bot.utils.wait((secondsLeft + 1) * 1000)
                }
            }

            if (!canPromptForInput()) {
                throw new Error('TOTP secret is required because interactive stdin is unavailable')
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-TOTP', 'No TOTP secret provided, awaiting manual input')

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                const code = await promptInput({
                    question: `Enter the 6-digit TOTP code (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: code => /^\d{6}$/.test(code)
                })

                if (!code || !/^\d{6}$/.test(code)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-TOTP',
                        `Invalid or missing code (attempt ${attempt}/${this.maxManualAttempts}) | input length=${code?.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual TOTP input failed or timed out')
                    }
                    continue
                }

                const filled = await this.fillCode(page, code)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-TOTP',
                        `Unable to fill TOTP input (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('TOTP input field not found')
                    }
                    continue
                }

                await this.submitCode(page)

                // Check if wrong code was entered
                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-TOTP',
                        `Incorrect code: ${errorMessage} (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached: ${errorMessage}`)
                    }
                    await this.clearCode(page)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-TOTP', 'TOTP authentication completed successfully')
                return
            }

            throw new Error(`TOTP input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-TOTP',
                `Error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
