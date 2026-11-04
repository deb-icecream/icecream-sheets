/**
 * Permissions: every mutation path goes through authorize(), including
 * automation scripts, add-ons and the AI Agent. Grants are recorded.
 *
 * v1 ships a default-allow policy for the single-user desktop; the
 * enforcement point and audit trail are what matter for later policies.
 */

export interface AuthContext {
  /** Who is acting: 'user', 'automation:<name>', 'ai-agent', 'mcp:<client>' ... */
  principal: string;
  /** Optional pre-existing grants (e.g. capability tokens). */
  grants?: string[];
}

export interface GrantRecord {
  principal: string;
  action: string;
  target: string;
  allowed: boolean;
  at: string;
}

export type Policy = (action: string, target: string, ctx: AuthContext) => boolean;

/** Default v1 policy: allow everything, but record the decision. */
export function allowAllPolicy(): Policy {
  return () => true;
}

export class Authorizer {
  private policy: Policy;
  private log: GrantRecord[] = [];

  constructor(policy: Policy = allowAllPolicy()) {
    this.policy = policy;
  }

  /**
   * Replace the policy (e.g. to compose protectionPolicy around the access
   * policy when protection state changes). The audit log is preserved.
   */
  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  /**
   * Authorize an action. Returns true when allowed. Every call is recorded.
   * Throws when the principal is missing (fail closed on identity).
   */
  authorize(action: string, target: string, ctx: AuthContext): boolean {
    if (!ctx || typeof ctx.principal !== 'string' || ctx.principal.length === 0) {
      throw new Error('authorize: missing principal (fail closed)');
    }
    const allowed = this.policy(action, target, ctx);
    this.log.push({
      principal: ctx.principal,
      action,
      target,
      allowed,
      at: new Date().toISOString(),
    });
    return allowed;
  }

  auditLog(): GrantRecord[] {
    return [...this.log];
  }

  clearLog(): void {
    this.log = [];
  }
}
