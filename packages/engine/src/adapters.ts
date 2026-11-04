/**
 * Adapter registry: maps file extensions / format names to storage adapters.
 *
 * The engine never assumes which adapter backs the view; hosts resolve the
 * right adapter through this registry by file extension or explicit format.
 * Adapters register themselves (or the host registers them); the registry
 * itself has no dependency on any concrete adapter package, so the engine
 * core stays free of storage imports.
 */
import type { StorageAdapter } from './storage.js';

export interface AdapterRegistration {
  adapter: StorageAdapter;
  /** File extensions handled, without the dot, lowercase (e.g. 'xlsx'). */
  extensions: string[];
  /** MIME types handled (e.g. 'application/vnd...'). */
  mimeTypes?: string[];
}

class AdapterRegistry {
  private byExtension = new Map<string, StorageAdapter>();
  private byName = new Map<string, StorageAdapter>();

  register(reg: AdapterRegistration): void {
    const name = reg.adapter.name.toLowerCase();
    if (this.byName.has(name)) {
      throw new Error(`AdapterRegistry: adapter "${name}" already registered`);
    }
    this.byName.set(name, reg.adapter);
    for (const ext of reg.extensions) {
      const key = ext.toLowerCase().replace(/^\./, '');
      // First registration wins for an extension; hosts can override via
      // unregister + register.
      if (!this.byExtension.has(key)) this.byExtension.set(key, reg.adapter);
    }
  }

  unregister(name: string): boolean {
    const adapter = this.byName.get(name.toLowerCase());
    if (!adapter) return false;
    this.byName.delete(name.toLowerCase());
    for (const [ext, a] of this.byExtension) {
      if (a === adapter) this.byExtension.delete(ext);
    }
    return true;
  }

  /** Resolve by file extension ('xlsx', '.csv', ...). */
  forExtension(ext: string): StorageAdapter | undefined {
    return this.byExtension.get(ext.toLowerCase().replace(/^\./, ''));
  }

  /** Resolve by adapter name ('xlsx', 'csv', 'ods', ...). */
  forName(name: string): StorageAdapter | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** Resolve by filename (uses the part after the last dot). */
  forFilename(filename: string): StorageAdapter | undefined {
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return undefined;
    return this.forExtension(filename.slice(dot + 1));
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  clear(): void {
    this.byExtension.clear();
    this.byName.clear();
  }
}

/** Process-wide default registry. Hosts may create their own. */
export const defaultAdapters = new AdapterRegistry();

export { AdapterRegistry };
export type { AdapterRegistration as AdapterReg };
