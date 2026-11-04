/**
 * Minimal types for @babel/standalone (7.25.3). The package ships no
 * TypeScript declarations (UMD bundle only), so the web app declares the
 * slice of the API it uses. Keep in sync with the transform call in
 * components/hostJsx.ts.
 */
declare module '@babel/standalone' {
  export interface BabelTransformResult {
    code: string;
  }
  export interface BabelStandaloneApi {
    transform(
      code: string,
      options: {
        presets?: unknown[];
        plugins?: unknown[];
        configFile?: string | false;
        babelrc?: boolean;
        filename?: string;
        compact?: boolean;
        ast?: boolean;
        sourceMaps?: boolean | 'both' | 'inline';
      },
    ): BabelTransformResult;
  }
  const Babel: BabelStandaloneApi;
  export default Babel;
}
