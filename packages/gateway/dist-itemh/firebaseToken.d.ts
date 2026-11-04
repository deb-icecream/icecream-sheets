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
export interface VerifiedFirebaseToken {
    /** Firebase uid (`sub`). */
    uid: string;
    email?: string;
    name?: string;
    picture?: string;
}
export interface VerifyFirebaseOptions {
    /** The gateway's Firebase project id (FIREBASE_PROJECT_ID). */
    projectId: string;
    /** For tests: unix seconds to verify against (defaults to now). */
    nowSeconds?: number;
    /**
     * For tests: override the cert fetch. Must resolve to
     * { certs: Record<kid, pemCert>, maxAgeSeconds }.
     */
    fetchCerts?: () => Promise<{
        certs: Record<string, string>;
        maxAgeSeconds: number;
    }>;
}
/** Clear the in-memory cert cache (tests). */
export declare function clearFirebaseCertCache(): void;
/**
 * Extract the SubjectPublicKeyInfo DER from a PEM X.509 certificate by
 * locating the rsaEncryption OID and reading the BIT STRING that follows
 * it (AlgorithmIdentifier ::= SEQUENCE { OID, NULL }).
 */
export declare function spkiFromPemCert(pem: string): Uint8Array;
/**
 * Verify a Firebase ID token. Returns the verified identity (uid plus
 * coarse profile attrs). Throws (fail closed) on any problem.
 */
export declare function verifyFirebaseIdToken(idToken: string, opts: VerifyFirebaseOptions): Promise<VerifiedFirebaseToken>;
