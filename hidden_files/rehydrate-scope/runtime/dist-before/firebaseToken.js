/**
 * Firebase ID-token verification for POST /auth/firebase (Cycle 9).
 *
 * Verifies a Firebase ID token the same way the Firebase Admin SDK does,
 * but with zero dependencies (pure WebCrypto, like packages/service
 * auth.ts):
 *  1. Fetch Google's public signing certs
 *     (https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com),
 *     cached per Cache-Control max-age.
 *  2. Verify the token's RS256 signature with the cert matching `kid`.
 *  3. Check claims: aud == the gateway's Firebase project id,
 *     iss == https://securetoken.google.com/<projectId>,
 *     sub present, exp/iat/auth_time sane.
 *
 * Fail closed: anything unexpected throws.
 *
 * X.509 note: Google's endpoint serves PEM certificates, not JWKs. The
 * public key is extracted by locating the rsaEncryption OID
 * (1.2.840.113549.1.1.1) in the DER and reading the following BIT STRING
 * as the SubjectPublicKeyInfo — the standard structure of these certs.
 */
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cache = null;
/** Clear the in-memory cert cache (tests). */
export function clearFirebaseCertCache() {
    cache = null;
}
function base64ToBytes(b64) {
    const bin = Buffer.from(b64, 'base64');
    return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
function base64UrlDecodeToJson(segment) {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    try {
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    }
    catch {
        throw new Error('firebase: malformed token segment');
    }
}
/** Parse a DER length at `pos`; returns [length, bytesConsumed]. */
function derLength(der, pos) {
    const first = der[pos];
    if (first === undefined)
        throw new Error('firebase: truncated DER');
    if ((first & 0x80) === 0)
        return [first, 1];
    const n = first & 0x7f;
    if (n === 0 || n > 4)
        throw new Error('firebase: unsupported DER length');
    let len = 0;
    for (let i = 0; i < n; i++) {
        const b = der[pos + 1 + i];
        if (b === undefined)
            throw new Error('firebase: truncated DER length');
        len = len * 256 + b;
    }
    return [len, 1 + n];
}
/**
 * Extract the SubjectPublicKeyInfo DER from a PEM X.509 certificate by
 * locating the rsaEncryption OID and reading the BIT STRING that follows
 * it (AlgorithmIdentifier ::= SEQUENCE { OID, NULL }).
 */
export function spkiFromPemCert(pem) {
    const b64 = pem
        .replace(/-----[^-]*-----/g, '')
        .replace(/\s+/g, '');
    if (!b64)
        throw new Error('firebase: empty certificate');
    const der = base64ToBytes(b64);
    // 06 09 2A 86 48 86 F7 0D 01 01 01  — OID 1.2.840.113549.1.1.1 (rsaEncryption)
    const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
    let at = -1;
    outer: for (let i = 0; i + oid.length <= der.length; i++) {
        for (let j = 0; j < oid.length; j++) {
            if (der[i + j] !== oid[j])
                continue outer;
        }
        at = i;
        break;
    }
    if (at < 0)
        throw new Error('firebase: certificate is not an RSA cert');
    let pos = at + oid.length;
    // NULL parameters: 05 00
    if (der[pos] !== 0x05 || der[pos + 1] !== 0x00) {
        throw new Error('firebase: unexpected RSA AlgorithmIdentifier parameters');
    }
    pos += 2;
    // BIT STRING: 03 <len> 00 <spki…>
    if (der[pos] !== 0x03)
        throw new Error('firebase: expected BIT STRING after RSA OID');
    const [len, lenBytes] = derLength(der, pos + 1);
    const contentStart = pos + 1 + lenBytes;
    if (contentStart + len > der.length)
        throw new Error('firebase: BIT STRING overruns certificate');
    if (der[contentStart] !== 0x00)
        throw new Error('firebase: unexpected BIT STRING padding');
    // The BIT STRING contents are the bare PKCS#1 RSAPublicKey, but
    // WebCrypto importKey('spki', ...) requires the full SubjectPublicKeyInfo
    // envelope: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL },
    // BIT STRING { 0x00, RSAPublicKey } }. Wrap the extracted key.
    const rsaKey = der.slice(contentStart + 1, contentStart + len);
    const algId = new Uint8Array([0x30, 0x0d, ...oid, 0x05, 0x00]);
    const bitString = concatDer(new Uint8Array([0x03]), derEncodeLength(rsaKey.length + 1), new Uint8Array([0x00]), rsaKey);
    const body = concatDer(algId, bitString);
    return concatDer(new Uint8Array([0x30]), derEncodeLength(body.length), body);
}
/** DER length octets for a content length (short/long form). */
function derEncodeLength(len) {
    if (len < 0x80)
        return new Uint8Array([len]);
    const bytes = [];
    for (let n = len; n > 0; n >>= 8)
        bytes.unshift(n & 0xff);
    return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
function concatDer(...parts) {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
async function defaultFetchCerts() {
    const res = await fetch(CERTS_URL);
    if (!res.ok)
        throw new Error(`firebase: cert fetch failed (HTTP ${res.status})`);
    const certs = (await res.json());
    if (!certs || typeof certs !== 'object')
        throw new Error('firebase: cert fetch returned no certs');
    const cc = res.headers.get('cache-control') ?? '';
    const m = /max-age=(\d+)/.exec(cc);
    const maxAgeSeconds = m ? Math.max(60, Number(m[1])) : 3600;
    return { certs, maxAgeSeconds };
}
async function getCerts(fetchCerts) {
    const now = Date.now();
    if (cache && cache.expiresAtMs > now)
        return cache.certs;
    const { certs, maxAgeSeconds } = await fetchCerts();
    cache = { certs, expiresAtMs: now + maxAgeSeconds * 1000 };
    return certs;
}
/**
 * Verify a Firebase ID token. Returns the verified identity (uid plus
 * coarse profile attrs). Throws (fail closed) on any problem.
 */
export async function verifyFirebaseIdToken(idToken, opts) {
    const { projectId } = opts;
    if (!projectId)
        throw new Error('firebase: projectId is required');
    if (typeof idToken !== 'string' || !idToken)
        throw new Error('firebase: idToken is required');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) {
        throw new Error('firebase: malformed token');
    }
    const [headB64, payB64, sigB64] = parts;
    const header = base64UrlDecodeToJson(headB64);
    if (header.alg !== 'RS256')
        throw new Error('firebase: unsupported token alg (expected RS256)');
    if (!header.kid)
        throw new Error('firebase: token missing kid');
    const certs = await getCerts(opts.fetchCerts ?? defaultFetchCerts);
    const pem = certs[header.kid];
    if (!pem)
        throw new Error('firebase: unknown signing key (kid not in Google certs)');
    const spki = spkiFromPemCert(pem);
    const key = await globalThis.crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = new TextEncoder().encode(`${headB64}.${payB64}`);
    const sigB64Padded = sigB64.replace(/-/g, '+').replace(/_/g, '/');
    const signature = base64ToBytes(sigB64Padded);
    const ok = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput);
    if (!ok)
        throw new Error('firebase: invalid token signature');
    const payload = base64UrlDecodeToJson(payB64);
    if (payload.aud !== projectId)
        throw new Error('firebase: token audience mismatch');
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
        throw new Error('firebase: token issuer mismatch');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('firebase: token missing subject');
    }
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    const skew = 60;
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
        throw new Error('firebase: token expired');
    }
    if (typeof payload.iat !== 'number' || payload.iat > now + skew) {
        throw new Error('firebase: token issued in the future');
    }
    if (typeof payload.auth_time !== 'number' || payload.auth_time > now + skew) {
        throw new Error('firebase: token has invalid auth_time');
    }
    const out = { uid: payload.sub };
    if (typeof payload.email === 'string' && payload.email)
        out.email = payload.email;
    if (typeof payload.name === 'string' && payload.name)
        out.name = payload.name;
    if (typeof payload.picture === 'string' && payload.picture)
        out.picture = payload.picture;
    return out;
}
