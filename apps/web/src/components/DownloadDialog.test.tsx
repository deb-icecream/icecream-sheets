// @vitest-environment jsdom
/**
 * Download dialog — defined-names rendering (Item H / audit D3).
 *
 * The dialog itself was never broken: given the workbook's real names
 * it lists them. The defect was its SOURCE (the service name store was
 * never populated on open — see features/nameServices.test.ts). These
 * tests pin the dialog side of the contract so the two halves cannot
 * drift apart again: with names supplied there is NO "No defined
 * names" claim and the names are selectable for a named-range
 * download; with an empty list the claim (and the disabled radio) is
 * the honest state.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DownloadDialog, type DownloadNameOption } from './DownloadDialog';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render(names: DownloadNameOption[], onDownload = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      h(DownloadDialog, { names, formatExt: 'xlsx', onDownload, onClose: () => undefined }),
    );
  });
  return { onDownload };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const NAMES: DownloadNameOption[] = [
  { id: 'nr1', name: 'Tax_Rate', scopeLabel: 'Workbook', refLabel: 'Inputs!$B$14', dangling: false },
  { id: 'nr2', name: 'Accounts_Payable', scopeLabel: 'Workbook', refLabel: 'Inputs!$B$7', dangling: false },
  { id: 'nr3', name: 'Exact', scopeLabel: 'Workbook', refLabel: '#REF!', dangling: true },
];

describe('DownloadDialog defined names (Item H)', () => {
  it('with a names-rich workbook there is no "No defined names" claim and names are listed', () => {
    render(NAMES);
    const text = container!.textContent ?? '';
    expect(text).not.toContain('No defined names in this workbook yet');
    expect(text).toContain('Tax_Rate');
    expect(text).toContain('Accounts_Payable');
    const options = [...container!.querySelectorAll('option')];
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Tax_Rate'),
      expect.stringContaining('Accounts_Payable'),
      expect.stringContaining('Exact'),
    ]);
    expect(options[2]!.textContent).toContain('(#REF!, unavailable)');
    // Dangling names are listed but not selectable.
    expect((options[2] as HTMLOptionElement).disabled).toBe(true);
  });

  it('a named-range download fires with the chosen name id', () => {
    const { onDownload } = render(NAMES);
    const radios = [...container!.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
    act(() => {
      radios[1]!.click();
    });
    const btn = [...container!.querySelectorAll('button')].find((b) => b.textContent === 'Download')!;
    act(() => {
      btn.click();
    });
    expect(onDownload).toHaveBeenCalledWith({ kind: 'namedRange', nameId: 'nr1' });
  });

  it('with no names the empty claim is shown and the named-range scope is disabled', () => {
    render([]);
    const text = container!.textContent ?? '';
    expect(text).toContain('No defined names in this workbook yet');
    const radios = [...container!.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
    expect(radios[1]!.disabled).toBe(true);
  });
});
