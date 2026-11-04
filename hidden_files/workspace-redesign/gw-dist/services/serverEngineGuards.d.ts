export declare const PY_DISABLED_ON_SERVER = "PY disabled on server";
export declare const WEBSERVICE_DISABLED_ON_SERVER = "WEBSERVICE disabled on server";
export declare const MARKET_FETCH_DISABLED_ON_SERVER = "STOCKHISTORY/GOOGLEFINANCE live market-data fetch disabled on server";
/**
 * Install the denying batch-11 providers for this process. Idempotent.
 * Call once at server engine host startup, before the listener serves.
 */
export declare function installServerEngineGuards(): void;
