import type { Page } from 'patchright'
import { Workers } from '../../Workers'
import { URLs } from '../../../constants/urls'
import { REWARDS_DASHBOARD_URL, readPointClaim } from '../../../util/PointClaim'

// Candidate server-action names that claim all available bonus points.
// Microsoft renames these across bundle releases, so we try known aliases,
// then fall back to a fuzzy name search when none match exactly.
const CLAIM_ALL_ACTION_NAMES = [
    'reportClaimAllPoints',
    'claimAllPoints',
    'reportClaimReward',
    'reportClaimPoints',
    'claimAllRewards',
    'reportBonusPoints',
    'claimBonusPoints'
]

export class ClaimBonusPoints extends Workers {
    /**
     * 1. Read the dashboard's "Ready to claim" amount - nothing to do when it is 0
     * 2. Fire the claim-all server action at /dashboard (the route whose bundle owns it)
     * 3. Otherwise click the claim button on the dashboard itself
     * Each claim is confirmed by the ready amount dropping to 0 or the balance rising.
     */
    public async claimBonusPoints() {
        const page = this.openPage()
        if (!page) {
            this.bot.logger.warn(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'No open page to read the dashboard from')
            return
        }

        let claimableBefore: number | null = null
        try {
            claimableBefore = (await readPointClaim(page)).claimable
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Could not read the dashboard claim state | ${error instanceof Error ? error.message : String(error)}`
            )
        }

        if (claimableBefore === 0) {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Nothing to claim | readyToClaim=0')
            return
        }

        const oldBalance = await this.bot.browser.func.getCurrentPoints().catch(() => this.bot.userData.currentPoints)
        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `Starting ClaimBonusPoints | readyToClaim=${claimableBefore ?? 'unknown'} | currentBalance=${oldBalance}`
        )

        const resolved = this.resolveActionId()
        if (resolved) {
            try {
                const { status, acknowledged } = await this.bot.browser.func.reportServerAction(resolved.id, [], {
                    url: URLs.rewards.dashboard
                })
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Server action response | action=${resolved.name} | status=${status} | acknowledged=${acknowledged}`
                )

                if (await this.confirmClaim(page, claimableBefore, oldBalance, `action ${resolved.name}`)) return

                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Claim action not confirmed (status=${status}, acknowledged=${acknowledged}) - trying the dashboard button`
                )
            } catch (error) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Claim action failed - trying the dashboard button | ${error instanceof Error ? error.message : String(error)}`
                )
            }
        } else {
            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Claim action id not discovered (looked for [${CLAIM_ALL_ACTION_NAMES.join(', ')}] + any "*claim*all*" key) - using the dashboard button`
            )
        }

        if (await this.claimReadyPointsViaDom(page)) {
            if (!(await this.confirmClaim(page, claimableBefore, oldBalance, 'dashboard button'))) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    'Claim button clicked but the points did not show up as claimed'
                )
            }
        }
    }

    // The flow may have closed one of the browsers by now; any page of this account carries its cookies
    private openPage(): Page | null {
        const current = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        return [current, this.bot.mainMobilePage, this.bot.mainDesktopPage].find(p => p && !p.isClosed()) ?? null
    }

    private async confirmClaim(page: Page, claimableBefore: number | null, oldBalance: number, via: string) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            await this.bot.utils.wait(2000 * attempt)

            const claimableAfter = await readPointClaim(page)
                .then(state => state.claimable)
                .catch(() => null)
            const newBalance = await this.bot.browser.func.getCurrentPoints().catch(() => oldBalance)
            const gained = newBalance - oldBalance
            const cleared = claimableBefore !== null && claimableBefore > 0 && claimableAfter === 0

            if (cleared || gained > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + Math.max(gained, 0)
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Claimed bonus points via ${via} | claimed=${claimableBefore ?? gained} | balance ${oldBalance} -> ${newBalance}`,
                    'green'
                )
                return true
            }
        }
        return false
    }

    /**
     * DOM path on the dashboard itself (ported from the older Val-tracker build):
     * 1. Find the "Ready to claim" card
     * 2. Click it to open the claim dialog/side panel
     * 3. Within the dialog, click the "Claim points" button
     * This bypasses the need for a discovered server-action id, so it still works
     * when Microsoft renames/removes the bundle action.
     */
    private async claimReadyPointsViaDom(page: Page): Promise<boolean> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Opening the dashboard to claim')
            await page.goto(REWARDS_DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
            await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)
            await this.bot.utils.wait(this.bot.utils.humanActivityDelay())

            // 1. Open the "Ready to claim" card (case-insensitive)
            const readyCard = page.locator('text=/ready to claim/i').first()
            if (await readyCard.isVisible().catch(() => false)) {
                await readyCard.click()
                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
            }

            // 2. Scope to the claim dialog / side panel if present
            const dialog = page.locator('[role="dialog"], [role="sidebar"], [class*="claim"][class*="panel"]').first()

            if (await dialog.isVisible().catch(() => false)) {
                // 3. Detect "nothing to claim"
                if (await dialog.locator('text=/no points to claim/i').isVisible().catch(() => false)) {
                    this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Dashboard says there are no points to claim')
                    return false
                }

                // 4. Click the "Claim points" button inside the dialog
                const claimBtn = dialog
                    .getByRole('button', { name: /claim points|claim all|claim/i })
                    .or(dialog.locator('button:has-text("Claim")'))
                    .first()

                if (await claimBtn.isVisible().catch(() => false)) {
                    await claimBtn.click()
                    await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
                    this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Claim button clicked in the claim panel')
                    return true
                }
            }

            // Fallback: a claim button directly on the dashboard (no dialog)
            const genericClaim = page
                .getByRole('button', { name: /claim points|claim all|claim/i })
                .or(page.locator('button:has-text("Claim")'))
                .first()
            if (await genericClaim.isVisible().catch(() => false)) {
                await genericClaim.click()
                await this.bot.utils.wait(this.bot.utils.humanActivityDelay())
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Claim button clicked on the dashboard')
                return true
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                'Points are ready but no claim button was found on the dashboard'
            )
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Dashboard claim failed | ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    /**
     * Locate the server-action id that claims all bonus points.
     * Tries every known alias first, then fuzzy-matches the discovered
     * action names so a Microsoft bundle rename still resolves.
     */
    private resolveActionId(): { name: string; id: string } | null {
        const actions = this.bot.nextActions

        for (const name of CLAIM_ALL_ACTION_NAMES) {
            const id = actions[name]
            if (id) return { name, id }
        }

        const fuzzy = Object.keys(actions).find(k => /claim/i.test(k) && /(?:all|every|point|bonus|reward)/i.test(k))
        if (fuzzy) return { name: fuzzy, id: actions[fuzzy]! }

        return null
    }
}
