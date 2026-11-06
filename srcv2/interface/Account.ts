export interface Account {
    email: string
    password: string
    totpSecret?: string
    // Optional mailbox access used to read Microsoft email codes automatically
    emailCode?: AccountEmailCode
    recoveryEmail: string
    geoLocale: 'auto' | string
    langCode: 'en' | string
    proxy: AccountProxy
    saveFingerprint: ConfigSaveFingerprint
}

export interface AccountEmailCode {
    // Gmail: an App Password (https://myaccount.google.com/apppasswords); the account password is tried after it
    appPassword?: string
    // Mailbox login, defaults to recoveryEmail or email
    user?: string
    imapHost?: string
    imapPort?: number
    // Seconds to wait for the code mail before giving up (default 180)
    timeoutSeconds?: number
    enabled?: boolean
}

export interface AccountProxy {
    proxyAxios: boolean
    url: string
    port: number
    password: string
    username: string
}

export interface ConfigSaveFingerprint {
    mobile: boolean
    desktop: boolean
}
