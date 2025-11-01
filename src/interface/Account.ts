export interface Account {
    /** Enable/disable this account (if false, account will be skipped during execution) */
    enabled?: boolean;

    /** Primary login email for the account */
    email: string;

    /** Account password */
    password: string;

    /** Optional TOTP secret in Base32 (e.g., from Microsoft Authenticator setup) */
    totp?: string;

    /** Optional recovery email used to verify masked address on Microsoft login screens */
    recoveryEmail?: string;

    /** Proxy settings used for this account */
    proxy: AccountProxy;
}

export interface AccountProxy {
    /** Whether to route axios requests through this proxy (used by some network helpers) */
    proxyAxios: boolean;

    /** Proxy host (hostname or IP) */
    url: string;

    /** Proxy port */
    port: number;

    /** Proxy authentication password */
    password: string;

    /** Proxy authentication username */
    username: string;
}
