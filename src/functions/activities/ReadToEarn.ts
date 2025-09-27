import { randomBytes } from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { Workers } from '../Workers'

import { DashboardData } from '../../interface/DashboardData'


export class ReadToEarn extends Workers {
    public async doReadToEarn(accessToken: string, data: DashboardData) {
        this.bot.log(this.bot.isMobile, 'READ-TO-EARN', 'Starting Read to Earn')

        try {
            // Human-like delay before starting (1-3 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(900, 1000))

            let geoLocale = data.userProfile.attributes.country
            geoLocale = (this.bot.config.searchSettings.useGeoLocaleQueries && geoLocale.length === 2) ? geoLocale.toLowerCase() : 'us'

            const userDataRequest: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'X-Rewards-Country': geoLocale,
                    'X-Rewards-Language': 'en'
                }
            }

            // Human-like delay before API request (0.5-1.5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1000))

            const userDataResponse = await this.bot.axios.request(userDataRequest)
            const userData = (await userDataResponse.data).response
            let userBalance = userData.balance

            const jsonData = {
                amount: 1,
                country: geoLocale,
                id: '1',
                type: 101,
                attributes: {
                    offerid: 'ENUS_readarticle3_30points'
                }
            }

            const articleCount = 10
            for (let i = 0; i < articleCount; ++i) {
                jsonData.id = randomBytes(64).toString('hex')

                // Human-like delay before preparing request (0.3-1 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))

                const claimRequest = {
                    url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': geoLocale,
                        'X-Rewards-Language': 'en'
                    },
                    data: JSON.stringify(jsonData)
                }

                // Human-like delay before making API call (0.5-2 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(500, 2000))

                const claimResponse = await this.bot.axios.request(claimRequest)
                const newBalance = (await claimResponse.data).response.balance

                if (newBalance == userBalance) {
                    this.bot.log(this.bot.isMobile, 'READ-TO-EARN', 'Read all available articles')
                    break
                } else {
                    this.bot.log(this.bot.isMobile, 'READ-TO-EARN', `Read article ${i + 1} of ${articleCount} max | Gained ${newBalance - userBalance} Points`)
                    userBalance = newBalance

                    // Existing delay from config
                    await this.bot.utils.wait(Math.floor(this.bot.utils.randomNumber(this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.min), this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.max))))
                }

                // Additional human-like delay between articles (2-5 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
            }


            this.bot.log(this.bot.isMobile, 'READ-TO-EARN', 'Completed Read to Earn')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'READ-TO-EARN', 'An error occurred:' + error, 'error')
        }
    }
}