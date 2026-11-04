export declare const DEFAULT_TICK_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export interface TickAuthEnv {
    audience: string;
    saEmail: string;
    jwksUrl: string;
}
/** Read the tick auth config; null when not (fully) configured. */
export declare function tickAuthConfig(env: NodeJS.ProcessEnv): TickAuthEnv | null;
/**
 * Verify a Scheduler OIDC Authorization header against the config.
 * Returns true only for a fully valid token from the configured
 * scheduler service account. Never throws.
 */
export declare function verifySchedulerOidc(authorization: string | undefined, config: TickAuthEnv, fetchFn?: typeof fetch, nowMs?: number): Promise<boolean>;
