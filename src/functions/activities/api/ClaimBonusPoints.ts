import { Workers } from '../../Workers'

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
    public async claimBonusPoints() {
        const resolved = this.resolveActionId()
        if (!resolved) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Skipping: "claimAllPoints" action id not discovered in bundle (looked for [${CLAIM_ALL_ACTION_NAMES.join(', ')}] + any "*claim*all*" key)`
            )
            return
        }
        const actionId = resolved.id

        const oldBalance = this.bot.userData.currentPoints

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `Starting ClaimBonusPoints | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [])

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            const gainedPoints = newBalance - oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Response | status=${status} | acknowledged=${acknowledged} | previousBalance=${oldBalance} | currentBalance=${newBalance} | pointsGained=${gainedPoints}`
            )

            if (acknowledged) {
                if (gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Completed ClaimBonusPoints | acknowledged=true | pointsGained=${gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Nothing claimed | status=${status} | pointsGained=0 | currentBalance=${newBalance}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Error in claimBonusPoints | message=${error instanceof Error ? error.message : String(error)}`
            )
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

        const fuzzy = Object.keys(actions).find(
            k => /claim/i.test(k) && /(?:all|every|point|bonus|reward)/i.test(k)
        )
        if (fuzzy) return { name: fuzzy, id: actions[fuzzy]! }

        return null
    }
}
