#!/usr/bin/env node
/**
 * Operator tool: set a user's product-layer tier (CONTRACT §Tiers —
 * "Promotion: an operator operation `set-tier` by EMAIL").
 *
 * Usage:
 *   node dist/bin/set-tier.js --email <e> --tier default|pro
 *   node dist/bin/set-tier.js --user <uid> --tier default|pro
 *   node dist/bin/set-tier.js --email <e> --show
 *   node dist/bin/set-tier.js --user <uid> --show
 *
 * By email: updates the record carrying that email when one exists
 * (prints the record JSON); otherwise records a PENDING promotion,
 * consumed at that email's first login (resolveTier at record
 * creation), and prints {"pending": <email>, "tier": <tier>}.
 * --show prints getRecord (--user) / getPendingByEmail (--email) JSON
 * without mutating anything.
 *
 * Exit codes: 0 success · 1 store construction / runtime failure ·
 * 2 usage error (invalid args, usage printed on stderr).
 *
 * Store selection is the gateway's own — USER_STORE / USER_STORE_DIR
 * configure it exactly as for the gateway bin, so the operator writes
 * the same store the gateway reads:
 *   local (default) — createUserTierStore(process.env): the JSON store
 *     under USER_STORE_DIR.
 *   prod — USER_STORE=prod + GCP_PROJECT_ID=<project>: the Firestore
 *     store the deployed gateway reads (collection
 *     `icecream_user_tiers`), built by createProdUserTierStore with
 *     the operator's own credentials (ADC / deployer credentials).
 *     Prod without GCP_PROJECT_ID fails closed (exit 1) — there is no
 *     silent fallback to a local store the gateway never reads.
 * Example (promote the deploy test user in the deployed store):
 *   USER_STORE=prod GCP_PROJECT_ID=<project> \
 *     node dist/bin/set-tier.js --email <e> --tier pro
 */
import { createProdUserTierStore, createUserTierStore, isTier, userStoreProvider, } from '../deploy/userStore.js';
function usage(msg) {
    console.error(`set-tier: ${msg}`);
    console.error('usage: set-tier (--email <e> | --user <uid>) (--tier default|pro | --show)');
    process.exit(2);
}
function parseArgs(argv) {
    const out = { show: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf('=');
        const flag = eq >= 0 ? arg.slice(0, eq) : arg;
        const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
        const value = () => {
            if (inline !== undefined)
                return inline;
            const next = argv[++i];
            if (next === undefined)
                usage(`${flag} requires a value`);
            return next;
        };
        switch (flag) {
            case '--email':
                out.email = value();
                break;
            case '--user':
                out.user = value();
                break;
            case '--tier':
                out.tier = value();
                break;
            case '--show':
                out.show = true;
                break;
            default:
                usage(`unknown argument: ${arg}`);
        }
    }
    return out;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if ((args.email === undefined) === (args.user === undefined)) {
        usage('exactly one of --email / --user is required');
    }
    if (!args.show && args.tier === undefined) {
        usage('--tier is required (or pass --show to only read)');
    }
    if (args.tier !== undefined && !isTier(args.tier)) {
        usage(`--tier must be 'default' or 'pro' (got '${args.tier}')`);
    }
    const tier = args.tier;
    let store;
    try {
        // Prod targets the deployed Firestore store (async client load);
        // local keeps the synchronous env-driven factory. Both branches
        // fail closed on misconfiguration — see the header.
        store =
            userStoreProvider(process.env) === 'prod'
                ? await createProdUserTierStore(process.env)
                : createUserTierStore(process.env);
    }
    catch (e) {
        console.error(`set-tier: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    try {
        if (args.user !== undefined) {
            if (!args.show && tier !== undefined) {
                const rec = await store.setTierByUserId(args.user, tier);
                console.log(JSON.stringify(rec));
                return 0;
            }
            // --show: read-only.
            const rec = await store.getRecord(args.user);
            console.log(JSON.stringify(rec));
            return 0;
        }
        // --email
        const email = args.email;
        if (!args.show && tier !== undefined) {
            const rec = await store.setTierByEmail(email, tier);
            if (rec) {
                console.log(JSON.stringify(rec));
            }
            else {
                console.log(JSON.stringify({ pending: email, tier }));
            }
            return 0;
        }
        // --show: read-only.
        const pending = await store.getPendingByEmail(email);
        console.log(JSON.stringify({ pending: email, tier: pending }));
        return 0;
    }
    catch (e) {
        console.error(`set-tier: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
main().then((code) => process.exit(code), (e) => {
    console.error(`set-tier: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
